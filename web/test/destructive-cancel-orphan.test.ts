import { describe, it, expect, vi } from "vitest";

vi.mock("../lib/logger", () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    emitEvent: vi.fn(),
  },
  hashPii: (s: string) => `hash(${s})`,
}));

vi.mock("@anthropic-ai/sdk", () => ({
  default: class MockAnthropic {
    messages = { create: vi.fn() };
    beta = { messages: { create: vi.fn() } };
    constructor(_opts?: unknown) {}
  },
}));

import { buildImplicitCancellationMessage } from "../lib/agent";
import type { PendingTool } from "../lib/types";

describe("buildImplicitCancellationMessage", () => {
  it("synthesises a user message with a cancellation tool_result for the pending tool_use_id", () => {
    const pending: PendingTool = {
      id: "toolu_destructive_X",
      name: "reset_user_password",
      input: { upn: "test@example.com", justification: "test" },
    };

    const msg = buildImplicitCancellationMessage(pending);

    expect(msg.role).toBe("user");
    expect(Array.isArray(msg.content)).toBe(true);
    const blocks = msg.content as Array<{
      type: string;
      tool_use_id?: string;
      content?: string;
    }>;
    expect(blocks).toHaveLength(1);
    expect(blocks[0].type).toBe("tool_result");
    expect(blocks[0].tool_use_id).toBe("toolu_destructive_X");
    expect(blocks[0].content).toContain("cancelled");
  });

  it("prepends preExecutedResults so every prior tool_use is paired by the synthetic message", () => {
    // The agent loop captures non-destructive tool results that ran in
    // the same turn before the destructive paused it. If we don't carry
    // them forward in the synthesised user message, the next API call
    // sees orphan tool_use blocks for the non-destructive tools.
    const pending: PendingTool = {
      id: "toolu_destructive_X",
      name: "reset_user_password",
      input: { upn: "test@example.com" },
      preExecutedResults: [
        {
          type: "tool_result",
          tool_use_id: "toolu_readonly_A",
          content: "row count: 12",
        },
        {
          type: "tool_result",
          tool_use_id: "toolu_readonly_B",
          content: "{}",
        },
      ],
    };

    const msg = buildImplicitCancellationMessage(pending);
    const blocks = msg.content as Array<{ type: string; tool_use_id: string }>;
    expect(blocks).toHaveLength(3);
    expect(blocks.map((b) => b.tool_use_id)).toEqual([
      "toolu_readonly_A",
      "toolu_readonly_B",
      "toolu_destructive_X",
    ]);
  });

  it("handles a pending tool with no preExecutedResults", () => {
    const pending: PendingTool = {
      id: "toolu_only_destructive",
      name: "isolate_machine",
      input: { hostname: "srv-01" },
    };
    const msg = buildImplicitCancellationMessage(pending);
    const blocks = msg.content as Array<{ type: string }>;
    expect(blocks).toHaveLength(1);
  });
});
