import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Message, InProgressPlan } from "../lib/types";

const mockCreate = vi.hoisted(() => vi.fn());
vi.mock("@anthropic-ai/sdk", () => ({
  default: class MockAnthropic {
    messages = { create: mockCreate };
    constructor(_opts?: unknown) {}
  },
}));

// Track setInProgressPlan / getInProgressPlan calls via the
// session-factory singleton.
const { mockSetPlan, mockGetPlan } = vi.hoisted(() => ({
  mockSetPlan: vi.fn(async () => undefined),
  mockGetPlan: vi.fn(async (): Promise<InProgressPlan | null> => null),
}));
vi.mock("../lib/session-factory", () => ({
  sessionStore: {
    setInProgressPlan: mockSetPlan,
    getInProgressPlan: mockGetPlan,
  },
}));

vi.mock("../lib/executors", () => ({
  executeTool: vi.fn(async (_name: string) => ({ ok: true })),
}));

function makeResponse(opts: {
  stop_reason: "end_turn" | "max_tokens" | "tool_use";
  content: Array<
    | { type: "text"; text: string }
    | { type: "tool_use"; id: string; name: string; input: Record<string, unknown> }
  >;
}) {
  return {
    id: "msg_test",
    type: "message",
    role: "assistant",
    model: "claude-sonnet-4-6",
    stop_reason: opts.stop_reason,
    stop_sequence: null,
    content: opts.content.map((b) =>
      b.type === "text"
        ? { type: "text", text: b.text, citations: null }
        : { type: "tool_use", id: b.id, name: b.name, input: b.input },
    ),
    usage: {
      input_tokens: 100,
      output_tokens: 50,
      cache_creation_input_tokens: null,
      cache_read_input_tokens: null,
      server_tool_use: null,
      service_tier: null,
    },
  };
}

const samplePlan: InProgressPlan = {
  schemaVersion: 1,
  createdAt: "2026-04-24T19:00:00.000Z",
  planText: "1. remediate batch A\n2. remediate batch B\n3. remediate batch C",
  toolCallsRemaining: 3,
  originalTurnNumber: 4,
};

import { runAgentLoop } from "../lib/agent";
import { IncompleteToolUseError } from "../lib/types";

describe("agent-loop plan resumption", () => {
  beforeEach(() => {
    mockCreate.mockReset();
    mockSetPlan.mockClear();
    mockGetPlan.mockReset();
    mockGetPlan.mockResolvedValue(null);
  });

  it("clears an existing plan on clean end_turn", async () => {
    mockGetPlan.mockResolvedValueOnce(samplePlan);
    mockCreate.mockResolvedValueOnce(
      makeResponse({
        stop_reason: "end_turn",
        content: [{ type: "text", text: "done" }],
      }),
    );
    const messages: Message[] = [{ role: "user", content: "continue" }];
    await runAgentLoop(messages, {}, "admin", "conv_abc");
    // Plan cleared with null (fire-and-forget — may need a microtask flush).
    await new Promise((r) => setTimeout(r, 10));
    expect(mockSetPlan).toHaveBeenCalledWith("conv_abc", null);
  });

  it("attaches remainingPlan to IncompleteToolUseError on max_tokens mid-tool-use and increments resumptionCount", async () => {
    mockGetPlan.mockResolvedValueOnce(samplePlan);
    mockCreate.mockResolvedValueOnce(
      makeResponse({
        stop_reason: "max_tokens",
        content: [
          { type: "text", text: "planning" },
          { type: "tool_use", id: "tu_oops", name: "remediate_abnormal_messages", input: {} },
        ],
      }),
    );
    const messages: Message[] = [{ role: "user", content: "start" }];
    try {
      await runAgentLoop(messages, {}, "admin", "conv_abc");
      expect.fail("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(IncompleteToolUseError);
      const errWithPlan = err as Error & { remainingPlan: InProgressPlan | null };
      // Plan is the same shape but with resumptionCount bumped.
      expect(errWithPlan.remainingPlan).toMatchObject({
        planText: samplePlan.planText,
        toolCallsRemaining: samplePlan.toolCallsRemaining,
        resumptionCount: 1,
      });
      expect(mockSetPlan).toHaveBeenCalledWith(
        "conv_abc",
        expect.objectContaining({ resumptionCount: 1 }),
      );
    }
  });

  it("persists a fallback plan when none exists and truncation fires mid-tool-use", async () => {
    // No existing plan.
    mockGetPlan.mockResolvedValueOnce(null);
    mockCreate.mockResolvedValueOnce(
      makeResponse({
        stop_reason: "max_tokens",
        content: [
          { type: "text", text: "about to do something important" },
          { type: "tool_use", id: "tu_later", name: "isolate_machine", input: {} },
        ],
      }),
    );
    const messages: Message[] = [{ role: "user", content: "do it" }];
    try {
      await runAgentLoop(messages, {}, "admin", "conv_xyz");
    } catch (err) {
      expect(err).toBeInstanceOf(IncompleteToolUseError);
      const errWithPlan = err as Error & { remainingPlan: InProgressPlan | null };
      // Fallback plan derived from the last assistant message's text.
      expect(errWithPlan.remainingPlan).not.toBeNull();
      expect(errWithPlan.remainingPlan?.planText).toContain("about to do something important");
      expect(mockSetPlan).toHaveBeenCalledWith(
        "conv_xyz",
        expect.objectContaining({ schemaVersion: 1 }),
      );
    }
  });

  it("circuit breaker: halts with a user-visible error when resumptionCount >= MAX", async () => {
    const loopedPlan: InProgressPlan = { ...samplePlan, resumptionCount: 3 };
    mockGetPlan.mockResolvedValueOnce(loopedPlan);
    const messages: Message[] = [{ role: "user", content: "continue please" }];
    const result = await runAgentLoop(messages, {}, "admin", "conv_abc");
    if (result.type !== "response") throw new Error("wrong type");
    expect(result.truncated).toBe(true);
    // User-visible message names the limit and includes the plan.
    expect(result.text).toMatch(/3 times in a row/);
    expect(result.text).toContain(samplePlan.planText);
    // Plan is cleared.
    expect(mockSetPlan).toHaveBeenCalledWith("conv_abc", null);
    // Claude was NOT called — we halted before any API request.
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it("does NOT clear the plan when returning a truncated text response (stop_reason=max_tokens, phase=text)", async () => {
    mockGetPlan.mockResolvedValueOnce(samplePlan);
    mockCreate.mockResolvedValueOnce(
      makeResponse({
        stop_reason: "max_tokens",
        content: [{ type: "text", text: "partial text response" }],
      }),
    );
    const messages: Message[] = [{ role: "user", content: "talk to me" }];
    const result = await runAgentLoop(messages, {}, "admin", "conv_abc");
    if (result.type !== "response") throw new Error("wrong type");
    expect(result.truncated).toBe(true);
    // Plan is NOT cleared because we didn't hit end_turn (the plan
    // resumption is still pending — user might type continue).
    expect(mockSetPlan).not.toHaveBeenCalled();
  });
});
