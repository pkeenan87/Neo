# Teams & CLI Conversation Persistence to Cosmos DB

## Context

The Teams bot loses conversation context because the `teams-session-map.ts` bridge (Teams conversationId to Neo sessionId) is stored purely in-memory with a 35-minute TTL. When the map expires, the server restarts, or a different instance handles the request, a new session is created and the bot has amnesia. This plan persists the Teams mapping in a dedicated Cosmos DB container, refactors session resolution to handle both channel threads and DMs correctly, ensures all Teams/CLI messages are written to Cosmos DB immediately, and adds CLI commands to list and resume previous conversations.

---

## Key Design Decisions

- **Separate `teams-mappings` Cosmos DB container** — keeps mapping documents (lightweight, long-lived) separate from conversation documents. Partition key is the Teams `conversationId` for direct point reads.
- **Option B for thread ownership** — use a synthetic owner ID (`teams-thread:<conversationId>`) for channel thread sessions. RBAC is enforced at the channel level; destructive tool confirmations still validate the individual user's `aadObjectId` and role.
- **In-memory cache retained as read-through layer** — `teams-session-map.ts` becomes a cache in front of Cosmos DB, preserving fast-path performance for active conversations while Cosmos DB ensures correctness across restarts.
- **Summarized context on expired session resume** — when a Teams mapping points to an idle-expired session, create a new session seeded with a Claude-generated summary of the prior conversation (not the full message history), then update the mapping. This keeps token usage bounded for long investigations.
- **CLI numbered list for resume** — the `history` command shows a numbered list; `resume N` selects by index rather than requiring full conversation IDs.
- **Immediate message persistence** — Teams and CLI messages are written to Cosmos DB at the point they enter the session (not just at agent response time), ensuring no data loss if the agent loop crashes mid-execution.

---

## Files to Change

| File | Change |
|------|--------|
| `web/lib/types.ts` | Add `TeamsMapping` interface and `TeamsChannelType` type |
| `web/lib/teams-mapping-store.ts` | **New file** — Cosmos DB CRUD for the `teams-mappings` container (create, get, update activity timestamp) |
| `web/lib/teams-session-map.ts` | Refactor from pure in-memory store to a read-through cache backed by `teams-mapping-store.ts`. Retain 35-min in-memory TTL for performance. Add fallback to in-memory-only when Cosmos DB is not configured (mock mode). |
| `web/lib/conversation-store.ts` | Add `getConversationRaw()` function that reads a conversation without idle-timeout filtering (needed for resume-with-summary). Add `createSeededConversation()` that creates a new conversation pre-populated with a summary message. |
| `web/lib/session-store.ts` | Add `getExpired(id): Promise<Session \| undefined>` to the `SessionStore` interface — returns the session even if idle-expired (for resume scenarios). Add corresponding implementation in `InMemorySessionStore`. |
| `web/app/api/teams/messages/route.ts` | Rewrite session resolution logic to: (1) distinguish thread vs DM using `conversation.conversationType`, (2) use the refactored `teams-session-map` for lookup/create, (3) use synthetic owner for threads, (4) persist user message to Cosmos DB immediately after adding to session, (5) handle expired-session resume with summarization. |
| `web/app/api/conversations/route.ts` | No structural changes — already returns conversations for an owner, which the CLI will call. |
| `web/lib/agent.ts` | Add a `summarizeConversation()` helper that takes a message array and returns a condensed summary message suitable for seeding a new session. Uses a single Claude API call with a focused summarization prompt. |
| `web/app/api/agent/route.ts` | Add immediate message persistence: after pushing the user message to `session.messages`, call `sessionStore.saveMessages()` before starting the agent loop. This ensures prompts from web/CLI are written to the database on receipt. |
| `web/lib/stream.ts` | No changes — `writeAgentResult` already persists after the agent response, which will now be an update rather than the initial write. |
| `scripts/provision-cosmos-db.ps1` | Add a step to create the `teams-mappings` container with partition key `/id` and 90-day TTL. |
| `cli/src/index.js` | Add `history` and `resume` commands to the REPL loop. `history` calls `GET /api/conversations` and prints a numbered list. `resume N` selects a conversation by index, sets `sessionId`, and prints a confirmation. |
| `cli/src/server-client.js` | Add `fetchConversations(serverUrl, getAuthHeader)` and `fetchConversation(serverUrl, getAuthHeader, conversationId)` functions for the CLI's history/resume features. |
| `.env.example` | No new variables needed — existing `COSMOS_ENDPOINT` is sufficient. |

---

## Implementation Steps

### 1. Add types for Teams mapping documents

In `web/lib/types.ts`, add:
- `TeamsChannelType` union type: `"thread" | "dm"`
- `TeamsMapping` interface with fields: `id` (Teams conversationId), `sessionId` (Neo session ID), `channelType` (TeamsChannelType), `teamId` (string or null), `createdAt` (string), `lastActivityAt` (string), `ttl` (number, optional)

### 2. Create the Teams mapping store

Create `web/lib/teams-mapping-store.ts` with:
- A `getTeamsMappingsContainer()` function following the same lazy-init pattern as `getContainer()` in `conversation-store.ts`. It should connect to the `teams-mappings` container in the `neo-db` database using the same Cosmos DB client pattern (ManagedIdentityCredential).
- `getTeamsMapping(conversationId: string): Promise<TeamsMapping | null>` — point read using `conversationId` as both the item ID and partition key.
- `createTeamsMapping(mapping: TeamsMapping): Promise<void>` — creates a new mapping document with 90-day TTL.
- `updateTeamsMappingActivity(conversationId: string): Promise<void>` — updates `lastActivityAt` and resets TTL. Use read-then-replace with ETag.
- `updateTeamsMappingSessionId(conversationId: string, newSessionId: string): Promise<void>` — updates the `sessionId` field (used when resuming expired sessions).

### 3. Refactor teams-session-map.ts to a read-through cache

Rewrite `web/lib/teams-session-map.ts`:
- Keep the existing `Map<string, MapEntry>` as an in-memory cache with the same 35-minute TTL and periodic sweep.
- Change `getSessionId(conversationId)` to be async: check in-memory cache first; on miss, call `getTeamsMapping(conversationId)` from the mapping store; on hit, populate cache and return sessionId; on miss, return undefined.
- Change `setSessionId(conversationId, sessionId, channelType, teamId)` to be async: write to Cosmos DB mapping store via `createTeamsMapping()`, then populate the in-memory cache.
- Add `updateSessionId(conversationId, newSessionId)` async function that updates both the Cosmos DB mapping and the in-memory cache (for expired session resume).
- When `env.COSMOS_ENDPOINT` is not set or `env.MOCK_MODE` is true, fall back to pure in-memory behavior (skip Cosmos DB calls). Import `env` from config to check this.
- Update all callers in `messages/route.ts` to use the new async signatures.

### 4. Add getExpired method to SessionStore interface

In `web/lib/session-store.ts`:
- Add `getExpired(id: string): Promise<Session | undefined>` to the `SessionStore` interface. This returns the session even if it has exceeded the idle timeout, as long as the document exists.
- In `InMemorySessionStore`, implement `getExpired` identically to `get` but without the TTL check (just return the session if it exists in the map).

In `web/lib/conversation-store.ts`:
- Add `getExpired(id: string)` to `CosmosSessionStore` that calls `getConversation()` (using `resolveOwner`) and converts to a `Session` without the idle timeout check on line 244-248.

### 5. Add conversation summarization helper

In `web/lib/agent.ts`:
- Add an exported `summarizeConversation(messages: Message[]): Promise<Message[]>` function.
- This function takes the full message history from an expired session and returns a small array containing a single system-injected user message with a summary.
- Implementation: make a single Claude API call (using the existing Anthropic client from the module) with a system prompt like "Summarize the following security investigation conversation in 3-5 bullet points, focusing on: what was investigated, key findings, and any actions taken." Pass the conversation messages as context.
- Return a single-element array: `[{ role: "user", content: "[Conversation resumed] Summary of previous session:\n<summary text>" }]` so it appears naturally in the new session's context.
- Cap the input to the summarization call at the most recent 50 messages to avoid excessive token usage on very long conversations.

### 6. Rewrite Teams session resolution in messages/route.ts

Refactor the session resolution section (currently lines 319-335) in `web/app/api/teams/messages/route.ts`:

**Step 6a: Determine conversation type**
- Check `context.activity.conversation.conversationType`: if it equals `"channel"`, this is a channel thread; otherwise it's a DM (personal chat).
- Extract `conversationId` from `context.activity.conversation.id` (stable for both threads and DMs).

**Step 6b: Look up existing mapping**
- Call the refactored async `getSessionId(conversationId)` which checks in-memory cache then Cosmos DB.

**Step 6c: If mapping exists, validate session**
- Call `sessionStore.get(existingSessionId)` to check if the session is still active (within idle timeout).
- If active: use it. Call `updateTeamsMappingActivity(conversationId)` to refresh the mapping's `lastActivityAt`.
- If expired (returns undefined): call `sessionStore.getExpired(existingSessionId)` to load the full expired session. Call `summarizeConversation(expiredSession.messages)` to get a summary. Determine the owner: for DMs use `aadObjectId`, for threads use `teams-thread:<conversationId>`. Create a new session via `sessionStore.create(role, ownerId, "teams")`, seed it with the summary messages, save immediately. Update the mapping via `updateSessionId(conversationId, newSessionId)`.
- If `getExpired` also returns nothing (document was TTL-deleted from Cosmos): create a completely new session and mapping, same as "no mapping" path.

**Step 6d: If no mapping exists, create new session**
- For DMs: create session with `ownerId = aadObjectId`.
- For threads: create session with `ownerId = "teams-thread:<conversationId>"`.
- Call `setSessionId(conversationId, newSessionId, channelType, teamId)` to persist the mapping.

**Step 6e: Persist user message immediately**
- After `session.messages.push({ role: "user", content: messageText })` and `session.messageCount++`, immediately call `sessionStore.saveMessages(resolvedSessionId, session.messages)` before calling `runAgentLoop`. This ensures the prompt is written to Cosmos DB even if the agent loop crashes.

**Step 6f: Update confirmation gate for threads**
- For channel thread sessions (synthetic owner), the confirmation ownership check on line 265 (`session.ownerId !== submitterAadId`) will always fail because `ownerId` is `teams-thread:...`. Add a check: if `session.ownerId.startsWith("teams-thread:")`, skip the ownership check and instead verify the submitter has the correct role via `canUseTool(role, pendingTool.name)`. The role is determined by `env.TEAMS_BOT_ROLE` (already resolved for all Teams users).

### 7. Add immediate message persistence to web agent route

In `web/app/api/agent/route.ts`, after line 88 (`session.messageCount++`), add:

- A try/catch block that calls `sessionStore.saveMessages(sessionId, session.messages)` to persist the user message to Cosmos DB immediately after it's added to the session.
- Log a warning if this fails but do not block the request — the agent loop's `writeAgentResult` will still persist the full messages including the response.
- This ensures CLI and web prompts are written to the database on receipt, satisfying the spec goal.

### 8. Update provisioning script

In `scripts/provision-cosmos-db.ps1`:
- Add a new parameter `$MappingsContainerName` with default value `"teams-mappings"`.
- After the existing container creation step (step 4/5), add a new step to create the `teams-mappings` container:
  - Partition key path: `/id`
  - TTL: same `$DefaultTtl` (90 days)
  - Follow the same idempotent pattern (check if exists first).
- Update the step counter from `5/5` to `6/6` and renumber accordingly.

### 9. Add CLI history and resume commands

**Step 9a: Add API client functions in `cli/src/server-client.js`**
- Add `fetchConversations(serverUrl, getAuthHeader)`: calls `GET /api/conversations` with auth header, returns the parsed `conversations` array.
- Add `fetchConversation(serverUrl, getAuthHeader, conversationId)`: calls `GET /api/conversations/<id>` with auth header, returns the full conversation object.

**Step 9b: Add commands to the REPL in `cli/src/index.js`**
- Import the new functions from `server-client.js`.
- After the `clear` command handler (line 298-302), add handlers for:
  - `history`: call `fetchConversations`, print a numbered list showing index, title (or "Untitled"), channel, relative timestamp, and message count. Store the list in a module-level variable so `resume` can reference it. If the list is empty, print "No previous conversations found."
  - `resume <N>`: validate N is a valid index from the last `history` call. Get the conversation ID from the stored list. Set `sessionId` to that conversation ID. Print a confirmation: "Resumed conversation: <title>". The next message sent will use this `sessionId` and the server will load the existing session.
- Update the help text on line 65 to mention the new commands: `'history' to list sessions  |  'resume N' to continue one`.

---

## Verification

1. **Teams DM persistence** — Send a message to the bot via Teams DM. Restart the server (or wait >35 minutes for the in-memory cache to expire). Send another message. The bot should maintain full context from the first message.

2. **Teams channel thread persistence** — Create a thread in a Teams channel by messaging the bot. Have a second user reply in the same thread with a follow-up question. The bot should reference context from earlier in the thread. Restart the server and reply again — context should persist.

3. **Immediate message persistence** — Send a message via Teams or CLI. Before the agent responds, check the Cosmos DB `conversations` container — the user message should already be present in the document's messages array.

4. **Expired session resume** — Let a Teams conversation idle for >30 minutes. Send a new message. Verify a new session is created with a summary of the prior conversation, and the bot responds with awareness of prior context (summarized, not full history).

5. **CLI history/resume** — Run the CLI, send a few messages to create a conversation. Exit and restart the CLI. Run `history` — the previous conversation should appear. Run `resume 1` — the `sessionId` should be set. Send a follow-up message — the bot should have context from the previous conversation.

6. **Mock mode fallback** — Set `MOCK_MODE=true` and ensure `COSMOS_ENDPOINT` is unset. Verify Teams session resolution falls back to pure in-memory behavior without errors. Verify CLI `history` returns an empty list gracefully.

7. **Provisioning script** — Run `provision-cosmos-db.ps1` against a test Azure subscription. Verify both the `conversations` and `teams-mappings` containers are created with correct partition keys and TTL settings. Run again to confirm idempotency.

8. **Confirmation gate in threads** — In a channel thread, trigger a destructive action. Verify the Adaptive Card appears. Have the same user (or different user with correct role) confirm — it should succeed. Verify that the synthetic `teams-thread:` owner doesn't block confirmations.

9. **Build check** — Run `cd web && npm run build` to verify TypeScript compilation succeeds with all new types and async signature changes.
