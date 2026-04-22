import type Anthropic from "@anthropic-ai/sdk";
import { NextRequest } from "next/server";
import { sessionStore } from "@/lib/session-factory";
import { runAgentLoop } from "@/lib/agent";
import { createNDJSONStream, encodeNDJSON, writeAgentResult } from "@/lib/stream";
import { resolveAuth } from "@/lib/auth-helpers";
import { scanUserInput, shouldBlock } from "@/lib/injection-guard";
import { getSkill } from "@/lib/skill-store";
import { logger, hashPii, setLogContext } from "@/lib/logger";
import { isChannel, MAX_FILES_PER_MESSAGE, CsvAttachmentCapError } from "@/lib/types";
import type { AgentRequest, ModelPreference, TokenUsage, LogIdentityContext, FileAttachment, CSVReference } from "@/lib/types";
import { DEFAULT_MODEL, SUPPORTED_MODELS } from "@/lib/config";
import { checkBudget, createReservation, deleteReservation, recordUsage } from "@/lib/usage-tracker";
import { isMultipartRequest, parseMultipart } from "@/lib/multipart-parser";
import { buildContentBlocks, buildMediaBlocks, buildPersistedContent } from "@/lib/content-blocks";
import { buildInlineCsvBlock, buildReferenceCsvBlock, composeUserContent } from "@/lib/csv-content-blocks";
import { uploadFile, isUploadStorageConfigured, uploadCsv, deleteCsvBlob } from "@/lib/upload-storage";
import { isCsvType, isTxtType } from "@/lib/file-validation";
import { buildTxtBlock } from "@/lib/txt-content-blocks";
import { classifyCsv } from "@/lib/csv-classifier";
import { appendCsvAttachment, getCsvAttachments } from "@/lib/conversation-store";
import { withStoreModeFromRequest } from "@/lib/conversation-store-mode";
import type { ResolvedAuth } from "@/lib/auth-helpers";
import { randomUUID } from "crypto";

const SUPPORTED_MODEL_IDS = new Set(Object.values(SUPPORTED_MODELS));

export async function POST(request: NextRequest) {
  const identity = await resolveAuth(request);
  if (!identity) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), {
      status: 401,
      headers: { "Content-Type": "application/json" },
    });
  }
  // Admin-gated X-Neo-Store-Mode header scopes a per-request store-
  // mode override. Non-admin callers passing the header are silently
  // ignored. See lib/conversation-store-mode.ts.
  return withStoreModeFromRequest(request, identity, () =>
    handleAgentPost(request, identity),
  );
}

async function handleAgentPost(request: NextRequest, identity: ResolvedAuth): Promise<Response> {

  // Parse request — JSON or multipart/form-data (when files are attached)
  let body: AgentRequest;
  let attachedFiles: FileAttachment[] = [];

  if (isMultipartRequest(request)) {
    try {
      const { fields, files } = await parseMultipart(request);
      body = {
        message: fields.message ?? "",
        sessionId: fields.sessionId,
        channel: fields.channel as AgentRequest["channel"],
        model: fields.model,
      };
      attachedFiles = files;
    } catch (err) {
      return new Response(
        JSON.stringify({ error: (err as Error).message || "Failed to parse file upload" }),
        { status: 400 },
      );
    }

  } else {
    try {
      body = await request.json();
    } catch {
      return new Response(JSON.stringify({ error: "Invalid JSON" }), { status: 400 });
    }
  }

  if (!body.message || typeof body.message !== "string") {
    return new Response(JSON.stringify({ error: "Missing 'message' field" }), { status: 400 });
  }

  const MAX_MESSAGE_LENGTH = 4_000;
  if (body.message.length > MAX_MESSAGE_LENGTH) {
    return new Response(
      JSON.stringify({ error: `Message too long (max ${MAX_MESSAGE_LENGTH} chars)` }),
      { status: 400 }
    );
  }

  // Slash command detection — resolve skill before injection scan so the
  // scanner sees the fully-expanded message with skill instructions.
  let resolvedSkill: { id: string; name: string } | null = null;
  let effectiveMessage = body.message;
  if (body.message.startsWith("/")) {
    const parts = body.message.split(/\s+/);
    const skillId = parts[0].slice(1); // strip leading /
    const userArgs = parts.slice(1).join(" ");

    if (skillId) {
      const skill = getSkill(skillId);
      if (skill) {
        if (skill.requiredRole === "admin" && identity.role !== "admin") {
          return new Response(
            JSON.stringify({ error: "This skill requires admin access." }),
            { status: 403 }
          );
        }
        resolvedSkill = { id: skill.id, name: skill.name };
        effectiveMessage = `[SKILL INVOCATION: ${skill.name}]\n\nFollow these steps precisely:\n\n${skill.instructions}\n\n---\n\nUser input: ${userArgs || "(no additional input)"}`;
        logger.info("Skill invoked via slash command", "agent", {
          skillId: skill.id,
          skillName: skill.name,
          userId: identity.name,
        });
      }
      // If skill not found, pass message through as-is
    }
  }

  // Injection scan — runs on the fully-expanded message (including skill
  // instructions if a slash command was resolved) so injections embedded
  // in user args or skill content are detected.
  const scanResult = scanUserInput(effectiveMessage, {
    sessionId: body.sessionId ?? "new",
    userId: identity.name,
    role: identity.role,
  });

  if (shouldBlock(scanResult)) {
    return new Response(
      JSON.stringify({ error: "Request could not be processed." }),
      { status: 400 }
    );
  }

  // Resolve or create session
  let sessionId: string;
  if (body.sessionId) {
    // Try active session first, then fall back to idle-expired sessions
    // (conversations persisted in Cosmos survive beyond the 30-min idle timeout)
    const existing = await sessionStore.get(body.sessionId)
      ?? await sessionStore.getExpired(body.sessionId);
    if (!existing) {
      return new Response(JSON.stringify({ error: "Session not found" }), { status: 404 });
    }
    // Only the session owner (or an admin) may continue an existing session.
    // existing.role governs tool access for this session's lifetime;
    // identity.role is intentionally not used here.
    if (existing.ownerId !== identity.ownerId && identity.role !== "admin") {
      return new Response(JSON.stringify({ error: "Forbidden" }), {
        status: 403,
        headers: { "Content-Type": "application/json" },
      });
    }
    sessionId = body.sessionId;
  } else {
    const channel = isChannel(body.channel) ? body.channel : "web";
    sessionId = await sessionStore.create(identity.role, identity.ownerId, channel);
  }

  const session = (await sessionStore.get(sessionId) ?? await sessionStore.getExpired(sessionId))!;

  // Resolve model preference: request body → default
  const model: ModelPreference =
    body.model && SUPPORTED_MODEL_IDS.has(body.model)
      ? body.model
      : DEFAULT_MODEL;

  // Set up logging context for the rest of this request
  const channel = isChannel(body.channel) ? body.channel : "web";
  const logIdentity: LogIdentityContext = {
    userName: identity.name,
    userIdHash: hashPii(identity.ownerId),
    role: identity.role,
    provider: identity.provider,
    channel,
    sessionId,
  };

  return setLogContext(logIdentity, () => {
    logger.info("Agent request", "api/agent", { sessionId, role: session.role, provider: identity.provider });
    logger.emitEvent("session_started", "Session started", "api/agent", { sessionId, conversationId: sessionId });

    return handleAgentRequest(identity, session, sessionId, body, effectiveMessage, resolvedSkill, model, logIdentity, attachedFiles, request.signal);
  });
}

async function handleAgentRequest(
  identity: { ownerId: string; role: string; name: string; provider: "entra-id" | "api-key" | "service-principal" },
  session: Awaited<ReturnType<typeof sessionStore.get>> & object,
  sessionId: string,
  body: AgentRequest,
  effectiveMessage: string,
  resolvedSkill: { id: string; name: string } | null,
  model: ModelPreference,
  logIdentity: LogIdentityContext,
  attachedFiles: FileAttachment[] = [],
  signal?: AbortSignal,
): Promise<Response> {
  // Rate limit check
  if (await sessionStore.isRateLimited(sessionId)) {
    logger.warn("Rate limit exceeded", "api/agent", { sessionId });
    return new Response(
      JSON.stringify({ error: "Session message limit exceeded" }),
      { status: 429 }
    );
  }

  // Token budget check
  const budget = await checkBudget(identity.ownerId);
  if (!budget.allowed) {
    const windowLabel = budget.exceededWindow === "two-hour" ? "2-hour" : "weekly";
    const exceededUsage = budget.exceededWindow === "two-hour" ? budget.twoHourUsage : budget.weeklyUsage;
    const exceededRemaining = budget.exceededWindow === "two-hour" ? budget.twoHourRemaining : budget.weekRemaining;
    const budgetLimit = exceededUsage.totalInputTokens + exceededRemaining;
    const realPct = budgetLimit > 0 ? Math.round((exceededUsage.totalInputTokens / budgetLimit) * 100) : 100;
    logger.warn("Token budget exceeded", "api/agent", { sessionId, budgetWarning: windowLabel });
    logger.emitEvent("budget_alert", "Token budget exceeded", "api/agent", {
      windowType: windowLabel,
      budgetLimit,
      currentUsage: exceededUsage.totalInputTokens,
      percentUsed: realPct,
      action: "blocked",
    });
    return new Response(
      JSON.stringify({
        error: `Your ${windowLabel} token budget has been exceeded. Please wait for the window to reset.`,
      }),
      { status: 429 }
    );
  }

  // Pessimistic reservation
  const reservationId = await createReservation(identity.ownerId, sessionId, model);

  // Split attachments into media (image/PDF) and CSV paths. CSVs are
  // classified server-side and either inlined as text content blocks or
  // uploaded to blob storage as reference-mode attachments.
  const mediaFiles: FileAttachment[] = [];
  const csvFiles: FileAttachment[] = [];
  const txtFiles: FileAttachment[] = [];
  for (const file of attachedFiles) {
    if (isCsvType(file.mimetype, file.filename)) {
      csvFiles.push(file);
    } else if (isTxtType(file.mimetype, file.filename)) {
      txtFiles.push(file);
    } else {
      mediaFiles.push(file);
    }
  }

  // Build content blocks for Claude API (base64 for media, inline text for
  // small CSVs, reference blocks for large CSVs) and for persistence (blob
  // URLs).
  let claudeContent: Anthropic.Messages.MessageParam["content"];
  let persistedContent: string;
  const newCsvAttachments: CSVReference[] = [];
  const csvBlocks: Anthropic.Messages.TextBlockParam[] = [];
  const txtBlocks: Anthropic.Messages.TextBlockParam[] = [];

  // Process CSVs before media: classification / 10-cap rejection short-circuits
  // the request before any media is base64-encoded or persisted. Note that for
  // reference-mode CSVs the blob upload itself still precedes the Cosmos cap
  // check inside appendCsvAttachment — that race is handled by deleteCsvBlob
  // on the cap-error path so orphaned blobs don't accumulate.
  for (const file of csvFiles) {
    let classified;
    try {
      classified = classifyCsv(file.buffer);
    } catch (err) {
      return new Response(
        JSON.stringify({ error: `CSV "${file.filename}" could not be processed: ${(err as Error).message}` }),
        { status: 400, headers: { "Content-Type": "application/json" } },
      );
    }

    if (classified.mode === "inline") {
      csvBlocks.push(buildInlineCsvBlock(file.filename, classified));
      continue;
    }

    // Reference mode — upload to CSV blob storage, append to conversation.
    const csvId = randomUUID();
    let blobUrl: string;
    try {
      blobUrl = await uploadCsv(sessionId, csvId, file.filename, classified.normalizedBuffer);
    } catch (err) {
      logger.warn("Failed to upload CSV to blob storage", "api/agent", {
        sessionId,
        filename: file.filename,
        errorMessage: (err as Error).message,
      });
      return new Response(
        JSON.stringify({ error: "CSV upload storage is not available. Please try again later." }),
        { status: 503, headers: { "Content-Type": "application/json" } },
      );
    }

    const reference: CSVReference = {
      csvId,
      filename: file.filename,
      blobUrl,
      rowCount: classified.rowCount,
      columns: classified.columns,
      sampleRows: classified.previewRows,
      createdAt: new Date().toISOString(),
    };

    try {
      await appendCsvAttachment(sessionId, identity.ownerId, reference);
    } catch (err) {
      // Best-effort cleanup: the blob was uploaded before the Cosmos write,
      // so any failure here leaves an orphan. Delete it so storage doesn't
      // accumulate costs for attachments that are never visible to the user.
      void deleteCsvBlob(blobUrl);
      if (err instanceof CsvAttachmentCapError) {
        return new Response(
          JSON.stringify({ error: err.message }),
          { status: 409, headers: { "Content-Type": "application/json" } },
        );
      }
      logger.warn("Failed to persist CSV attachment", "api/agent", {
        sessionId,
        csvId,
        errorMessage: (err as Error).message,
      });
      return new Response(
        JSON.stringify({ error: "Failed to register CSV attachment. Please try again." }),
        { status: 500, headers: { "Content-Type": "application/json" } },
      );
    }

    newCsvAttachments.push(reference);
    csvBlocks.push(buildReferenceCsvBlock(reference));
  }

  // Process TXT files — always inline, no blob storage
  for (const file of txtFiles) {
    try {
      txtBlocks.push(buildTxtBlock(file.filename, file.buffer));
    } catch (err) {
      return new Response(
        JSON.stringify({ error: `Text file "${file.filename}" could not be processed: ${(err as Error).message}` }),
        { status: 400, headers: { "Content-Type": "application/json" } },
      );
    }
  }

  if (mediaFiles.length > 0 || csvBlocks.length > 0 || txtBlocks.length > 0) {
    // When CSVs or TXT files are present we use composeUserContent to
    // enforce the ordering: media → TXT → CSV → user text. When only
    // media is present, the existing buildContentBlocks helper keeps the
    // historical text → media ordering so image/PDF-only flows are unchanged.
    if (csvBlocks.length > 0 || txtBlocks.length > 0) {
      const mediaBlocks = buildMediaBlocks(mediaFiles);
      claudeContent = composeUserContent(effectiveMessage, mediaBlocks, csvBlocks, txtBlocks);
    } else {
      claudeContent = buildContentBlocks(effectiveMessage, mediaFiles);
    }

    // Upload media files to blob storage for persistence. CSV uploads are
    // handled separately above.
    const fileRefs: { filename: string; mimetype: string; blobUrl: string }[] = [];
    if (mediaFiles.length > 0 && isUploadStorageConfigured()) {
      for (const file of mediaFiles) {
        try {
          const blobUrl = await uploadFile(file.filename, file.buffer, file.mimetype);
          fileRefs.push({ filename: file.filename, mimetype: file.mimetype, blobUrl });
        } catch (err) {
          logger.warn("Failed to upload file to blob storage", "api/agent", {
            sessionId,
            filename: file.filename,
            errorMessage: (err as Error).message,
          });
        }
      }
    }
    // Reference-mode CSVs appear as file refs in the persisted message too.
    for (const ref of newCsvAttachments) {
      fileRefs.push({ filename: ref.filename, mimetype: "text/csv", blobUrl: ref.blobUrl });
    }
    // TXT files are inline-only (embedded in the Claude content blocks above).
    // No blob URL to persist — the [Attached: ...] line is added below for display.
    for (const file of txtFiles) {
      fileRefs.push({ filename: file.filename, mimetype: "text/plain", blobUrl: "inline" });
    }
    persistedContent = buildPersistedContent(effectiveMessage, fileRefs);
  } else {
    claudeContent = effectiveMessage;
    persistedContent = effectiveMessage;
  }

  // Add user message to session (persisted form for Cosmos DB)
  session.messages.push({ role: "user", content: persistedContent });
  session.messageCount++;

  // Persist user message immediately
  try {
    await sessionStore.saveMessages(sessionId, session.messages);
  } catch (err) {
    logger.warn("Failed to persist message on receipt", "api/agent", {
      sessionId,
      errorMessage: (err as Error).message,
    });
  }

  const { readable, writer } = createNDJSONStream();

  // Kick off agent loop asynchronously
  (async () => {
    // Run the entire async body within the logging context
    await setLogContext(logIdentity, async () => {
      try {
        await writer.write(encodeNDJSON({ type: "session", sessionId }));

        // Emit skill invocation event if a slash command was resolved
        if (resolvedSkill) {
          logger.emitEvent("skill_invocation", `Skill invoked: ${resolvedSkill.name}`, "agent", {
            skillId: resolvedSkill.id,
            skillName: resolvedSkill.name,
          });
          void writer.write(encodeNDJSON({
            type: "skill_invocation",
            skill: resolvedSkill,
          })).catch(() => {});
        }

        // Stream budget warning if approaching limits
        if (budget.warning) {
          // Budget warning is already emitted with real percentages in usage-tracker.ts
          // Just stream the client-facing warning here
          void writer.write(encodeNDJSON({
            type: "warning",
            message: "You are approaching your token usage limit.",
            code: "BUDGET_WARNING",
          })).catch(() => {});
        }

        // Accumulate usage across all turns
        const accumulatedUsage: TokenUsage[] = [];

        // Build API messages — use base64 content blocks for the current turn if files attached
        const apiMessages = [...session.messages];
        if (attachedFiles.length > 0 && apiMessages.length > 0) {
          const lastMsg = apiMessages[apiMessages.length - 1];
          if (lastMsg.role === "user") {
            apiMessages[apiMessages.length - 1] = { role: "user", content: claudeContent };
          }
        }

        // Load reference-mode CSV attachments owned by this conversation.
        // Newly uploaded references have been persisted above; this query
        // returns them plus any from prior turns. Used for conditional
        // tool registration and executor context scoping.
        let conversationCsvAttachments: CSVReference[] = [];
        try {
          conversationCsvAttachments = await getCsvAttachments(sessionId, identity.ownerId);
        } catch (err) {
          logger.warn("Failed to load CSV attachments", "api/agent", {
            sessionId,
            errorMessage: (err as Error).message,
          });
        }

        const result = await runAgentLoop(
          apiMessages,
          {
            onThinking: () => {
              void writer.write(encodeNDJSON({ type: "thinking" })).catch(() => {});
            },
            onToolCall: (name, input) => {
              void writer.write(encodeNDJSON({ type: "tool_call", tool: name, input })).catch(() => {});
            },
            onToolResult: (trace) => {
              void writer
                .write(
                  encodeNDJSON({
                    type: "tool_result",
                    tool: trace.name,
                    input: trace.input,
                    output: trace.output,
                    durationMs: trace.durationMs ?? 0,
                    isError: trace.isError,
                  }),
                )
                .catch(() => {});
            },
            onContextTrimmed: (originalTokens, newTokens, method) => {
              void writer.write(encodeNDJSON({ type: "context_trimmed", originalTokens, newTokens, method })).catch(() => {});
            },
            onUsage: (usage, usedModel) => {
              accumulatedUsage.push(usage);
              void writer.write(encodeNDJSON({ type: "usage", usage, model: usedModel })).catch(() => {});
            },
            onTurnComplete: (messages) => {
              session.messages = messages;
              void sessionStore.saveMessages(sessionId, messages).catch((saveErr) => {
                logger.warn("Failed to persist messages on turn complete", "api/agent", {
                  sessionId,
                  errorMessage: (saveErr as Error).message,
                });
              });
            },
          },
          session.role,
          sessionId,
          model,
          signal,
          {
            csvAttachments: conversationCsvAttachments,
            // Forward the already-resolved skill flag so the agent loop
            // picks MAX_TOKENS_SKILL without re-parsing the injected
            // `[SKILL INVOCATION: ...]` prefix.
            skillInvocation: resolvedSkill !== null,
          },
        );

        // Emit session_interrupted event if the loop was aborted
        if (result.type === "response" && result.interrupted) {
          logger.emitEvent("session_interrupted", "Agent run interrupted by user", "api/agent", {
            sessionId,
          });
        }

        await writeAgentResult(result, session, sessionId, writer);

        // Record actual usage (reservation cleanup happens in finally)
        for (const usage of accumulatedUsage) {
          void recordUsage(identity.ownerId, sessionId, model, usage);
        }
      } catch (err) {
        // Note: AbortError is caught inside runAgentLoop and returned as
        // { interrupted: true } — this catch block only handles real errors.

        // IncompleteToolUseError: the model ran out of output budget while
        // writing a tool_use block. There's no partial text to show and
        // the incomplete tool_use would corrupt the next turn, so we do
        // NOT persist the assistant turn — just surface a friendly error.
        if ((err as Error).name === "IncompleteToolUseError") {
          logger.warn("Agent loop truncated mid-tool-use", "api/agent", {
            sessionId,
            errorMessage: (err as Error).message,
          });
          await writer.write(
            encodeNDJSON({
              type: "error",
              message:
                "The agent couldn't finish planning the next step within the token budget. Try a more focused follow-up.",
              code: "INCOMPLETE_TOOL_USE",
            }),
          );
          return;
        }

        // Fire-and-forget: save whatever messages accumulated before the error
        void sessionStore.saveMessages(sessionId, session.messages).catch((saveErr) => {
          logger.warn("Failed to persist messages after agent loop error", "api/agent", {
            sessionId,
            errorMessage: (saveErr as Error).message,
          });
        });
        logger.error("Agent loop error", "api/agent", { sessionId, errorMessage: (err as Error).message });
        await writer.write(
          encodeNDJSON({ type: "error", message: "An error occurred processing your request.", code: "AGENT_ERROR" })
        );
      } finally {
        // Always release the pessimistic reservation, regardless of outcome
        if (reservationId) {
          void deleteReservation(reservationId, identity.ownerId);
        }
        await writer.close();
      }
    });
  })();

  return new Response(readable, {
    headers: {
      "Content-Type": "application/x-ndjson",
      "Cache-Control": "no-cache",
      "Transfer-Encoding": "chunked",
    },
  });
}
