import { describe, expect, it, vi } from "vitest";

// ─────────────────────────────────────────────────────────────
//  Streaming-path regression suite.
//
//  Pins the contract that closed the 10-minute SDK ceiling on
//  long skill turns: every Anthropic call now flows through
//  `client.beta.messages.create({ stream: true })`, gets
//  aggregated server-side by `aggregateBetaStream`, and is
//  returned to callers in the same Message shape the pre-stream
//  code surfaced.
//
//  Five invariants:
//    (a) production calls .create with stream:true (NOT .create
//        without it)
//    (b) the aggregated message reaches the caller unchanged
//        (text content, tool_use input, usage, stop_reason)
//    (c) AbortSignal is forwarded into the .create call
//    (d) a mid-stream rejection from `finalMessage`/iteration
//        triggers the same retry policy as a request-time
//        rejection
//    (e) prompt-too-long errors short-circuit retries and surface
//        a user-friendly message
// ─────────────────────────────────────────────────────────────

const { capturedCalls, betaCreateMock } = vi.hoisted(() => {
  const capturedCalls: Array<{ params: unknown; options: unknown }> = [];
  const betaCreateMock = vi.fn();
  return { capturedCalls, betaCreateMock };
});

vi.mock("@anthropic-ai/sdk", () => ({
  default: class MockAnthropic {
    messages = { create: vi.fn() };
    beta = {
      messages: {
        create: async (params: unknown, options: unknown) => {
          capturedCalls.push({ params, options });
          return betaCreateMock(params, options);
        },
      },
    };
    constructor(_opts?: unknown) {}
  },
}));

vi.mock("../lib/context-manager", () => ({
  prepareMessages: vi.fn(async (messages: unknown[]) => ({
    messages,
    trimmed: false,
    method: undefined,
    originalTokens: 0,
    newTokens: 0,
  })),
  sanitizeEmptyUserMessages: (messages: unknown[]) => messages,
  CHARS_PER_TOKEN: 4,
  unwrapLegacyWebSearchEnvelopes: (messages: unknown[]) => messages,
}));

vi.mock("../lib/session-factory", () => ({
  sessionStore: {
    getInProgressPlan: vi.fn(async () => null),
    setInProgressPlan: vi.fn(async () => {}),
  },
}));

vi.mock("../lib/skill-store", () => ({
  getSkillsForRole: vi.fn(async () => []),
}));

import { runAgentLoop } from "../lib/agent";
import type { Message } from "../lib/types";

function streamYielding(message: unknown): AsyncIterable<unknown> {
  return {
    async *[Symbol.asyncIterator]() {
      yield { type: "message_start", message };
      yield { type: "message_stop" };
    },
  };
}

function defaultMessage(text = "ok.") {
  return {
    id: "msg_01",
    type: "message" as const,
    role: "assistant" as const,
    model: "claude-sonnet-4-6",
    content: [{ type: "text", text }],
    stop_reason: "end_turn" as const,
    stop_sequence: null,
    usage: { input_tokens: 10, output_tokens: 2 },
  };
}

beforeEach(() => {
  capturedCalls.length = 0;
  betaCreateMock.mockReset();
});

import { beforeEach } from "vitest";

describe("agent loop — streaming wire format (a) stream:true is set", () => {
  it("passes stream:true on every beta.messages.create call", async () => {
    betaCreateMock.mockReturnValue(streamYielding(defaultMessage()));
    await runAgentLoop([{ role: "user", content: "hi" }], {}, "reader", "s-a");
    expect(capturedCalls).toHaveLength(1);
    const params = capturedCalls[0].params as { stream?: boolean };
    expect(params.stream).toBe(true);
  });
});

describe("agent loop — streaming wire format (b) aggregated message reaches caller", () => {
  it("returns the aggregated final text unchanged from message_start.message", async () => {
    betaCreateMock.mockReturnValue(streamYielding(defaultMessage("the long answer")));
    const result = await runAgentLoop(
      [{ role: "user", content: "hi" }],
      {},
      "reader",
      "s-b1",
    );
    if (result.type !== "response") throw new Error("expected response");
    expect(result.text).toBe("the long answer");
  });

  it("accumulates text_delta events into the final message text", async () => {
    // Mimic the real Anthropic protocol: message_start with empty
    // content, content_block_start, several text_delta events, then
    // content_block_stop + message_stop. The accumulator must
    // concatenate the deltas.
    const skeleton = {
      id: "msg_02",
      type: "message" as const,
      role: "assistant" as const,
      model: "claude-sonnet-4-6",
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: 10, output_tokens: 0 },
    };
    betaCreateMock.mockReturnValue({
      async *[Symbol.asyncIterator]() {
        yield { type: "message_start", message: skeleton };
        yield {
          type: "content_block_start",
          index: 0,
          content_block: { type: "text", text: "" },
        };
        yield { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "hello " } };
        yield { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "world" } };
        yield { type: "content_block_stop", index: 0 };
        yield {
          type: "message_delta",
          delta: { stop_reason: "end_turn", stop_sequence: null },
          usage: { output_tokens: 2 },
        };
        yield { type: "message_stop" };
      },
    });
    const result = await runAgentLoop(
      [{ role: "user", content: "hi" }],
      {},
      "reader",
      "s-b2",
    );
    if (result.type !== "response") throw new Error("expected response");
    expect(result.text).toBe("hello world");
  });
});

describe("agent loop — streaming wire format (c) AbortSignal is composed", () => {
  it("composes the caller's signal with the wall-clock STREAM_TIMEOUT_MS", async () => {
    // Pre-fix: caller.signal was passed through directly. Post-fix:
    // wrapped via AbortSignal.any so the 30-min wall-clock timeout
    // also fires (the SDK's own `timeout` only covers TTFB). We
    // can't assert on the exact composite, but it must NOT be the
    // raw controller.signal, and must be an AbortSignal that
    // *would* abort if the caller's signal aborts.
    betaCreateMock.mockReturnValue(streamYielding(defaultMessage()));
    const controller = new AbortController();
    await runAgentLoop(
      [{ role: "user", content: "hi" } as Message],
      {},
      "reader",
      "s-c",
      undefined,
      controller.signal,
    );
    expect(capturedCalls).toHaveLength(1);
    const options = capturedCalls[0].options as { signal?: AbortSignal };
    expect(options.signal).toBeDefined();
    expect(options.signal).not.toBe(controller.signal);
    expect(options.signal instanceof AbortSignal).toBe(true);
    // Aborting the caller's signal aborts the composite too.
    expect(options.signal!.aborted).toBe(false);
    controller.abort();
    expect(options.signal!.aborted).toBe(true);
  });
});

describe("agent loop — streaming wire format (d) mid-stream errors retry", () => {
  it("retries when the stream throws after partial events", async () => {
    // First attempt throws mid-stream with a retryable 529 status
    // (overloaded). Second attempt succeeds. The agent loop should
    // return the second attempt's text, not surface the error.
    let attempts = 0;
    betaCreateMock.mockImplementation(() => {
      attempts += 1;
      if (attempts === 1) {
        return {
          async *[Symbol.asyncIterator]() {
            yield { type: "message_start", message: { id: "p", type: "message", role: "assistant", model: "claude-sonnet-4-6", content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 0, output_tokens: 0 } } };
            throw Object.assign(new Error("upstream blip"), { status: 529 });
          },
        };
      }
      return streamYielding(defaultMessage("recovered"));
    });
    const result = await runAgentLoop(
      [{ role: "user", content: "hi" }],
      {},
      "reader",
      "s-d",
    );
    if (result.type !== "response") throw new Error("expected response");
    expect(result.text).toBe("recovered");
    expect(attempts).toBeGreaterThanOrEqual(2);
  }, 20_000);
});

describe("agent loop — ultrareview HIGH (silent abort truncation)", () => {
  it("returns buildInterruptedResult when AbortSignal fires while the SDK iterator is awaiting the next event", async () => {
    // The Anthropic SDK's stream iterator silently returns (does
    // NOT throw) when the underlying fetch is aborted. Pre-fix,
    // our for-await loop exited normally, `aggregateBetaStream`
    // returned a partial Message with stop_reason: null, and the
    // agent loop crashed with "Unexpected stop_reason: null".
    // Post-fix, the post-loop `signal?.throwIfAborted()` and
    // sawMessageStop guard convert the silent return into a clean
    // abort that the outer catch routes to buildInterruptedResult.
    const controller = new AbortController();
    betaCreateMock.mockImplementation(() => ({
      async *[Symbol.asyncIterator]() {
        yield { type: "message_start", message: { id: "p", type: "message", role: "assistant", model: "claude-sonnet-4-6", content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 0 } } };
        // Simulate the SDK's silent-return-on-abort by simply
        // ending the iterator after the abort fires. The composite
        // signal aborts when controller.signal aborts, so
        // throwIfAborted() inside aggregateBetaStream's post-loop
        // re-check raises.
        // We trigger the abort via setTimeout so it happens
        // *between* yields.
        await new Promise<void>((resolve) => setTimeout(resolve, 5));
        return; // silent return — pre-fix this would have masked the abort
      },
    }));
    setTimeout(() => controller.abort(), 1);

    const result = await runAgentLoop(
      [{ role: "user", content: "hi" } as Message],
      {},
      "reader",
      "s-abort",
      undefined,
      controller.signal,
    );
    // buildInterruptedResult() returns { type: "response", text: "[interrupted]", interrupted: true }
    if (result.type !== "response") throw new Error("expected response");
    expect(result.interrupted).toBe(true);
  });

  it("throws StreamIncompleteError when message_stop never arrives (upstream truncation)", async () => {
    // Distinct from the abort case: the stream ENDED cleanly but
    // never sent message_stop (proxy cut, server-side truncation).
    // Pre-fix this fell through to "Unexpected stop_reason: null".
    // Post-fix we throw a typed error so the retry path engages.
    betaCreateMock.mockImplementation(() => ({
      async *[Symbol.asyncIterator]() {
        yield { type: "message_start", message: { id: "p", type: "message", role: "assistant", model: "claude-sonnet-4-6", content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 0, output_tokens: 0 } } };
        // Loop ends here — no message_stop.
      },
    }));
    await expect(
      runAgentLoop([{ role: "user", content: "hi" }], {}, "reader", "s-trunc"),
    ).rejects.toThrow(/incomplete response/i);
  });
});

describe("agent loop — ultrareview MEDIUM (APIUserAbortError)", () => {
  it("treats the SDK's APIUserAbortError as an abort, not a generic error", async () => {
    // The SDK throws APIUserAbortError (not AbortError) when
    // signal.aborted is true at request time. Pre-fix, our checks
    // only matched err.name === 'AbortError' so SDK-originated
    // aborts surfaced as opaque errors. Post-fix, isAbortError()
    // matches both.
    betaCreateMock.mockImplementation(() => {
      throw Object.assign(new Error("Request was aborted."), {
        name: "APIUserAbortError",
        status: undefined,
      });
    });
    const result = await runAgentLoop(
      [{ role: "user", content: "hi" }],
      {},
      "reader",
      "s-apiabort",
    );
    if (result.type !== "response") throw new Error("expected response");
    expect(result.interrupted).toBe(true);
  });
});

describe("agent loop — ultrareview MEDIUM (malformed tool input JSON fails loud)", () => {
  it("throws when input_json_delta deltas concatenate to invalid JSON", async () => {
    // Pre-fix, the JSON.parse failure was silently swallowed and
    // input defaulted to whatever content_block_start provided
    // (typically {}). The tool then executed with empty/wrong
    // arguments — a data-integrity hazard for any executor that
    // scopes by argument. Post-fix, the parse failure throws and
    // is logged.
    betaCreateMock.mockImplementation(() => ({
      async *[Symbol.asyncIterator]() {
        yield { type: "message_start", message: { id: "p", type: "message", role: "assistant", model: "claude-sonnet-4-6", content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 0, output_tokens: 0 } } };
        yield { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "tu_1", name: "x", input: {} } };
        yield { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: "{not-json" } };
        yield { type: "content_block_stop", index: 0 };
        yield { type: "message_delta", delta: { stop_reason: "tool_use", stop_sequence: null }, usage: { output_tokens: 1 } };
        yield { type: "message_stop" };
      },
    }));
    await expect(
      runAgentLoop([{ role: "user", content: "hi" }], {}, "reader", "s-badjson"),
    ).rejects.toThrow(/tool input JSON parse failed/i);
  }, 20_000);
});

describe("agent loop — streaming wire format (e) prompt-too-long short-circuits", () => {
  it("does NOT retry on a 400 'prompt is too long' error and surfaces a clear message", async () => {
    let attempts = 0;
    betaCreateMock.mockImplementation(() => {
      attempts += 1;
      const err = Object.assign(new Error("prompt is too long for this model"), { status: 400 });
      // Throw synchronously from create() (request-time) — same
      // path the existing retry/short-circuit logic handles.
      throw err;
    });

    await expect(
      runAgentLoop([{ role: "user", content: "hi" }], {}, "reader", "s-e"),
    ).rejects.toThrow(/conversation has grown too large/i);

    expect(attempts).toBe(1);
  });
});
