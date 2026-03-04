// ─────────────────────────────────────────────────────────────
//  Remote Agent Loop
//
//  Thin wrapper over server-client.js that provides the same
//  runAgentLoop / confirmTool interface the REPL expects.
// ─────────────────────────────────────────────────────────────

import { streamMessage, streamConfirm } from "./server-client.js";

/**
 * Send a user message to the server agent and return the result.
 *
 * Returns:
 *   { type: "response", text, sessionId }
 *   { type: "confirmation_required", tool, sessionId }
 */
export async function runAgentLoop(message, sessionId, callbacks, getAuthHeader, serverUrl) {
  return streamMessage(serverUrl, getAuthHeader, sessionId, message, callbacks);
}

/**
 * Confirm or cancel a pending destructive tool.
 *
 * Returns the same shape as runAgentLoop.
 */
export async function confirmTool(sessionId, tool, confirmed, callbacks, getAuthHeader, serverUrl) {
  return streamConfirm(serverUrl, getAuthHeader, sessionId, tool.id, confirmed, callbacks);
}
