# Spec for Fix Database Message Persistence

branch: claude/feature/fix-database-persistence

## Summary

Conversations saved to Cosmos DB are missing assistant responses and tool call blocks. The database shows `messageCount: 1` with only the initial user message, even though the agent loop completed successfully. When users revisit old chats, they see only their prompt — the agent's response, tool calls, and tool results are lost.

Root cause: the agent loop runs inside a detached async IIFE in the API route. If the NDJSON stream disconnects (user navigates away, browser closes, network interruption) or the agent loop throws an error, the `catch` block does NOT call `saveMessages` with whatever messages were accumulated before the failure. The user message is saved eagerly on receipt, but the full conversation (including assistant responses) is only saved in the happy path at the end of `writeAgentResult`.

## Functional Requirements

### Fix 1: Save messages in the error path
- In the `catch` block of the agent loop async IIFE in `web/app/api/agent/route.ts`, attempt to save the current `session.messages` to Cosmos DB before writing the error event to the stream
- If `result` is available (i.e., the agent loop completed but post-processing failed), save `result.messages` instead since that's the complete conversation
- This ensures that even partial conversations are preserved when errors occur

### Fix 2: Save messages after each agent loop turn
- After each turn of the agent loop (each time the loop calls Claude and gets a response), persist the accumulated messages to the session store
- This ensures that multi-turn conversations (where the agent calls tools, gets results, then responds) don't lose intermediate state if the connection drops mid-turn
- Add an `onTurnComplete` callback to the agent loop that triggers a save after each assistant response is added to messages

### Fix 3: Save messages on stream disconnect
- Detect when the NDJSON stream connection is closed by the client (user navigated away) and trigger a final save of whatever messages have been accumulated
- Use the `WritableStream`'s abort signal or try/catch on `writer.write` to detect disconnection
- This is the most common failure mode: the user sends a message, the agent processes it, but the user navigates away before the response finishes streaming

## Possible Edge Cases

- Race condition: if the client disconnects mid-save, the Cosmos DB write may partially complete — Cosmos DB's atomic document replacement prevents partial writes, so this is safe
- The `session.messages` object reference vs. `localMessages` in agent.ts: `runAgentLoop` creates its own `localMessages` copy, so the session object's messages array may not include intermediate tool calls. The fix needs to use `result.messages` from the agent loop return value, not `session.messages`
- Very long conversations with many tool calls may accumulate large message arrays — per-turn saves add database write overhead but Cosmos DB handles this well
- Concurrent saves from the same session (e.g., if the user sends another message while a previous one is still processing) — the session store already handles this via atomic replace operations

## Acceptance Criteria

- [ ] When the agent loop completes successfully, all messages (user + assistant + tool calls + tool results) are persisted to Cosmos DB
- [ ] When the agent loop throws an error, available messages are still saved to Cosmos DB before the error is written to the stream
- [ ] When the client disconnects mid-stream, accumulated messages are saved
- [ ] Existing conversation reload works correctly — users see complete chat history in old conversations
- [ ] No regression in the happy path (messages still save correctly for normal conversations)
- [ ] `messageCount` in Cosmos DB accurately reflects the number of messages in the array

## Open Questions

- Should we add a periodic save during long-running agent loops (e.g., every N turns) or is saving on each turn sufficient? each turn.
- Should the error-path save be best-effort (fire-and-forget) or should we await it before writing the error event? fire and forget

## Testing Guidelines

Create test files in `./test/` to verify:

- Messages are persisted correctly after a normal agent loop completion
- Messages are persisted in the error path when the agent loop throws
- `messageCount` matches `messages.length` after each save
- Session messages include both user and assistant messages after a full conversation
