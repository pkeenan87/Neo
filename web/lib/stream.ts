import { sessionStore } from "./session-factory";
import { logger, hashPii } from "./logger";
import { extractAutoTitle, generateAndSetTitle } from "./title-utils";
import type { AgentEvent, AgentLoopResult, Session } from "./types";

const encoder = new TextEncoder();

export function encodeNDJSON(event: AgentEvent): Uint8Array {
  return encoder.encode(JSON.stringify(event) + "\n");
}

export function createNDJSONStream(): {
  readable: ReadableStream<Uint8Array>;
  writer: WritableStreamDefaultWriter<Uint8Array>;
} {
  const transform = new TransformStream<Uint8Array, Uint8Array>();
  return {
    readable: transform.readable,
    writer: transform.writable.getWriter(),
  };
}

export async function writeAgentResult(
  result: AgentLoopResult,
  session: Session,
  sessionId: string,
  writer: WritableStreamDefaultWriter<Uint8Array>,
): Promise<void> {
  session.messages = result.messages;

  if (result.type === "confirmation_required") {
    await sessionStore.setPendingConfirmation(sessionId, result.tool);
    await writer.write(encodeNDJSON({ type: "confirmation_required", tool: result.tool }));
  } else {
    // interrupted + truncated are both piggybacked on the response event —
    // each is a flag, no separate event type. truncated is set when the
    // agent loop hit stop_reason: "max_tokens" and returned a partial.
    await writer.write(
      encodeNDJSON({
        type: "response",
        text: result.text,
        interrupted: result.interrupted,
        truncated: result.truncated,
      }),
    );
  }

  // Persist messages to the backing store (Cosmos DB or no-op for in-memory)
  try {
    const autoTitle = extractAutoTitle(result.messages);
    await sessionStore.saveMessages(sessionId, result.messages, autoTitle);
  } catch (err) {
    logger.error("Failed to persist messages", "stream", {
      sessionId: hashPii(sessionId),
      errorMessage: (err as Error).message,
    });
  }

  // Fire-and-forget: generate a richer Haiku title asynchronously
  if (result.type !== "confirmation_required") {
    void generateAndSetTitle(sessionId, result.messages);
  }
}
