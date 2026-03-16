import { describe, it, expect, vi, beforeEach } from "vitest";

const mockCreate = vi.hoisted(() =>
  vi.fn().mockResolvedValue({
    content: [{ type: "text", text: "Test response" }],
    stop_reason: "end_turn",
    usage: {
      input_tokens: 500,
      output_tokens: 100,
      cache_creation_input_tokens: 200,
      cache_read_input_tokens: 0,
    },
  }),
);

vi.mock("@anthropic-ai/sdk", () => {
  return {
    default: class MockAnthropic {
      messages = { create: mockCreate };
      constructor(_opts?: unknown) {}
    },
  };
});

import { runAgentLoop } from "../lib/agent";

describe("prompt caching", () => {
  beforeEach(() => {
    mockCreate.mockClear();
  });

  it("sends system prompt with cache_control", async () => {
    await runAgentLoop(
      [{ role: "user", content: "Hello" }],
      {},
      "reader",
      "test-session",
    );

    expect(mockCreate).toHaveBeenCalledTimes(1);
    const callArgs = mockCreate.mock.calls[0][0];

    // System should be an array with cache_control
    expect(Array.isArray(callArgs.system)).toBe(true);
    expect(callArgs.system[0]).toMatchObject({
      type: "text",
      cache_control: { type: "ephemeral" },
    });
    expect(typeof callArgs.system[0].text).toBe("string");
    expect(callArgs.system[0].text.length).toBeGreaterThan(0);
  });

  it("sends cache_control on the last tool in the tools array", async () => {
    await runAgentLoop(
      [{ role: "user", content: "Hello" }],
      {},
      "reader",
      "test-session",
    );

    const callArgs = mockCreate.mock.calls[0][0];
    const tools = callArgs.tools;

    expect(tools.length).toBeGreaterThan(0);

    // Last tool should have cache_control
    const lastTool = tools[tools.length - 1];
    expect(lastTool.cache_control).toEqual({ type: "ephemeral" });

    // Non-last tools should NOT have cache_control
    if (tools.length > 1) {
      expect(tools[0].cache_control).toBeUndefined();
    }
  });

  it("uses the default model (Sonnet) when no model specified", async () => {
    await runAgentLoop(
      [{ role: "user", content: "Hello" }],
      {},
      "reader",
      "test-session",
    );

    const callArgs = mockCreate.mock.calls[0][0];
    expect(callArgs.model).toBe("claude-sonnet-4-6");
  });

  it("accepts a custom model parameter", async () => {
    await runAgentLoop(
      [{ role: "user", content: "Hello" }],
      {},
      "reader",
      "test-session",
      "claude-opus-4-6",
    );

    const callArgs = mockCreate.mock.calls[0][0];
    expect(callArgs.model).toBe("claude-opus-4-6");
  });

  it("calls onUsage callback with usage data", async () => {
    const onUsage = vi.fn();

    await runAgentLoop(
      [{ role: "user", content: "Hello" }],
      { onUsage },
      "reader",
      "test-session",
    );

    expect(onUsage).toHaveBeenCalledTimes(1);
    expect(onUsage).toHaveBeenCalledWith(
      expect.objectContaining({
        input_tokens: 500,
        output_tokens: 100,
        cache_creation_input_tokens: 200,
        cache_read_input_tokens: 0,
      }),
      "claude-sonnet-4-6",
    );
  });
});
