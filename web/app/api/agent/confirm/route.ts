import { NextRequest } from "next/server";
import { sessionStore } from "@/lib/session-store";
import { resumeAfterConfirmation } from "@/lib/agent";
import { createNDJSONStream, encodeNDJSON, writeAgentResult } from "@/lib/stream";
import { resolveAuth } from "@/lib/auth-helpers";
import { canUseTool } from "@/lib/permissions";
import type { ConfirmRequest } from "@/lib/types";

export async function POST(request: NextRequest) {
  const identity = await resolveAuth(request);
  if (!identity) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), {
      status: 401,
      headers: { "Content-Type": "application/json" },
    });
  }

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

  // Only the session owner (or an admin) may confirm tools in a session
  if (session.ownerId !== identity.name && identity.role !== "admin") {
    return new Response(JSON.stringify({ error: "Forbidden" }), {
      status: 403,
      headers: { "Content-Type": "application/json" },
    });
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
      JSON.stringify({ error: "Tool ID mismatch: confirmation rejected" }),
      {
        status: 409,
        headers: { "Content-Type": "application/json" },
      }
    );
  }

  // Safety net: use session.role (the role the session was provisioned with)
  // rather than identity.role to prevent privilege confusion across users
  if (!canUseTool(session.role, pendingTool.name)) {
    sessionStore.setPendingConfirmation(body.sessionId, pendingTool);
    return new Response(JSON.stringify({ error: "Forbidden" }), {
      status: 403,
      headers: { "Content-Type": "application/json" },
    });
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
        },
        session.role
      );

      await writeAgentResult(result, session, body.sessionId, writer);
    } catch (err) {
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
