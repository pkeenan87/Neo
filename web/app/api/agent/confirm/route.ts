import { NextRequest } from "next/server";
import { sessionStore } from "@/lib/session-factory";
import { resumeAfterConfirmation } from "@/lib/agent";
import { getCsvAttachments } from "@/lib/conversation-store";
import { createNDJSONStream, encodeNDJSON, writeAgentResult } from "@/lib/stream";
import { resolveAuth, type ResolvedAuth } from "@/lib/auth-helpers";
import { canUseTool } from "@/lib/permissions";
import { logger, hashPii, setLogContext } from "@/lib/logger";
import { withStoreModeFromRequest } from "@/lib/conversation-store-mode";
import type { ConfirmRequest, LogIdentityContext, InProgressPlan } from "@/lib/types";

export async function POST(request: NextRequest) {
  const identity = await resolveAuth(request);
  if (!identity) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), {
      status: 401,
      headers: { "Content-Type": "application/json" },
    });
  }
  // Admin-gated X-Neo-Store-Mode header scopes a per-request override.
  // See lib/conversation-store-mode.ts.
  return withStoreModeFromRequest(request, identity, () =>
    handleConfirmPost(request, identity),
  );
}

async function handleConfirmPost(request: NextRequest, identity: ResolvedAuth): Promise<Response> {

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

  const session = await sessionStore.get(body.sessionId);
  if (!session) {
    return new Response(JSON.stringify({ error: "Session not found" }), { status: 404 });
  }

  // Only the session owner (or an admin) may confirm tools in a session
  if (session.ownerId !== identity.ownerId && identity.role !== "admin") {
    logger.warn("Confirm ownership mismatch", "api/confirm", { sessionId: body.sessionId });
    return new Response(JSON.stringify({ error: "Forbidden" }), {
      status: 403,
      headers: { "Content-Type": "application/json" },
    });
  }

  logger.info("Confirmation request", "api/confirm", {
    sessionId: body.sessionId,
    toolId: body.toolId,
    action: body.confirmed ? "confirm" : "cancel",
  });

  const pendingTool = await sessionStore.clearPendingConfirmation(body.sessionId);
  if (!pendingTool) {
    return new Response(
      JSON.stringify({ error: "No pending confirmation for this session" }),
      { status: 400 }
    );
  }

  if (pendingTool.id !== body.toolId) {
    logger.warn("Tool ID mismatch on confirmation", "api/confirm", { sessionId: body.sessionId, toolId: body.toolId });
    await sessionStore.setPendingConfirmation(body.sessionId, pendingTool);
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
    logger.warn("Permission denied for tool confirmation", "api/confirm", { sessionId: body.sessionId, toolName: pendingTool.name });
    await sessionStore.setPendingConfirmation(body.sessionId, pendingTool);
    return new Response(JSON.stringify({ error: "Forbidden" }), {
      status: 403,
      headers: { "Content-Type": "application/json" },
    });
  }

  const logIdentity: LogIdentityContext = {
    userName: identity.name,
    userIdHash: hashPii(identity.ownerId),
    role: identity.role,
    provider: identity.provider,
    channel: "web",
    sessionId: body.sessionId,
  };

  // Emit destructive action audit event inside logging context so identity envelope is attached
  const toolInput = pendingTool.input;
  setLogContext(logIdentity, () => {
    logger.emitEvent("destructive_action", `Destructive tool ${body.confirmed ? "confirmed" : "cancelled"}: ${pendingTool.name}`, "api/confirm", {
      toolName: pendingTool.name,
      confirmed: body.confirmed,
      justification: typeof toolInput.justification === "string" ? toolInput.justification : undefined,
      toolInput: JSON.stringify({
        ...(typeof toolInput.upn === "string" && { upn: hashPii(toolInput.upn) }),
        ...(typeof toolInput.hostname === "string" && { hostname: toolInput.hostname }),
        ...(typeof toolInput.computer_id === "string" && { computer_id: toolInput.computer_id }),
        ...(typeof toolInput.value === "string" && { value: "[redacted]" }),
        ...(typeof toolInput.case_id === "string" && { case_id: toolInput.case_id }),
        ...(typeof toolInput.approval_request_id === "string" && { approval_request_id: toolInput.approval_request_id }),
      }),
    });
  });

  const { readable, writer } = createNDJSONStream();

  (async () => {
    await setLogContext(logIdentity, async () => {
      try {
        const csvAttachments = await getCsvAttachments(body.sessionId, identity.ownerId).catch(() => []);
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
            onTurnComplete: (messages) => {
              session.messages = messages;
              void sessionStore.saveMessages(body.sessionId, messages).catch((saveErr) => {
                logger.warn("Failed to persist messages on turn complete", "api/confirm", {
                  sessionId: body.sessionId,
                  errorMessage: (saveErr as Error).message,
                });
              });
            },
          },
          session.role,
          body.sessionId,
          undefined,
          { csvAttachments },
        );

        await writeAgentResult(result, session, body.sessionId, writer);
      } catch (err) {
        // See app/api/agent/route.ts for the same handling — mid-tool-use
        // truncation is distinct from other agent errors because we must
        // NOT persist the partial assistant turn.
        if ((err as Error).name === "IncompleteToolUseError") {
          const errWithPlan = err as Error & { remainingPlan?: InProgressPlan | null };
          logger.warn("Agent loop truncated mid-tool-use (resume path)", "api/confirm", {
            sessionId: body.sessionId,
            errorMessage: (err as Error).message,
          });
          await writer.write(
            encodeNDJSON({
              type: "output_truncated",
              phase: "tool_use",
              message:
                "Neo's per-turn output budget was exhausted before it could finish planning the next step. " +
                "Type your next message and Neo will pick up from the remaining plan.",
              remainingPlan: errWithPlan.remainingPlan ?? null,
            }),
          );
          return;
        }

        void sessionStore.saveMessages(body.sessionId, session.messages).catch((saveErr) => {
          logger.warn("Failed to persist messages after confirm handler error", "api/confirm", {
            sessionId: body.sessionId,
            errorMessage: (saveErr as Error).message,
          });
        });
        logger.error("Confirmation handler error", "api/confirm", { sessionId: body.sessionId, errorMessage: (err as Error).message });
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
