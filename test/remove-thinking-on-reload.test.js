import { describe, it } from "node:test";
import assert from "node:assert/strict";

// ── Replicated logic from ChatInterface.tsx ─────────────────
// These functions mirror the component's filtering so we can
// test without importing a React component in Node.js.

function isTextBlock(b) {
  return (
    typeof b === "object" &&
    b !== null &&
    b.type === "text" &&
    typeof b.text === "string"
  );
}

function isIntermediateAssistantTurn(content) {
  if (!Array.isArray(content)) return false;
  return content.some(
    (b) =>
      typeof b === "object" &&
      b !== null &&
      (b.type === "tool_use" || b.type === "thinking" || b.type === "redacted_thinking"),
  );
}

function conversationToChatMessages(messages) {
  const chatMessages = [];
  for (const msg of messages) {
    if (msg.role === "user" || msg.role === "assistant") {
      if (msg.role === "assistant" && isIntermediateAssistantTurn(msg.content)) {
        continue;
      }
      const content =
        typeof msg.content === "string"
          ? msg.content
          : Array.isArray(msg.content)
            ? msg.content
                .filter(isTextBlock)
                .map((b) => b.text)
                .join("\n")
            : "";
      if (content) {
        chatMessages.push({ role: msg.role, content });
      }
    }
  }
  return chatMessages;
}

// ── Tests ────────────────────────────────────────────────────

describe("conversationToChatMessages filtering", () => {
  it("renders a final assistant message (text blocks only)", () => {
    const messages = [
      { role: "user", content: "Check this alert" },
      {
        role: "assistant",
        content: [{ type: "text", text: "The alert is a false positive." }],
      },
    ];
    const result = conversationToChatMessages(messages);
    assert.equal(result.length, 2);
    assert.equal(result[1].content, "The alert is a false positive.");
  });

  it("skips intermediate assistant messages (text + tool_use)", () => {
    const messages = [
      { role: "user", content: "Investigate user john@example.com" },
      {
        role: "assistant",
        content: [
          { type: "text", text: "Let me look up this user in Entra ID." },
          { type: "tool_use", id: "tool_1", name: "lookup_user", input: {} },
        ],
      },
      {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "tool_1", content: '{"displayName": "John"}' },
        ],
      },
      {
        role: "assistant",
        content: [{ type: "text", text: "John's account looks clean." }],
      },
    ];
    const result = conversationToChatMessages(messages);
    assert.equal(result.length, 2);
    assert.equal(result[0].role, "user");
    assert.equal(result[0].content, "Investigate user john@example.com");
    assert.equal(result[1].role, "assistant");
    assert.equal(result[1].content, "John's account looks clean.");
  });

  it("skips assistant messages with only tool_use blocks", () => {
    const messages = [
      { role: "user", content: "Run a KQL query" },
      {
        role: "assistant",
        content: [
          { type: "tool_use", id: "tool_1", name: "run_kql_query", input: {} },
        ],
      },
      {
        role: "assistant",
        content: [{ type: "text", text: "Here are the results." }],
      },
    ];
    const result = conversationToChatMessages(messages);
    assert.equal(result.length, 2);
    assert.equal(result[1].content, "Here are the results.");
  });

  it("passes through user messages unchanged", () => {
    const messages = [
      { role: "user", content: "Hello" },
      { role: "user", content: "Follow up question" },
    ];
    const result = conversationToChatMessages(messages);
    assert.equal(result.length, 2);
    assert.equal(result[0].content, "Hello");
    assert.equal(result[1].content, "Follow up question");
  });

  it("passes through string-content assistant messages", () => {
    const messages = [
      { role: "assistant", content: "This is an old-format message stored as a string." },
    ];
    const result = conversationToChatMessages(messages);
    assert.equal(result.length, 1);
    assert.equal(result[0].content, "This is an old-format message stored as a string.");
  });

  it("filters out thinking blocks (defensive for future extended thinking)", () => {
    const messages = [
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "Let me reason through this..." },
          { type: "text", text: "Based on my analysis..." },
        ],
      },
    ];
    const result = conversationToChatMessages(messages);
    // Thinking block makes this an intermediate turn, so it's skipped
    assert.equal(result.length, 0);
  });

  it("filters out redacted_thinking blocks", () => {
    const messages = [
      {
        role: "assistant",
        content: [
          { type: "redacted_thinking", data: "..." },
          { type: "text", text: "Here is the answer." },
        ],
      },
    ];
    const result = conversationToChatMessages(messages);
    assert.equal(result.length, 0);
  });

  it("handles multi-turn tool chain: only final response shown", () => {
    const messages = [
      { role: "user", content: "Check suspicious login from Russia" },
      // Turn 1: assistant reasons + calls tool
      {
        role: "assistant",
        content: [
          { type: "text", text: "I'll check the sign-in logs." },
          { type: "tool_use", id: "t1", name: "run_kql_query", input: {} },
        ],
      },
      // Tool result
      {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "t1", content: "[]" }],
      },
      // Turn 2: assistant reasons + calls another tool
      {
        role: "assistant",
        content: [
          { type: "text", text: "No results. Let me check Defender alerts." },
          { type: "tool_use", id: "t2", name: "get_xdr_incidents", input: {} },
        ],
      },
      // Tool result
      {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "t2", content: "[]" }],
      },
      // Final response
      {
        role: "assistant",
        content: [
          {
            type: "text",
            text: "No suspicious activity found across sign-in logs and Defender.",
          },
        ],
      },
    ];
    const result = conversationToChatMessages(messages);
    assert.equal(result.length, 2);
    assert.equal(result[0].role, "user");
    assert.equal(result[0].content, "Check suspicious login from Russia");
    assert.equal(result[1].role, "assistant");
    assert.ok(result[1].content.includes("No suspicious activity found"));
  });

  it("skips tool_result user messages (no text content)", () => {
    const messages = [
      {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "t1", content: '{"status": "ok"}' },
        ],
      },
    ];
    const result = conversationToChatMessages(messages);
    // tool_result blocks are not text blocks, so content is empty → skipped
    assert.equal(result.length, 0);
  });

  it("omits empty assistant messages after filtering", () => {
    const messages = [
      {
        role: "assistant",
        content: [],
      },
    ];
    const result = conversationToChatMessages(messages);
    assert.equal(result.length, 0);
  });
});
