import { describe, expect, it, vi } from "vitest";

// agent.ts and context-manager.ts eagerly instantiate Anthropic clients
// at module load. Mock the SDK so the import doesn't blow up in the
// test environment (matches the pattern in agent-empty-user-content.test.ts).
vi.mock("@anthropic-ai/sdk", () => ({
  default: class MockAnthropic {
    messages = { create: vi.fn() };
    beta = { messages: { create: vi.fn() } };
    constructor(_opts?: unknown) {}
  },
}));

import { stampCacheBreakpointOnLastMessage } from "../lib/agent";
import type { Message } from "../lib/types";

// ── stampCacheBreakpointOnLastMessage (P4a) ─────────────────

describe("stampCacheBreakpointOnLastMessage", () => {
  it("returns the array unchanged when empty", () => {
    expect(stampCacheBreakpointOnLastMessage([])).toEqual([]);
  });

  it("wraps a string-content last message into a single text block with cache_control", () => {
    const messages: Message[] = [
      { role: "user", content: "hello" },
    ];
    const stamped = stampCacheBreakpointOnLastMessage(messages);
    const last = stamped[stamped.length - 1];
    expect(Array.isArray(last.content)).toBe(true);
    const blocks = last.content as Array<{ type: string; text?: string; cache_control?: unknown }>;
    expect(blocks).toHaveLength(1);
    expect(blocks[0].type).toBe("text");
    expect(blocks[0].text).toBe("hello");
    expect(blocks[0].cache_control).toEqual({ type: "ephemeral" });
  });

  it("stamps cache_control on the last block of an array-content last message", () => {
    const messages: Message[] = [
      { role: "user", content: "first turn" },
      {
        role: "assistant",
        content: [
          { type: "text", text: "running" },
          { type: "tool_use", id: "tu_1", name: "x", input: {} },
        ],
      },
    ];
    const stamped = stampCacheBreakpointOnLastMessage(messages);
    const last = stamped[stamped.length - 1];
    const blocks = last.content as Array<{ type: string; cache_control?: unknown }>;
    expect(blocks).toHaveLength(2);
    // Earlier block stays untouched.
    expect(blocks[0].cache_control).toBeUndefined();
    // Last block now carries cache_control.
    expect(blocks[1].cache_control).toEqual({ type: "ephemeral" });
  });

  it("is idempotent — does not double-stamp when the last block already has cache_control", () => {
    // cache_control lives on the beta block types — cast the array through
    // `unknown` so we can construct the already-stamped state without dragging
    // the BetaTextBlockParam import chain into this test.
    const messages: Message[] = [
      {
        role: "user",
        content: [
          {
            type: "text",
            text: "hi",
            cache_control: { type: "ephemeral" },
          },
        ] as unknown as Message["content"],
      },
    ];
    const stamped = stampCacheBreakpointOnLastMessage(messages);
    // Reference equality: helper returned the original messages array
    // unchanged because the block was already stamped.
    expect(stamped).toBe(messages);
  });

  it("does not mutate the input array or messages in place", () => {
    const messages: Message[] = [
      { role: "user", content: "hello" },
    ];
    const before = JSON.parse(JSON.stringify(messages));
    stampCacheBreakpointOnLastMessage(messages);
    expect(messages).toEqual(before);
  });

  it("safe-no-ops on an empty-string last message", () => {
    const messages: Message[] = [
      { role: "user", content: "" },
    ];
    const stamped = stampCacheBreakpointOnLastMessage(messages);
    expect(stamped).toBe(messages);
  });

  it("safe-no-ops on a last message with empty content array", () => {
    const messages: Message[] = [
      { role: "user", content: [] },
    ];
    const stamped = stampCacheBreakpointOnLastMessage(messages);
    expect(stamped).toBe(messages);
  });
});
