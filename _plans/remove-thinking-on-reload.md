# Remove Thinking Steps on Conversation Reload

## Context

When a conversation is replayed from Cosmos DB, `conversationToChatMessages()` extracts text from ALL assistant messages — including intermediate tool-use turns that contain reasoning text like "Let me investigate this alert..." During live streaming, only the final `response` event is rendered to the user, but on reload the intermediate assistant turns leak through as visible messages. The fix must make `conversationToChatMessages` skip intermediate assistant messages (those whose content contains `tool_use` blocks), rendering only final-response assistant messages (those with `stop_reason: "end_turn"` semantics). Old string-format conversations don't need fixing per the user. No extended thinking (`type: "thinking"` blocks) is actually used — the issue is purely intermediate tool-use reasoning text.

---

## Key Design Decisions

- **Filter at the hydration layer only** — the raw messages in Cosmos DB remain untouched for audit/debugging. The filter lives in `conversationToChatMessages()`.
- **Identify intermediate vs. final assistant messages by content shape** — an intermediate assistant message contains at least one `tool_use` block in its content array. A final response message contains only `text` blocks (no `tool_use`). This mirrors the streaming behavior where only `end_turn` responses are shown.
- **Skip assistant messages that produce no visible text after filtering** — if an assistant message has only `tool_use` blocks and no text, it would already be skipped by the existing `if (content)` check. If it has both text and `tool_use`, the text is the intermediate reasoning and should be skipped too.
- **Preserve user messages and tool_result messages** — the filter only applies to assistant messages. User messages pass through unchanged. Tool result messages (`role: "user"` with `tool_result` blocks) are already excluded since they lack text content.

---

## Files to Change

| File | Change |
|------|--------|
| `web/components/ChatInterface/ChatInterface.tsx` | Update `conversationToChatMessages()` to skip assistant messages whose content array contains any `tool_use` block |
| `test/remove-thinking-on-reload.test.js` | New test file verifying the filtering logic |

---

## Implementation Steps

### 1. Add a `hasToolUseBlock` type guard in `ChatInterface.tsx`

- Near the existing `isTextBlock` function (line 61), add a new function `hasToolUseBlock(content)` that checks whether a message's content array contains any block with `type === "tool_use"`
- This function should handle both string content (return false) and array content (check for tool_use blocks)

### 2. Update `conversationToChatMessages` to skip intermediate assistant turns

- In the `for` loop (line 116-131), when processing an assistant message with array content, check if the content array contains any `tool_use` block using the new guard
- If it does, skip the entire message (continue to next iteration) — these are intermediate tool-use turns whose text is reasoning/thinking
- Assistant messages with string content pass through unchanged (these are either old-format messages or compressed summaries)
- Assistant messages with array content containing only `text` blocks (no `tool_use`) are final responses and should be rendered as before

### 3. Also filter out `thinking` and `redacted_thinking` blocks defensively

- Even though extended thinking is not currently enabled, add `type: "thinking"` and `type: "redacted_thinking"` to the block types excluded by the existing `isTextBlock` filter — this is already handled since `isTextBlock` only matches `type === "text"`, but add a comment noting this for clarity
- This provides forward-compatibility if extended thinking is enabled in the future

### 4. Write tests

- Create `test/remove-thinking-on-reload.test.js` using the `node:test` runner (matching existing test patterns)
- Replicate the core logic of `conversationToChatMessages` (since the full component cannot be imported in Node.js) and test:
  - A final assistant message (text blocks only) is rendered
  - An intermediate assistant message (text + tool_use blocks) is skipped
  - An assistant message with only tool_use blocks is skipped
  - A user message passes through unchanged
  - String-content assistant messages pass through unchanged
  - An assistant message with thinking + text blocks (no tool_use) renders only the text (defensive case for future extended thinking)
  - A conversation with multiple tool-use rounds followed by a final response renders only the final response and user messages

---

## Verification

1. Run `node --experimental-strip-types --test test/remove-thinking-on-reload.test.js` — all tests should pass
2. Run `cd web && npx next build` — build should succeed with no errors
3. Manual check: start the dev server, load an existing conversation that previously showed intermediate reasoning — verify only the final response and user messages are visible - wont be able to talk to database FYI.
4. Manual check: send a new message that triggers tool use, then reload the page — verify the same filtering applies to the freshly saved conversation
5. Verify the ThinkingBubble animation still works during live streaming (no regression)
