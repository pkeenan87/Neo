import type Anthropic from "@anthropic-ai/sdk";
import { NextRequest } from "next/server";
import { sessionStore } from "@/lib/session-factory";
import { runAgentLoop } from "@/lib/agent";
import { createNDJSONStream, encodeNDJSON, writeAgentResult } from "@/lib/stream";
import { resolveAuth } from "@/lib/auth-helpers";
import { scanUserInput, shouldBlock } from "@/lib/injection-guard";
import { getSkill } from "@/lib/skill-store";
import { logger, hashPii, setLogContext } from "@/lib/logger";
import { isChannel, MAX_FILES_PER_MESSAGE } from "@/lib/types";
import type { AgentRequest, ModelPreference, TokenUsage, LogIdentityContext, FileAttachment } from "@/lib/types";
import { DEFAULT_MODEL, SUPPORTED_MODELS } from "@/lib/config";
import { checkBudget, createReservation, deleteReservation, recordUsage } from "@/lib/usage-tracker";
import { isMultipartRequest, parseMultipart } from "@/lib/multipart-parser";
import { buildContentBlocks, buildPersistedContent } from "@/lib/content-blocks";
import { uploadFile, isUploadStorageConfigured } from "@/lib/upload-storage";

const SUPPORTED_MODEL_IDS = new Set(Object.values(SUPPORTED_MODELS));

export async function POST(request: NextRequest) {
  const identity = await resolveAuth(request);
  if (!identity) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), {
      status: 401,
      headers: { "Content-Type": "application/json" },
    });
  }

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

    return handleAgentRequest(identity, session, sessionId, body, effectiveMessage, resolvedSkill, model, logIdentity, attachedFiles);
  });
}

async function handleAgentRequest(
  identity: { ownerId: string; role: string; name: string; provider: "entra-id" | "api-key" },
  session: Awaited<ReturnType<typeof sessionStore.get>> & object,
  sessionId: string,
  body: AgentRequest,
  effectiveMessage: string,
  resolvedSkill: { id: string; name: string } | null,
  model: ModelPreference,
  logIdentity: LogIdentityContext,
  attachedFiles: FileAttachment[] = [],
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

  // Build content blocks for Claude API (base64 for files) and for persistence (blob URLs)
  let claudeContent: Anthropic.Messages.MessageParam["content"];
  let persistedContent: string;

  if (attachedFiles.length > 0) {
    claudeContent = buildContentBlocks(effectiveMessage, attachedFiles);

    // Upload files to blob storage if configured, otherwise skip persistence of file refs
    const fileRefs: { filename: string; mimetype: string; blobUrl: string }[] = [];
    if (isUploadStorageConfigured()) {
      for (const file of attachedFiles) {
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

        const result = await runAgentLoop(
          apiMessages,
          {
            onThinking: () => {
              void writer.write(encodeNDJSON({ type: "thinking" })).catch(() => {});
            },
            onToolCall: (name, input) => {
              void writer.write(encodeNDJSON({ type: "tool_call", tool: name, input })).catch(() => {});
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
        );

        await writeAgentResult(result, session, sessionId, writer);

        // Settle: delete reservation and record actual usage
        if (reservationId) {
          void deleteReservation(reservationId, identity.ownerId);
        }
        for (const usage of accumulatedUsage) {
          void recordUsage(identity.ownerId, sessionId, model, usage);
        }
      } catch (err) {
        if (reservationId) {
          void deleteReservation(reservationId, identity.ownerId);
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
