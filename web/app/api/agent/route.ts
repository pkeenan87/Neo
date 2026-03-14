import { NextRequest } from "next/server";
import { sessionStore } from "@/lib/session-factory";
import { runAgentLoop } from "@/lib/agent";
import { createNDJSONStream, encodeNDJSON, writeAgentResult } from "@/lib/stream";
import { resolveAuth } from "@/lib/auth-helpers";
import { scanUserInput, shouldBlock } from "@/lib/injection-guard";
import { logger } from "@/lib/logger";
import { isChannel } from "@/lib/types";
import { DEFAULT_MODEL, SUPPORTED_MODELS } from "@/lib/config";
import { checkBudget, createReservation, deleteReservation, recordUsage } from "@/lib/usage-tracker";
import type { AgentRequest, ModelPreference, TokenUsage } from "@/lib/types";

const SUPPORTED_MODEL_IDS = new Set(Object.values(SUPPORTED_MODELS));

export async function POST(request: NextRequest) {
  const identity = await resolveAuth(request);
  if (!identity) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), {
      status: 401,
      headers: { "Content-Type": "application/json" },
    });
  }

  let body: AgentRequest;
  try {
    body = await request.json();
  } catch {
    return new Response(JSON.stringify({ error: "Invalid JSON" }), { status: 400 });
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

  // Injection scan — runs post-auth so identity context is available for audit log.
  // Runs before session creation so flagged requests never enter session history.
  const scanResult = scanUserInput(body.message, {
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
    const existing = await sessionStore.get(body.sessionId);
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

  const session = (await sessionStore.get(sessionId))!;
  logger.info("Agent request", "api/agent", { sessionId, role: session.role, provider: identity.provider });

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
    logger.warn("Token budget exceeded", "api/agent", { sessionId, budgetWarning: windowLabel });
    return new Response(
      JSON.stringify({
        error: `Your ${windowLabel} token budget has been exceeded. Please wait for the window to reset.`,
      }),
      { status: 429 }
    );
  }

  // Resolve model preference: request body → default
  const model: ModelPreference =
    body.model && SUPPORTED_MODEL_IDS.has(body.model)
      ? body.model
      : DEFAULT_MODEL;

  // Pessimistic reservation: write an estimated usage document before the
  // agent loop so concurrent requests from the same user see each other's
  // reservations in the budget check. The reservation is deleted and
  // replaced with actual usage after the loop completes.
  const reservationId = await createReservation(identity.ownerId, sessionId, model);

  // Add user message to session
  session.messages.push({ role: "user", content: body.message });
  session.messageCount++;

  // Persist user message immediately (before agent loop) so prompts
  // from web/CLI are written to the database on receipt.
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
    try {
      await writer.write(encodeNDJSON({ type: "session", sessionId }));

      // Stream budget warning if approaching limits
      if (budget.warning) {
        void writer.write(encodeNDJSON({
          type: "warning",
          message: "You are approaching your token usage limit.",
          code: "BUDGET_WARNING",
        })).catch(() => {});
      }

      // Accumulate usage across all turns in the agent loop
      const accumulatedUsage: TokenUsage[] = [];

      const result = await runAgentLoop(
        session.messages,
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
      // Clean up reservation on error
      if (reservationId) {
        void deleteReservation(reservationId, identity.ownerId);
      }
      logger.error("Agent loop error", "api/agent", { sessionId, errorMessage: (err as Error).message });
      await writer.write(
        encodeNDJSON({ type: "error", message: "An error occurred processing your request.", code: "AGENT_ERROR" })
      );
    } finally {
      await writer.close();
    }
  })();

  return new Response(readable, {
    headers: {
      "Content-Type": "application/x-ndjson",
      "Cache-Control": "no-cache",
      "Transfer-Encoding": "chunked",
    },
  });
}
