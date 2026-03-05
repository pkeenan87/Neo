import { NextRequest } from "next/server";
import { sessionStore } from "@/lib/session-store";
import { runAgentLoop } from "@/lib/agent";
import { createNDJSONStream, encodeNDJSON, writeAgentResult } from "@/lib/stream";
import { resolveAuth } from "@/lib/auth-helpers";
import { scanUserInput, shouldBlock } from "@/lib/injection-guard";
import { logger } from "@/lib/logger";
import type { AgentRequest } from "@/lib/types";

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
    const existing = sessionStore.get(body.sessionId);
    if (!existing) {
      return new Response(JSON.stringify({ error: "Session not found" }), { status: 404 });
    }
    // Only the session owner (or an admin) may continue an existing session.
    // existing.role governs tool access for this session's lifetime;
    // identity.role is intentionally not used here.
    if (existing.ownerId !== identity.name && identity.role !== "admin") {
      return new Response(JSON.stringify({ error: "Forbidden" }), {
        status: 403,
        headers: { "Content-Type": "application/json" },
      });
    }
    sessionId = body.sessionId;
  } else {
    sessionId = sessionStore.create(identity.role, identity.name);
  }

  const session = sessionStore.get(sessionId)!;
  logger.info("Agent request", "api/agent", { sessionId, role: session.role, provider: identity.provider });

  // Rate limit check
  if (sessionStore.isRateLimited(sessionId)) {
    logger.warn("Rate limit exceeded", "api/agent", { sessionId });
    return new Response(
      JSON.stringify({ error: "Session message limit exceeded" }),
      { status: 429 }
    );
  }

  // Add user message to session
  session.messages.push({ role: "user", content: body.message });
  session.messageCount++;

  const { readable, writer } = createNDJSONStream();

  // Kick off agent loop asynchronously
  (async () => {
    try {
      await writer.write(encodeNDJSON({ type: "session", sessionId }));

      const result = await runAgentLoop(
        session.messages,
        {
          onThinking: () => {
            void writer.write(encodeNDJSON({ type: "thinking" })).catch(() => {});
          },
          onToolCall: (name, input) => {
            void writer.write(encodeNDJSON({ type: "tool_call", tool: name, input })).catch(() => {});
          },
        },
        session.role,
        sessionId
      );

      await writeAgentResult(result, session, sessionId, writer);
    } catch (err) {
      logger.error("Agent loop error", "api/agent", { sessionId, errorMessage: (err as Error).message });
      await writer.write(
        encodeNDJSON({ type: "error", message: (err as Error).message, code: "AGENT_ERROR" })
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
