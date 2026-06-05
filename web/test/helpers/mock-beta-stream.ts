// ─────────────────────────────────────────────────────────────
//  Test helper: synthesise a beta MessageStream from a Message.
//
//  Production switched every Anthropic call to the streaming API
//  (`client.beta.messages.create({ stream: true })` → iterate
//  events → aggregate). Tests still want to declare a complete
//  Message and have the agent loop return it; this helper bridges
//  the two by emitting a single message_start event whose
//  `.message` field is the entire pre-built Message, then a
//  message_stop. The accumulator in `agent.ts:aggregateBetaStream`
//  picks that up as the final value.
//
//  Each test file's existing
//    betaCreateMock.mockResolvedValue(message)
//  becomes
//    betaCreateMock.mockReturnValue(mockBetaStream(message))
//  — one-line edit per call site.
// ─────────────────────────────────────────────────────────────

export function mockBetaStream(message: unknown): AsyncIterable<unknown> {
  return {
    async *[Symbol.asyncIterator]() {
      yield { type: "message_start", message };
      yield { type: "message_stop" };
    },
  };
}

/**
 * Variant that rejects mid-stream — used by the streaming
 * regression tests to assert that the retry policy treats mid-
 * stream errors the same way it treats request-time errors.
 */
export function mockBetaStreamThatRejects(err: unknown): AsyncIterable<unknown> {
  return {
    async *[Symbol.asyncIterator]() {
      yield { type: "message_start", message: { id: "msg_partial", type: "message", role: "assistant", content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 0, output_tokens: 0 } } };
      throw err;
    },
  };
}
