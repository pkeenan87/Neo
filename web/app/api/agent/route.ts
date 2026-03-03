import { NextRequest } from "next/server";
import { sessionStore } from "@/lib/session-store";
import { runAgentLoop } from "@/lib/agent";
import { createNDJSONStream, encodeNDJSON, writeAgentResult } from "@/lib/stream";
import type { AgentRequest } from "@/lib/types";

export async function POST(request: NextRequest) {
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

  // Resolve or create session
  let sessionId: string;
  if (body.sessionId) {
    const session = sessionStore.get(body.sessionId);
    if (!session) {
      return new Response(JSON.stringify({ error: "Session not found" }), { status: 404 });
    }
    sessionId = body.sessionId;
  } else {
    sessionId = sessionStore.create();
  }

  const session = sessionStore.get(sessionId)!;

  // Rate limit check
  if (sessionStore.isRateLimited(sessionId)) {
    return new Response(
      JSON.stringify({ error: "Session message limit exceeded (100)" }),
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

      const result = await runAgentLoop(session.messages, {
        onThinking: () => {
          void writer.write(encodeNDJSON({ type: "thinking" })).catch(() => {});
        },
        onToolCall: (name, input) => {
          void writer.write(encodeNDJSON({ type: "tool_call", tool: name, input })).catch(() => {});
        },
      });

      await writeAgentResult(result, session, sessionId, writer);
    } catch (err) {
      await writer.write(encodeNDJSON({ type: "error", message: (err as Error).message }));
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
