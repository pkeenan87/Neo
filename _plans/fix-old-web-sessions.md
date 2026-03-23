# Fix Old Web Sessions

## Context

Users cannot resume web conversations older than 30 minutes. The `CosmosSessionStore.get()` method enforces a 30-minute idle timeout that returns `undefined` even though the conversation is safely persisted in Cosmos DB with a 90-day TTL. The agent route treats this as "Session not found" and returns a 404. Additionally, the conversation listing query excludes documents without a `channel` field, hiding pre-channel-era conversations from the sidebar. The session store already has a `getExpired()` method that bypasses the idle timeout — the agent route just needs to use it as a fallback.

---

## Key Design Decisions

- **Fallback approach, not removal** — the agent route tries `sessionStore.get()` first (preserving the active-session cache benefits), then falls back to `sessionStore.getExpired()` for idle-expired sessions. The 30-minute idle timeout stays in `get()` for the in-memory store's sweep cleanup.
- **`getExpired()` already exists** — both `CosmosSessionStore` and `InMemorySessionStore` implement `getExpired(id)` which returns sessions regardless of idle timeout. No new session store methods needed.
- **Channel filter fix uses `NOT IS_DEFINED`** — Cosmos DB SQL supports `NOT IS_DEFINED(c.channel)` to match documents where the field is absent, treating them as web sessions.

---

## Files to Change

| File | Change |
|------|--------|
| `web/app/api/agent/route.ts` | Change session lookup to fall back to `getExpired()` when `get()` returns undefined |
| `web/lib/conversation-store.ts` | Fix `listConversations()` SQL query to include documents where `channel` is not defined |
| `test/fix-old-web-sessions.test.js` | New test file for session fallback logic and channel filter logic |

---

## Implementation Steps

### 1. Fix session resumption in `web/app/api/agent/route.ts`

- At lines 92-96, change the session lookup logic: when `body.sessionId` is provided and `sessionStore.get(body.sessionId)` returns `undefined`, try `sessionStore.getExpired(body.sessionId)` as a fallback
- Only return 404 "Session not found" if BOTH `get()` AND `getExpired()` return `undefined`
- Use the session from whichever call succeeded for the owner check and role assignment
- This handles the case where a Cosmos conversation exists but the 30-minute idle timeout rejected it

### 2. Fix channel filter in `web/lib/conversation-store.ts`

- In `listConversations()` at lines 100-106, change the channel-filtered SQL query from `c.channel = @channel` to `(c.channel = @channel OR NOT IS_DEFINED(c.channel))`
- This ensures old conversations without a channel field appear in the web sidebar (since all pre-channel conversations were web sessions)
- The unfiltered query (when `channel` is undefined) stays as-is

### 3. Write tests in `test/fix-old-web-sessions.test.js`

- Test the fallback logic: replicate the get/getExpired pattern and verify that when get() returns undefined but getExpired() returns a session, the fallback succeeds
- Test the channel filter logic: verify that the SQL WHERE clause pattern includes documents matching the channel AND documents where channel is not defined
- Test that sessions with a different owner still get a 403 (not a false resumption)

---

## Verification

1. Run `node --experimental-strip-types --test test/fix-old-web-sessions.test.js` — all tests pass
2. Run `cd web && npx next build` — build succeeds
3. Deploy and click an old conversation in the sidebar — verify it loads and messages can be sent
4. Verify the sidebar shows old conversations that previously were hidden
5. Verify CLI/Teams conversations still do not appear in the web sidebar
