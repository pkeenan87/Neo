import { describe, it, expect, vi, beforeEach } from "vitest";

const mockCreate = vi.hoisted(() => vi.fn());

vi.mock("@anthropic-ai/sdk", () => {
  return {
    default: class MockAnthropic {
      messages = { create: mockCreate };
      constructor(_opts?: unknown) {}
    },
  };
});

// Mock the tool executor so non-destructive tools return a predictable value
// without hitting real Azure APIs.
vi.mock("../lib/executors", () => ({
  executeTool: vi.fn(async (toolName: string) => ({ ok: true, tool: toolName })),
}));

import { runAgentLoop, resumeAfterConfirmation } from "../lib/agent";
import type { Message, PendingTool } from "../lib/types";

function assistantWithToolUses(
  blocks: Array<
    | { kind: "text"; text: string }
    | { kind: "tool_use"; id: string; name: string; input: Record<string, unknown> }
  >,
) {
  return {
    id: "msg_test",
    type: "message",
    role: "assistant",
    model: "claude-sonnet-4-6",
    stop_reason: "tool_use",
    stop_sequence: null,
    content: blocks.map((b) => {
      if (b.kind === "text") return { type: "text", text: b.text, citations: null };
      return { type: "tool_use", id: b.id, name: b.name, input: b.input };
    }),
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

function endTurnResponse(text = "done") {
  return {
    id: "msg_final",
    type: "message",
    role: "assistant",
    model: "claude-sonnet-4-6",
    stop_reason: "end_turn",
    stop_sequence: null,
    content: [{ type: "text", text, citations: null }],
    usage: {
      input_tokens: 100,
      output_tokens: 10,
      cache_creation_input_tokens: null,
      cache_read_input_tokens: null,
      server_tool_use: null,
      service_tier: null,
    },
  };
}

describe("runAgentLoop — multi-tool confirmation", () => {
  beforeEach(() => {
    mockCreate.mockReset();
  });

  it("preserves pre-destructive tool results on the pending confirmation", async () => {
    mockCreate.mockResolvedValueOnce(
      assistantWithToolUses([
        { kind: "text", text: "looking up the asset first" },
        { kind: "tool_use", id: "tu_lookup", name: "lookup_asset", input: { search: "1.2.3.4" } },
        { kind: "tool_use", id: "tu_block", name: "block_indicator", input: { value: "1.2.3.4", indicator_type: "ip", title: "x" } },
      ]),
    );

    const result = await runAgentLoop(
      [{ role: "user", content: "block 1.2.3.4" }],
      {},
      "admin",
      "test-session",
    );

    expect(result.type).toBe("confirmation_required");
    if (result.type !== "confirmation_required") throw new Error("unreachable");

    expect(result.tool.name).toBe("block_indicator");
    expect(result.tool.preExecutedResults).toHaveLength(1);
    expect(result.tool.preExecutedResults?.[0]).toMatchObject({
      type: "tool_result",
      tool_use_id: "tu_lookup",
    });
  });

  it("drops post-destructive tool_use blocks from the persisted assistant message", async () => {
    mockCreate.mockResolvedValueOnce(
      assistantWithToolUses([
        { kind: "tool_use", id: "tu_block", name: "block_indicator", input: { value: "1.2.3.4", indicator_type: "ip", title: "x" } },
        { kind: "tool_use", id: "tu_trailing", name: "lookup_asset", input: { search: "other" } },
      ]),
    );

    const result = await runAgentLoop(
      [{ role: "user", content: "hi" }],
      {},
      "admin",
      "test-session",
    );

    expect(result.type).toBe("confirmation_required");
    if (result.type !== "confirmation_required") throw new Error("unreachable");

    const lastAssistant = result.messages[result.messages.length - 1];
    expect(lastAssistant.role).toBe("assistant");
    const toolUseIds = (lastAssistant.content as Array<{ type: string; id?: string }>)
      .filter((b) => b.type === "tool_use")
      .map((b) => b.id);
    expect(toolUseIds).toEqual(["tu_block"]);
    expect(toolUseIds).not.toContain("tu_trailing");
  });

  it("resumeAfterConfirmation emits pre-executed + confirmed results in order", async () => {
    const preResult = {
      type: "tool_result" as const,
      tool_use_id: "tu_lookup",
      content: JSON.stringify({ ok: true, tool: "lookup_asset" }),
    };
    const pending: PendingTool = {
      id: "tu_block",
      name: "block_indicator",
      input: { value: "1.2.3.4", indicator_type: "ip", title: "x", justification: "test" },
      preExecutedResults: [preResult],
    };
    const messages: Message[] = [
      { role: "user", content: "block it" },
      {
        role: "assistant",
        content: [
          { type: "tool_use", id: "tu_lookup", name: "lookup_asset", input: { search: "1.2.3.4" } },
          { type: "tool_use", id: "tu_block", name: "block_indicator", input: pending.input },
        ],
      },
    ];

    // First mocked call after resume — agent concludes the turn
    mockCreate.mockResolvedValueOnce(endTurnResponse());

    const result = await resumeAfterConfirmation(messages, pending, true, {}, "admin", "test-session");

    expect(result.type).toBe("response");
    const postUserMsg = result.messages.find((m) => m.role === "user" && Array.isArray(m.content));
    expect(postUserMsg).toBeDefined();
    // The user message we just pushed is the last one before the final assistant
    const pushed = result.messages[result.messages.length - 2];
    expect(pushed.role).toBe("user");
    const content = pushed.content as Array<{ type: string; tool_use_id: string }>;
    expect(content).toHaveLength(2);
    expect(content[0].tool_use_id).toBe("tu_lookup"); // pre-executed first
    expect(content[1].tool_use_id).toBe("tu_block");  // confirmed second
  });

  it("resumeAfterConfirmation with cancel still pairs all tool_use blocks", async () => {
    const preResult = {
      type: "tool_result" as const,
      tool_use_id: "tu_lookup",
      content: JSON.stringify({ ok: true, tool: "lookup_asset" }),
    };
    const pending: PendingTool = {
      id: "tu_block",
      name: "block_indicator",
      input: { value: "1.2.3.4", indicator_type: "ip", title: "x", justification: "test" },
      preExecutedResults: [preResult],
    };
    const messages: Message[] = [
      { role: "user", content: "block it" },
      {
        role: "assistant",
        content: [
          { type: "tool_use", id: "tu_lookup", name: "lookup_asset", input: { search: "1.2.3.4" } },
          { type: "tool_use", id: "tu_block", name: "block_indicator", input: pending.input },
        ],
      },
    ];

    mockCreate.mockResolvedValueOnce(endTurnResponse("cancelled"));

    const result = await resumeAfterConfirmation(messages, pending, false, {}, "admin", "test-session");

    const pushed = result.messages[result.messages.length - 2];
    expect(pushed.role).toBe("user");
    const content = pushed.content as Array<{ type: string; tool_use_id: string; content: string }>;
    expect(content).toHaveLength(2);
    expect(content[0].tool_use_id).toBe("tu_lookup");
    expect(content[1].tool_use_id).toBe("tu_block");
    // Cancelled result payload
    expect(content[1].content).toContain("cancelled");
  });

  it("single-destructive backward compat: resume with no preExecutedResults emits one tool_result", async () => {
    const pending: PendingTool = {
      id: "tu_block",
      name: "block_indicator",
      input: { value: "1.2.3.4", indicator_type: "ip", title: "x", justification: "test" },
    };
    const messages: Message[] = [
      { role: "user", content: "block it" },
      {
        role: "assistant",
        content: [
          { type: "tool_use", id: "tu_block", name: "block_indicator", input: pending.input },
        ],
      },
    ];

    mockCreate.mockResolvedValueOnce(endTurnResponse());

    const result = await resumeAfterConfirmation(messages, pending, true, {}, "admin", "test-session");

    const pushed = result.messages[result.messages.length - 2];
    const content = pushed.content as Array<{ type: string; tool_use_id: string }>;
    expect(content).toHaveLength(1);
    expect(content[0].tool_use_id).toBe("tu_block");
  });
});
