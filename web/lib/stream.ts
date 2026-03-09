import { sessionStore } from "./session-factory";
import { logger, hashPii } from "./logger";
import type { AgentEvent, AgentLoopResult, Message, Session } from "./types";

const encoder = new TextEncoder();

const MAX_TITLE_LENGTH = 200;

// Strip control characters (C0/C1) except common whitespace
const CONTROL_CHAR_RE = /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F-\x9F]/g;

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

function extractAutoTitle(messages: Message[]): string | undefined {
  const firstUser = messages.find((m) => m.role === "user");
  if (!firstUser) return undefined;

  let text: string;
  if (typeof firstUser.content === "string") {
    text = firstUser.content;
  } else if (Array.isArray(firstUser.content)) {
    text = firstUser.content
      .filter((b): b is { type: "text"; text: string } => b.type === "text")
      .map((b) => b.text)
      .join(" ");
  } else {
    return undefined;
  }

  text = text.replace(CONTROL_CHAR_RE, "").trim();
  if (!text) return undefined;
  if (text.length <= MAX_TITLE_LENGTH) return text;
  return text.slice(0, MAX_TITLE_LENGTH) + "...";
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
    await writer.write(encodeNDJSON({ type: "response", text: result.text }));
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
}
