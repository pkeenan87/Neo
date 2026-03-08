import { sessionStore } from "./session-factory";
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
    await writer.write(encodeNDJSON({ type: "response", text: result.text }));
  }
}
