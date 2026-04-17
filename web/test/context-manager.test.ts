import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Message } from "../lib/types";

// vi.hoisted runs before vi.mock hoisting, making the variable available inside the factory
const mockCreate = vi.hoisted(() =>
  vi.fn().mockResolvedValue({
    content: [{ type: "text", text: "- Alert INC-2847 investigated\n- User jsmith@goodwin.com compromised\n- TOR exit node 185.220.101.47 identified" }],
    usage: { input_tokens: 100, output_tokens: 50 },
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

import {
  estimateTokens,
  truncateToolResult,
  truncateToolResults,
  prepareMessages,
  validateAndRepairConversationShape,
} from "../lib/context-manager";

// ── estimateTokens ───────────────────────────────────────────

describe("estimateTokens", () => {
  it("returns a reasonable count for string content messages", () => {
    const messages: Message[] = [
      { role: "user", content: "a".repeat(350) }, // 100 tokens at 3.5 chars/token
      { role: "assistant", content: "b".repeat(700) }, // 200 tokens
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
            content: "x".repeat(3500), // 1000 tokens at 3.5 chars/token
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
    const result = truncateToolResult(content, 1000); // 1000 tokens = 3500 chars

    expect(result.length).toBeLessThan(content.length);
    expect(result).toContain("[Result truncated from 10000 to 3500 characters");
    expect(result).toContain("get_full_tool_result");
  });

  it("preserves content at exactly the cap boundary", () => {
    const content = "y".repeat(3500); // exactly 1000 tokens * 3.5 chars
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

  it("preserves tool_use/tool_result pairs when compressing", async () => {
    const messages: Message[] = [
      { role: "user", content: "Investigate user jsmith" },
    ];

    // Build 15 tool call pairs to push past the recent-message boundary
    for (let i = 0; i < 15; i++) {
      messages.push({
        role: "assistant",
        content: [
          { type: "text" as const, text: `Running query ${i}` },
          { type: "tool_use" as const, id: `tool-${i}`, name: "run_sentinel_kql", input: { query: `query ${i}` } },
        ],
      });
      messages.push({
        role: "user",
        content: [
          { type: "tool_result" as const, tool_use_id: `tool-${i}`, content: `Result ${i}: ${"data ".repeat(50)}` },
        ],
      });
    }

    const result = await prepareMessages(messages, 170_000, 2000);

    expect(result.trimmed).toBe(true);

    // Verify no orphaned tool blocks in the output
    for (let i = 0; i < result.messages.length; i++) {
      const msg = result.messages[i];
      if (!Array.isArray(msg.content)) continue;

      for (const block of msg.content) {
        if (block.type === "tool_use") {
          // Must have a matching tool_result in the next message
          const next = result.messages[i + 1];
          expect(next).toBeDefined();
          expect(Array.isArray(next.content)).toBe(true);
          const resultIds = (next.content as { type: string; tool_use_id?: string }[])
            .filter((b) => b.type === "tool_result")
            .map((b) => b.tool_use_id);
          expect(resultIds).toContain((block as { id: string }).id);
        }
        if (block.type === "tool_result") {
          // Must have a matching tool_use in the previous message
          const prev = result.messages[i - 1];
          expect(prev).toBeDefined();
          expect(Array.isArray(prev.content)).toBe(true);
          const useIds = (prev.content as { type: string; id?: string }[])
            .filter((b) => b.type === "tool_use")
            .map((b) => b.id);
          expect(useIds).toContain((block as { tool_use_id: string }).tool_use_id);
        }
      }
    }
  });

  it("emergency truncation drops messages when compressed result still exceeds threshold", async () => {
    // Build a conversation with huge tool results that will still be large
    // after compression. Use a massive systemPromptTokenEstimate to force
    // the emergency path even after Haiku summarization succeeds.
    const messages: Message[] = [
      { role: "user", content: "Investigate the breach" },
    ];

    for (let i = 0; i < 20; i++) {
      messages.push({
        role: "assistant",
        content: [
          { type: "tool_use" as const, id: `t-${i}`, name: "run_sentinel_kql", input: { q: i } },
        ],
      });
      messages.push({
        role: "user",
        content: [
          { type: "tool_result" as const, tool_use_id: `t-${i}`, content: `Result ${i}: ${"x".repeat(5000)}` },
        ],
      });
    }

    // systemPromptTokenEstimate of 130K + message tokens will exceed 140K threshold
    // even after Haiku compresses the middle. This forces the emergency loop.
    const result = await prepareMessages(messages, 170_000, 130_000);

    expect(result.trimmed).toBe(true);
    // Should have fewer messages than the preserved recent count
    expect(result.messages.length).toBeLessThan(messages.length);
    // Should still be a valid conversation (at least anchor + summary + something)
    expect(result.messages.length).toBeGreaterThanOrEqual(3);

    // Verify no orphaned tool blocks after emergency drops
    for (let i = 0; i < result.messages.length; i++) {
      const msg = result.messages[i];
      if (!Array.isArray(msg.content)) continue;
      for (const block of msg.content) {
        if (block.type === "tool_result") {
          const prev = result.messages[i - 1];
          expect(prev).toBeDefined();
          if (Array.isArray(prev.content)) {
            const useIds = (prev.content as { type: string; id?: string }[])
              .filter((b) => b.type === "tool_use")
              .map((b) => b.id);
            expect(useIds).toContain((block as { tool_use_id: string }).tool_use_id);
          }
        }
      }
    }
  });
});

// ── validateAndRepairConversationShape ───────────────────────

describe("validateAndRepairConversationShape", () => {
  it("removes orphaned tool_result blocks", () => {
    const messages: Message[] = [
      { role: "assistant", content: "Some text response" },
      {
        role: "user",
        content: [
          { type: "tool_result" as const, tool_use_id: "orphaned-id", content: "result data" },
          { type: "text" as const, text: "user follow-up" },
        ],
      },
    ];

    const repaired = validateAndRepairConversationShape(messages);

    // The orphaned tool_result should be removed
    const userMsg = repaired[1];
    expect(Array.isArray(userMsg.content)).toBe(true);
    const blocks = userMsg.content as { type: string; tool_use_id?: string }[];
    expect(blocks.some((b) => b.type === "tool_result")).toBe(false);
    expect(blocks.some((b) => b.type === "text")).toBe(true);
  });

  it("removes orphaned tool_use blocks", () => {
    const messages: Message[] = [
      {
        role: "assistant",
        content: [
          { type: "text" as const, text: "Let me check" },
          { type: "tool_use" as const, id: "orphaned-use", name: "get_user_info", input: {} },
        ],
      },
      { role: "user", content: "Actually, never mind" },
    ];

    const repaired = validateAndRepairConversationShape(messages);

    const assistantMsg = repaired[0];
    expect(Array.isArray(assistantMsg.content)).toBe(true);
    const blocks = assistantMsg.content as { type: string; id?: string }[];
    expect(blocks.some((b) => b.type === "tool_use")).toBe(false);
    expect(blocks.some((b) => b.type === "text")).toBe(true);
  });

  it("preserves valid tool_use/tool_result pairs", () => {
    const messages: Message[] = [
      {
        role: "assistant",
        content: [
          { type: "tool_use" as const, id: "valid-1", name: "run_sentinel_kql", input: { query: "test" } },
        ],
      },
      {
        role: "user",
        content: [
          { type: "tool_result" as const, tool_use_id: "valid-1", content: "query results" },
        ],
      },
    ];

    const repaired = validateAndRepairConversationShape(messages);

    // Both messages should be unchanged
    const assistantBlocks = repaired[0].content as { type: string }[];
    expect(assistantBlocks).toHaveLength(1);
    expect(assistantBlocks[0].type).toBe("tool_use");

    const userBlocks = repaired[1].content as { type: string }[];
    expect(userBlocks).toHaveLength(1);
    expect(userBlocks[0].type).toBe("tool_result");
  });

  it("replaces empty message content after removing all blocks", () => {
    const messages: Message[] = [
      { role: "assistant", content: "Some context" },
      {
        role: "user",
        content: [
          { type: "tool_result" as const, tool_use_id: "missing-id", content: "orphaned" },
        ],
      },
    ];

    const repaired = validateAndRepairConversationShape(messages);

    // The user message should have placeholder content, not an empty array
    const userMsg = repaired[1];
    expect(typeof userMsg.content).toBe("string");
    expect(userMsg.content).toContain("removed during context compression");
  });
});

// ── truncateToolResults (exported with custom cap) ──────────

describe("truncateToolResults with custom cap", () => {
  it("uses a lower cap for persistence truncation", () => {
    const messages: Message[] = [
      {
        role: "user",
        content: [
          {
            type: "tool_result" as const,
            tool_use_id: "kql-1",
            content: "x".repeat(100_000), // ~28.5K tokens at 3.5 chars/token
          },
        ],
      },
    ];

    // Default 50K cap — should not truncate
    const { anyTruncated: truncatedDefault } = truncateToolResults(messages);
    expect(truncatedDefault).toBe(false);

    // 10K cap (persistence) — should truncate
    const { messages: truncated, anyTruncated } = truncateToolResults(messages, 10_000);
    expect(anyTruncated).toBe(true);

    const block = (truncated[0].content as { type: string; content?: string }[])[0];
    expect(block.content!.length).toBeLessThan(100_000);
    expect(block.content).toContain("[Result truncated");
  });
});
