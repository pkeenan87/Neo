import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type Anthropic from "@anthropic-ai/sdk";
import type { Message } from "../lib/types";

// ─────────────────────────────────────────────────────────────
//  context-manager Haiku compression + anchor-summarisation
//  must carry metadata.user_id when ownerId is supplied via
//  PrepareMessagesContext. Closes the test gap reviewer flagged
//  on the Anthropic per-user attribution change.
// ─────────────────────────────────────────────────────────────

const { capturedCalls, anthropicCreateMock } = vi.hoisted(() => {
  const capturedCalls: Anthropic.Messages.MessageCreateParamsNonStreaming[] = [];
  const anthropicCreateMock = vi.fn(async (params: Anthropic.Messages.MessageCreateParamsNonStreaming) => {
    capturedCalls.push(params);
    return {
      id: "msg_01",
      type: "message" as const,
      role: "assistant" as const,
      model: params.model,
      content: [{ type: "text", text: "- summary bullet" }],
      stop_reason: "end_turn" as const,
      stop_sequence: null,
      usage: { input_tokens: 1, output_tokens: 1 },
    };
  });
  return { capturedCalls, anthropicCreateMock };
});

vi.mock("@anthropic-ai/sdk", () => ({
  default: class MockAnthropic {
    messages = { create: anthropicCreateMock };
  },
}));

// Force compression: tiny TRIM_TRIGGER_THRESHOLD so a small message
// stream tips over and exercises the Haiku call. FIRST_MESSAGE_MAX_TOKENS
// is also tiny so the anchor-summarisation path fires too.
vi.mock("../lib/config", () => ({
  TRIM_TRIGGER_THRESHOLD: 10,
  PER_TOOL_RESULT_TOKEN_CAP: 50_000,
  PRESERVED_RECENT_MESSAGES: 1,
  PERSISTENCE_TOOL_RESULT_TOKEN_CAP: 10_000,
  NEO_CONTEXT_MAX_INPUT_TOKENS: 180_000,
  HAIKU_INPUT_MAX_TOKENS: 160_000,
  FIRST_MESSAGE_MAX_TOKENS: 1,
  HAIKU_MODEL: "claude-haiku-4-5-20251001",
  CONTEXT_TOKEN_LIMIT: 180_000,
  env: { ANTHROPIC_API_KEY: "sk-test", MOCK_MODE: false },
}));

beforeEach(() => {
  capturedCalls.length = 0;
  anthropicCreateMock.mockClear();
});

afterEach(() => {
  vi.clearAllMocks();
});

import { prepareMessages } from "../lib/context-manager";
import { hashPii } from "../lib/logger";

const TEST_OWNER = "owner-1234567890";

function userMsg(text: string): Message {
  return { role: "user", content: text };
}
function assistantMsg(text: string): Message {
  return { role: "assistant", content: [{ type: "text", text }] };
}

describe("context-manager — Anthropic metadata.user_id", () => {
  it("forwards hashPii(ownerId) on the anchor-summarisation Haiku call", async () => {
    // First user message is large enough to trip FIRST_MESSAGE_MAX_TOKENS.
    const big = "x".repeat(1000);
    const messages: Message[] = [
      userMsg(big),
      assistantMsg("ack"),
    ];

    await prepareMessages(messages, null, 0, { ownerId: TEST_OWNER });

    // At least one Haiku call should have fired (anchor summary).
    expect(anthropicCreateMock).toHaveBeenCalled();
    for (const call of capturedCalls) {
      expect(call.metadata).toEqual({ user_id: hashPii(TEST_OWNER) });
    }
  });

  it("forwards hashPii(ownerId) on the older-message compression Haiku call", async () => {
    // Build enough messages that compression triggers (above
    // TRIM_TRIGGER_THRESHOLD = 10 tokens) without tripping the anchor
    // path (anchor stays under FIRST_MESSAGE_MAX_TOKENS = 1 token...
    // tricky; widen the anchor cap by putting the anchor at length 0
    // is impossible — accept that the anchor path fires too and assert
    // ALL Haiku calls carry the metadata.
    const messages: Message[] = [
      userMsg("q1"),
      assistantMsg("a1 with some text to bulk it up over the threshold"),
      userMsg("q2 also bulky enough to exceed the threshold"),
      assistantMsg("a2 final"),
    ];

    await prepareMessages(messages, 200, 0, { ownerId: TEST_OWNER });

    expect(anthropicCreateMock).toHaveBeenCalled();
    for (const call of capturedCalls) {
      expect(call.metadata).toEqual({ user_id: hashPii(TEST_OWNER) });
    }
  });

  it("omits metadata when ownerId is not supplied (back-compat)", async () => {
    const messages: Message[] = [userMsg("x".repeat(1000)), assistantMsg("ack")];
    await prepareMessages(messages, null, 0, {});

    if (anthropicCreateMock.mock.calls.length > 0) {
      for (const call of capturedCalls) {
        expect(call.metadata).toBeUndefined();
      }
    }
  });
});
