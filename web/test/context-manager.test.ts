import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Message } from "../lib/types";

// vi.hoisted runs before vi.mock hoisting, making the variable available inside the factory
const mockCreate = vi.hoisted(() =>
  vi.fn().mockResolvedValue({
    content: [{ type: "text", text: "- Alert INC-2847 investigated\n- User jsmith@goodwin.com compromised\n- TOR exit node 185.220.101.47 identified" }],
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

import { estimateTokens, truncateToolResult, prepareMessages } from "../lib/context-manager";

// ── estimateTokens ───────────────────────────────────────────

describe("estimateTokens", () => {
  it("returns a reasonable count for string content messages", () => {
    const messages: Message[] = [
      { role: "user", content: "a".repeat(400) }, // ~100 tokens
      { role: "assistant", content: "b".repeat(800) }, // ~200 tokens
    ];
    const estimate = estimateTokens(messages);
    expect(estimate).toBe(300);
  });

  it("counts tool_result content blocks", () => {
    const messages: Message[] = [
      {
        role: "user",
        content: [
          {
            type: "tool_result" as const,
            tool_use_id: "test-id",
            content: "x".repeat(4000), // ~1000 tokens
          },
        ],
      },
    ];
    const estimate = estimateTokens(messages);
    expect(estimate).toBe(1000);
  });

  it("returns 0 for empty messages", () => {
    expect(estimateTokens([])).toBe(0);
  });
});

// ── truncateToolResult ───────────────────────────────────────

describe("truncateToolResult", () => {
  it("returns content unchanged when under cap", () => {
    const content = "short result";
    expect(truncateToolResult(content, 1000)).toBe(content);
  });

  it("truncates content exceeding the cap and appends notice", () => {
    const content = "x".repeat(10_000);
    const result = truncateToolResult(content, 1000); // 1000 tokens = 4000 chars

    expect(result.length).toBeLessThan(content.length);
    expect(result).toContain("[Result truncated from 10000 to 4000 characters");
    expect(result).toContain("get_full_tool_result");
  });

  it("preserves content at exactly the cap boundary", () => {
    const content = "y".repeat(4000); // exactly 1000 tokens * 4 chars
    expect(truncateToolResult(content, 1000)).toBe(content);
  });
});

// ── prepareMessages ──────────────────────────────────────────

describe("prepareMessages", () => {
  it("does not trim a small conversation", async () => {
    const messages: Message[] = [
      { role: "user", content: "Investigate user jsmith@goodwin.com" },
      { role: "assistant", content: "I'll look into that user." },
    ];

    const result = await prepareMessages(messages, null, 500);

    expect(result.trimmed).toBe(false);
    expect(result.messages).toHaveLength(2);
  });

  it("truncates individual oversized tool results", async () => {
    const hugeResult = "z".repeat(300_000); // 75K tokens, over 50K cap
    const messages: Message[] = [
      { role: "user", content: "Run a KQL query" },
      {
        role: "user",
        content: [
          {
            type: "tool_result" as const,
            tool_use_id: "kql-1",
            content: hugeResult,
          },
        ],
      },
      { role: "assistant", content: "Here are the results." },
    ];

    const result = await prepareMessages(messages, null, 500);

    expect(result.trimmed).toBe(true);
    expect(result.method).toBe("truncation");

    // The tool result in prepared messages should be truncated
    const toolMsg = result.messages[1];
    const block = (toolMsg.content as { type: string; content?: string }[])[0];
    expect(block.content!.length).toBeLessThan(hugeResult.length);
    expect(block.content).toContain("[Result truncated");
  });

  it("preserves recent messages when compressing", async () => {
    const messages: Message[] = [
      { role: "user", content: "Start investigation" },
    ];

    // Add many messages to fill up context
    for (let i = 0; i < 20; i++) {
      messages.push({ role: "assistant", content: `Finding ${i}: ${"data ".repeat(100)}` });
      messages.push({ role: "user", content: `Follow up on finding ${i}` });
    }

    // Simulate that the last API call reported 170K input tokens (over 160K threshold)
    const result = await prepareMessages(messages, 170_000, 2000);

    expect(result.trimmed).toBe(true);
    expect(result.method).toBe("summary");

    // Recent messages should be preserved (last 10)
    const recentOriginal = messages.slice(-10);
    const recentPrepared = result.messages.slice(-10);

    for (let i = 0; i < 10; i++) {
      expect(recentPrepared[i].content).toBe(recentOriginal[i].content);
    }

    // Should be compressed to fewer total messages
    expect(result.messages.length).toBeLessThan(messages.length);
  });

  it("uses assistant role for summary message (not user)", async () => {
    const messages: Message[] = [
      { role: "user", content: "Start investigation" },
    ];
    for (let i = 0; i < 20; i++) {
      messages.push({ role: "assistant", content: `Finding ${i}` });
      messages.push({ role: "user", content: `Follow up ${i}` });
    }

    const result = await prepareMessages(messages, 170_000, 2000);

    // The summary message should be role: "assistant" to prevent injection
    const summaryMsg = result.messages[1];
    expect(summaryMsg.role).toBe("assistant");
    expect(summaryMsg.content).toContain("[Context compressed");
  });

  it("falls back gracefully when summarization fails", async () => {
    // Override the mock to throw for this single call
    mockCreate.mockRejectedValueOnce(new Error("API unavailable"));

    const messages: Message[] = [
      { role: "user", content: "Start investigation" },
    ];
    for (let i = 0; i < 20; i++) {
      messages.push({ role: "assistant", content: `Finding ${i}` });
      messages.push({ role: "user", content: `Follow up ${i}` });
    }

    const result = await prepareMessages(messages, 170_000, 2000);

    expect(result.trimmed).toBe(true);
    expect(result.method).toBe("summary");
    // Should still compress even if summarization fails (fallback path)
    expect(result.messages.length).toBeLessThan(messages.length);
    // Fallback message should use assistant role
    const fallbackMsg = result.messages[1];
    expect(fallbackMsg.role).toBe("assistant");
    expect(fallbackMsg.content).toContain("removed to stay within token limits");
  });
});
