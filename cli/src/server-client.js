// ─────────────────────────────────────────────────────────────
//  Server Client — HTTP + NDJSON stream reader
//
//  Communicates with the Next.js server's /api/agent endpoints.
//  Parses the NDJSON stream line-by-line and dispatches events
//  to callbacks.
// ─────────────────────────────────────────────────────────────

/**
 * Process an NDJSON response stream, dispatching events to callbacks.
 *
 * Returns a resolved result:
 *   { type: "response", text, sessionId }
 *   { type: "confirmation_required", tool, sessionId }
 *
 * Throws on stream errors or HTTP failures.
 */
async function processStream(response, callbacks) {
  const decoder = new TextDecoder();
  let buffer = "";
  let sessionId = null;

  const reader = response.body.getReader();

  while (true) {
    const { done, value } = await reader.read();

    if (done) {
      // Flush any bytes held by the streaming decoder
      const remaining = decoder.decode();
      if (remaining) buffer += remaining;
      break;
    }

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    // Keep the last (possibly incomplete) chunk in the buffer
    buffer = lines.pop() || "";

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;

      let event;
      try {
        event = JSON.parse(trimmed);
      } catch {
        if (process.env.DEBUG) {
          process.stderr.write(`[debug] skipped non-JSON line: ${trimmed}\n`);
        }
        continue;
      }

      switch (event.type) {
        case "session":
          sessionId = event.sessionId;
          break;

        case "thinking":
          if (callbacks.onThinking) callbacks.onThinking();
          break;

        case "tool_call":
          if (callbacks.onToolCall) callbacks.onToolCall(event.tool, event.input);
          break;

        case "confirmation_required":
          return { type: "confirmation_required", tool: event.tool, sessionId };

        case "response":
          return { type: "response", text: event.text, sessionId };

        case "error": {
          const err = new Error(event.message || "Server error");
          err.code = event.code || null;
          throw err;
        }
      }
    }
  }

  // Stream ended without a terminal event — treat as an error
  throw new Error("Server stream ended without a response");
}

/**
 * Send a message to the agent and stream the response.
 */
export async function streamMessage(serverUrl, authHeader, sessionId, message, callbacks) {
  const body = { message };
  if (sessionId) body.sessionId = sessionId;

  const res = await fetch(`${serverUrl}/api/agent`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: authHeader,
    },
    body: JSON.stringify(body),
  });

  if (res.status === 401) {
    throw new Error("Unauthorized — check your API key or run: node src/index.js auth login");
  }
  if (res.status === 429) {
    throw new Error("Rate limit exceeded — session message limit reached");
  }
  if (!res.ok) {
    const raw = await res.text().catch(() => "");
    const summary = raw.slice(0, 120);
    throw new Error(`Server error (${res.status})${summary ? `: ${summary}` : ""}`);
  }

  return processStream(res, callbacks);
}

/**
 * Confirm or cancel a pending destructive tool and stream the response.
 */
export async function streamConfirm(serverUrl, authHeader, sessionId, toolId, confirmed, callbacks) {
  const res = await fetch(`${serverUrl}/api/agent/confirm`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: authHeader,
    },
    body: JSON.stringify({ sessionId, toolId, confirmed }),
  });

  if (res.status === 401) {
    throw new Error("Unauthorized — check your API key or run: node src/index.js auth login");
  }
  if (res.status === 403) {
    throw new Error("Forbidden — your role does not permit this action");
  }
  if (!res.ok) {
    const raw = await res.text().catch(() => "");
    const summary = raw.slice(0, 120);
    throw new Error(`Server error (${res.status})${summary ? `: ${summary}` : ""}`);
  }

  return processStream(res, callbacks);
}
