import { NextRequest } from "next/server";
import { sessionStore } from "@/lib/session-store";
import { resumeAfterConfirmation } from "@/lib/agent";
import { createNDJSONStream, encodeNDJSON, writeAgentResult } from "@/lib/stream";
import type { ConfirmRequest } from "@/lib/types";

export async function POST(request: NextRequest) {
  let body: ConfirmRequest;
  try {
    body = await request.json();
  } catch {
    return new Response(JSON.stringify({ error: "Invalid JSON" }), { status: 400 });
  }

  if (!body.sessionId || !body.toolId || typeof body.confirmed !== "boolean") {
    return new Response(
      JSON.stringify({ error: "Missing 'sessionId', 'toolId', or 'confirmed' field" }),
      { status: 400 }
    );
  }

  const session = sessionStore.get(body.sessionId);
  if (!session) {
    return new Response(JSON.stringify({ error: "Session not found" }), { status: 404 });
  }

  const pendingTool = sessionStore.clearPendingConfirmation(body.sessionId);
  if (!pendingTool) {
    return new Response(
      JSON.stringify({ error: "No pending confirmation for this session" }),
      { status: 400 }
    );
  }

  if (pendingTool.id !== body.toolId) {
    sessionStore.setPendingConfirmation(body.sessionId, pendingTool);
    return new Response(
      JSON.stringify({ error: "Tool ID mismatch — confirmation rejected" }),
      { status: 409 }
    );
  }

  const { readable, writer } = createNDJSONStream();

  (async () => {
    try {
      const result = await resumeAfterConfirmation(
        session.messages,
        pendingTool,
        body.confirmed,
        {
          onThinking: () => {
            void writer.write(encodeNDJSON({ type: "thinking" })).catch(() => {});
          },
          onToolCall: (name, input) => {
            void writer.write(encodeNDJSON({ type: "tool_call", tool: name, input })).catch(() => {});
          },
        }
      );

      await writeAgentResult(result, session, body.sessionId, writer);
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
