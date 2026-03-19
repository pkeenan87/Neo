# Spec for Remove Thinking Steps on Conversation Reload

branch: claude/feature/remove-thinking-on-reload

## Summary

When a user reloads a previous conversation in the web chat UI, Claude's internal thinking steps (extended thinking blocks) are displayed as visible messages alongside the actual responses. Thinking blocks are persisted to Cosmos DB as part of the raw Anthropic API response content array, and the conversation hydration path does not fully strip them before rendering. The thinking content should never be shown to users in the chat history — it should only appear as a transient animated indicator during live streaming.

## Functional requirements

- When loading a saved conversation from Cosmos DB, filter out all content blocks with `type: "thinking"` (and `type: "redacted_thinking"`) from assistant message content arrays before rendering in the chat UI
- The `conversationToChatMessages()` function in `ChatInterface.tsx` already filters for `isTextBlock`, but thinking content may still leak through other paths (e.g., if thinking text is concatenated into a single string before storage, or if the content is stored as a pre-joined string rather than a block array)
- Ensure the filtering works for both block-array format (`content: [{type: "thinking", ...}, {type: "text", ...}]`) and any pre-serialized string format
- Do NOT delete thinking blocks from the database — they are valuable for debugging and audit. The filtering should happen at the UI/hydration layer only
- The fix should also be verified against the CLI conversation reload path if applicable

## Possible Edge Cases

- Assistant messages where the only content block is a thinking block (no text block) — these should render as empty or be omitted entirely rather than showing thinking content
- Messages stored as plain strings (older conversations) vs. block arrays (newer conversations with extended thinking)
- `redacted_thinking` blocks (Anthropic may redact thinking content in some cases) — these should also be filtered
- Tool-use messages that interleave thinking blocks between tool calls
- Context manager compression (`context-manager.ts`) may have already summarized thinking blocks into compressed text — verify that compressed messages don't inadvertently include thinking content

## Acceptance Criteria

- Reloading any saved conversation in the web UI never displays thinking block content to the user
- The transient thinking animation (ThinkingBubble) during live streaming continues to work normally
- Thinking blocks remain in Cosmos DB for audit/debugging purposes
- No regression in how tool calls, text responses, or other content block types are displayed
- Empty assistant messages (where thinking was the only content) are handled gracefully

## Open Questions

- Are there conversations already stored with thinking content baked into string-format messages (vs. block arrays)? If so, do we need a string-level heuristic to strip them? Yes there are, we dont need to worry about the old conversations though. There arent too many and they are all mine.
- Does the CLI conversation reload path (`cli/src/`) have the same issue, or is this web-only? I havent tested CLI but I would assume so since it queries the database.
- Should there be an admin/debug mode that optionally shows thinking blocks for troubleshooting? no.

## Testing Guidelines

Create test file(s) in the `./test` folder for the new feature, and create meaningful tests for the following cases:

- `conversationToChatMessages` correctly excludes `type: "thinking"` blocks from assistant content arrays
- `conversationToChatMessages` correctly excludes `type: "redacted_thinking"` blocks
- Messages with only thinking blocks produce empty/omitted chat messages
- Messages with mixed content (thinking + text + tool_use) only render the text portion
- Plain string content messages are passed through unchanged
- Tool result messages are unaffected by the filter
