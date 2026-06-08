import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type Anthropic from "@anthropic-ai/sdk";
import type { Message } from "../lib/types";

// ─────────────────────────────────────────────────────────────
//  Anthropic per-user attribution: every messages.create call from
//  the agent loop must carry metadata.user_id = hashPii(ownerId)
//  when ownerId is supplied. Closes Law Firm High H2 / Security
//  posture gap from the audit.
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
      content: [{ type: "text", text: "ok." }],
      stop_reason: "end_turn" as const,
      stop_sequence: null,
      usage: { input_tokens: 10, output_tokens: 2 },
    };
  });
  return { capturedCalls, anthropicCreateMock };
});

vi.mock("@anthropic-ai/sdk", () => {
  return {
    default: class MockAnthropic {
      messages = { create: anthropicCreateMock };
      // Streaming wrapper — production now calls .create({ stream:
      // true }) and aggregates. Delegate to the shared mock so
      // `capturedCalls` still records the params for assertion.
      beta = {
        messages: {
          create: async (params: unknown) => {
            const message = await anthropicCreateMock(params as Anthropic.Messages.MessageCreateParamsNonStreaming);
            return {
              async *[Symbol.asyncIterator]() {
                yield { type: "message_start", message };
                yield { type: "message_stop" };
              },
            };
          },
        },
      };
    },
  };
});

vi.mock("../lib/context-manager", () => ({
  prepareMessages: vi.fn(async (messages: Message[]) => ({
    messages,
    trimmed: false,
    method: undefined,
    originalTokens: 0,
    newTokens: 0,
  })),
  sanitizeEmptyUserMessages: (messages: Message[]) => messages,
  CHARS_PER_TOKEN: 4,
  unwrapLegacyWebSearchEnvelopes: (messages: Message[]) => messages,
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

beforeEach(() => {
  capturedCalls.length = 0;
  anthropicCreateMock.mockClear();
});

afterEach(() => {
  vi.clearAllMocks();
});

import { runAgentLoop } from "../lib/agent";
import { hashPii } from "../lib/logger";

describe("agent loop — Anthropic metadata.user_id", () => {
  it("forwards hashPii(ownerId) as metadata.user_id when ownerId is supplied", async () => {
    const ownerId = "11111111-2222-3333-4444-555555555555";

    await runAgentLoop(
      [{ role: "user", content: "hello" }],
      {},
      "reader",
      "session-abc",
      undefined,
      undefined,
      { ownerId },
    );

    expect(anthropicCreateMock).toHaveBeenCalledTimes(1);
    expect(capturedCalls[0].metadata).toEqual({ user_id: hashPii(ownerId) });
    // Hash output is 16 hex chars by hashPii contract.
    expect(capturedCalls[0].metadata?.user_id).toMatch(/^[0-9a-f]{16}$/);
  });

  it("omits metadata entirely when ownerId is not supplied (back-compat)", async () => {
    await runAgentLoop(
      [{ role: "user", content: "hello" }],
      {},
      "reader",
      "session-abc",
    );

    expect(anthropicCreateMock).toHaveBeenCalledTimes(1);
    expect(capturedCalls[0].metadata).toBeUndefined();
  });

  it("hashes synthetic owner ids (e.g. teams-thread:<id>) deterministically", async () => {
    const synthetic = "teams-thread:abc-conv-123";

    await runAgentLoop(
      [{ role: "user", content: "hello" }],
      {},
      "reader",
      "session-xyz",
      undefined,
      undefined,
      { ownerId: synthetic },
    );

    expect(capturedCalls[0].metadata?.user_id).toBe(hashPii(synthetic));
    expect(capturedCalls[0].metadata?.user_id).not.toContain(":");
    expect(capturedCalls[0].metadata?.user_id).not.toContain("teams");
  });
});
