# Spec for Fix Old Web Sessions

branch: claude/feature/fix-old-web-sessions

## Summary

Users cannot resume old web conversations. The Notion issue now includes screenshots showing that even conversations WITH `channel: "web"` set produce an "Error: Session not found" when the user tries to send a message. There are actually two overlapping problems: (1) the listing query excludes conversations missing the `channel` field, and (2) the session store's 30-minute idle timeout rejects conversations that are still persisted in Cosmos DB with a 90-day TTL.

The session store (`CosmosSessionStore.get()`) checks `updatedAt` and returns `undefined` if the conversation has been idle for more than 30 minutes — even though the conversation and all its messages still exist in Cosmos. When the agent route receives a `sessionId` and calls `sessionStore.get()`, it gets `undefined` for any conversation older than 30 minutes, returning a 404 "Session not found" error.

## Functional requirements

- Fix the agent route (`web/app/api/agent/route.ts`) so that when a user sends a message with a `sessionId` that corresponds to an existing Cosmos conversation, it resumes that conversation even if the session has been idle for more than 30 minutes
- When resuming an idle-expired conversation, the agent route should re-load the conversation from Cosmos (bypassing the session store's idle timeout) and create a fresh session with the existing messages
- Fix the conversation listing query in `web/lib/conversation-store.ts` to include conversations where the `channel` field is missing (treating them as web sessions): change the WHERE clause to `(c.channel = @channel OR NOT IS_DEFINED(c.channel))`
- The 30-minute idle timeout should continue to function for its original purpose (session cleanup/garbage collection for the in-memory store), but should NOT block resumption of persisted Cosmos conversations

## Possible Edge Cases

- A conversation idle for 30+ minutes but with a pending confirmation (destructive tool waiting for yes/no) — the confirmation state is stored on the session; on resumption, the pending confirmation should be cleared since the original context is stale
- A conversation owned by a different user — the owner check must still be enforced when re-loading from Cosmos
- A conversation that was deleted from Cosmos but the sidebar cache still has it — should return a clean error, not crash
- Very old conversations with incomplete document shapes (missing `messages`, `updatedAt`, etc.) — handle gracefully
- Conversations without a `channel` field that were actually created by CLI or Teams (unlikely since channel was added at the same time as those features) — no way to distinguish, treat as web

## Acceptance Criteria

- Clicking an old conversation in the sidebar and sending a message resumes the conversation successfully
- Conversations older than 30 minutes can be resumed
- Conversations without a `channel` field appear in the web sidebar
- The "Error: Session not found" no longer occurs for valid Cosmos conversations
- CLI and Teams conversations still do NOT appear in the web sidebar
- In-memory session cleanup still works for active sessions

## Open Questions

- Should the agent route try `sessionStore.get()` first and fall back to `getConversation()` from Cosmos, or should it always load from Cosmos when a sessionId is provided? Fallback approach is simpler and preserves the session cache for active conversations. fallback approach.
- Should the idle timeout in `CosmosSessionStore.get()` be removed entirely (since Cosmos handles TTL), or just bypassed by the agent route? The session store's idle check serves in-memory cleanup — it should stay for the in-memory path but the agent route needs a bypass. bypassed.

## Testing Guidelines

Create test file(s) in the `./test` folder for the new feature, and create meaningful tests for the following cases:

- Session resumption succeeds for conversations that exist in Cosmos but have been idle >30 min
- Conversation listing includes records without a `channel` field when requesting `channel=web`
- Conversation listing excludes records with a different channel (e.g., `channel=cli` when requesting web)
- Owner ID mismatch still returns an appropriate error (not session not found, but forbidden)
