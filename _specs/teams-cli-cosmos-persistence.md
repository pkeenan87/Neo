# Teams & CLI Conversation Persistence to Cosmos DB

> Persist the Teams conversation-to-session mapping in Cosmos DB and fix session resolution so that Teams channel threads and DMs maintain full conversation context across server restarts, deployments, and idle-timeout boundaries.

## Problem

The Teams bot currently suffers from "amnesia" — it loses conversation context mid-conversation. The root cause is that the `teams-session-map.ts` bridge (Teams conversationId → Neo sessionId) is stored entirely in-memory with a 35-minute TTL. When the in-memory map entry expires, the server restarts, or a new instance handles the request, the mapping is lost. The bot creates a fresh session and responds as if no prior conversation happened (as seen in the screenshot: "I haven't run any KQL queries yet in our conversation — this is the start of our session together" despite having provided analysis moments earlier).

There are two distinct Teams messaging patterns that need correct session resolution:

1. **Channel threads** — Messages posted in a shared channel use a threaded layout. Multiple users may reply to the same thread. The bot must maintain context across all replies within a single thread, regardless of which user is replying. The Teams `conversation.id` for thread replies includes the parent message ID, which can be used as a stable key.

2. **Direct messages (1:1)** — A user DMs the bot directly. The `conversation.id` is stable for the lifetime of the 1:1 chat, but the in-memory map still loses the mapping on restart or expiry. The bot must resume the existing session for that user's DM conversation.

Additionally, the CLI stores its `sessionId` only in the REPL variable — if the CLI process exits and restarts, the user starts a new session with no way to resume a previous conversation. While the CLI sessions are persisted to Cosmos DB (when configured), there is no mechanism to list or resume previous CLI conversations.

## Goals

- Persist the Teams conversationId → Neo sessionId mapping in Cosmos DB so it survives server restarts, deployments, and multi-instance scaling
- Correctly resolve sessions for Teams channel threads — all replies in a thread share one session
- Correctly resolve sessions for Teams 1:1 DMs — the user's DM conversation maintains continuity
- Allow multiple users to participate in a channel thread while maintaining shared context
- Remove the in-memory `teams-session-map.ts` as the source of truth (Cosmos DB becomes authoritative; in-memory can remain as a cache layer)
- Add a CLI command to list and resume previous conversations from Cosmos DB
- Ensure graceful fallback when Cosmos DB is unavailable (clear error, not silent data loss)
- ensure prompts from teams and the cli are written to the databases after they are received

## Non-Goals

- Cross-channel conversation continuity (a Teams thread and a web session remain separate conversations)
- Full-text search across Teams conversation history
- Storing Teams Adaptive Card interactions (approve/deny) as conversation messages
- Migrating existing in-memory sessions to Cosmos DB on upgrade
- Teams proactive messaging or notifications outside of reply context
- Building a Teams-specific conversation history UI (Teams native chat history serves this purpose)
- Changing the web app's session resolution — it already works correctly with Cosmos DB

## User Stories

1. **As a SOC analyst using Teams DMs**, I can ask the bot a question, close Teams, reopen it hours later, and continue the conversation with full context — the bot remembers what tools it ran and what we discussed.
2. **As a SOC analyst in a Teams channel**, I can start a thread by messaging the bot, and any colleague can reply in that thread to ask follow-up questions — the bot maintains context from the entire thread.
3. **As a SOC analyst in a Teams channel thread**, when I ask the bot to reference something it found earlier in the thread, it can do so because all thread messages share a single session.
4. **As a platform admin**, I can deploy a new version of the server or scale to multiple instances without Teams users losing their conversation context.
5. **As a CLI user**, I can run a command to list my recent conversations and resume one by ID, so I can pick up where I left off after restarting the CLI.
6. **As a developer**, I can run the application in `MOCK_MODE=true` and Teams session resolution falls back to the existing in-memory map, so local development works without Cosmos DB.

## Design Considerations

### Teams Session Resolution: Channel Threads

In Teams, when a message is posted in a channel thread, the `conversation.id` from `context.activity.conversation` includes the parent message ID (e.g., `19:channel-id@thread.tacv2;messageid=1234567890`). This is stable across all replies in the thread.

The session resolution logic should:

1. Extract the thread-level conversation key from `context.activity.conversation.id`
2. Look up the key in a Cosmos DB mapping collection
3. If found, load the existing Neo session
4. If not found, create a new Neo session and persist the mapping

For channel threads, the `ownerId` on the session should represent the thread (not an individual user), since multiple users participate. Consider using the channel thread conversation ID itself as the owner, or a synthetic owner like `thread:<conversationId>`. Individual user identity is still checked for confirmation gates (destructive actions).

### Teams Session Resolution: Direct Messages

For 1:1 DMs, the `conversation.id` is stable for the user-bot pair (e.g., `a]:<user-id>`). The mapping is simpler:

1. Look up the DM conversation ID in the Cosmos DB mapping collection
2. If found, load the existing session
3. If not found, create a new session owned by the user's `aadObjectId`

### Cosmos DB Mapping Collection

Add a new container (or document type within the existing `conversations` container) to store Teams conversation mappings:

- `id` — the Teams conversation ID (stable, unique per thread or DM)
- `sessionId` — the corresponding Neo session ID
- `channelType` — `"thread"` or `"dm"` (for debugging/queries)
- `teamId` — the Teams team ID (for thread messages, useful for audit)
- `createdAt` — ISO 8601 timestamp
- `lastActivityAt` — ISO 8601 timestamp, updated on each message
- `ttl` — long TTL (e.g., 90 days, matching conversation history TTL) since this is a lightweight lookup document

Partition key: `id` (the Teams conversation ID) for direct point reads.

### In-Memory Cache Layer

The current `teams-session-map.ts` can be repurposed as a read-through cache:

1. On message receipt, check in-memory cache first (fast path)
2. On cache miss, query Cosmos DB mapping collection
3. On Cosmos DB hit, populate cache and proceed
4. On Cosmos DB miss, create new session, persist mapping, populate cache
5. Cache entries still expire after 35 minutes (performance optimization, not correctness requirement)

This preserves the performance benefit of in-memory lookups for active conversations while ensuring correctness is backed by Cosmos DB.

### Thread Participation and Ownership

Channel threads introduce a multi-user scenario. The session `ownerId` can't be a single user because multiple analysts may reply. Options:

- **Option A**: Use the thread initiator's `aadObjectId` as owner, and maintain an `allowedParticipants` list. Any user who has posted in the thread is added to the list and can interact.
- **Option B**: Use a synthetic owner ID (e.g., `teams-thread:<conversationId>`) and skip ownership checks for non-destructive tools. Destructive tool confirmations still validate the individual user's role via their `aadObjectId`.

Option B is simpler and aligns with Teams' collaborative model — anyone in the channel can see and reply to the thread. Destructive actions are gated by role, not by session ownership.

### CLI Conversation Resume

Add two CLI capabilities:

1. **`history` command** — Lists the user's recent conversations (calls `GET /api/conversations` with auth token). Shows conversation ID, title, timestamp, and channel.
2. **`resume <id>` command** — Sets the CLI's `sessionId` to the given conversation ID, loads its messages from the server, and continues from where it left off.

This requires the CLI to authenticate against the web API (already supported via `server-client.js` token injection).

### Session Idle Timeout vs. Conversation Resume

Currently, `CosmosSessionStore.get()` returns `undefined` if the session's idle timeout (30 minutes) has passed. For Teams and CLI resume scenarios, the conversation document still exists in Cosmos DB (90-day TTL), but the session is considered "expired" for active use.

When resuming an expired session:

- Load the conversation's message history for context
- Create a new session (new 30-minute idle window) but seed it with the prior messages
- Update the Teams mapping to point to the new session ID
- This preserves context while maintaining the idle timeout security boundary

### Environment Variables

No new environment variables required — the existing Cosmos DB configuration (`COSMOS_ENDPOINT`, `COSMOS_DB_DATABASE_NAME`) is sufficient. The mapping collection can be created alongside the existing `conversations` container.

## Key Files

- `web/lib/teams-session-map.ts` — Refactor from pure in-memory to read-through cache backed by Cosmos DB
- `web/lib/conversation-store.ts` — Add CRUD functions for Teams conversation mapping documents (or a new `teams-mapping-store.ts`)
- `web/app/api/teams/messages/route.ts` — Update session resolution to use Cosmos-backed mapping with thread vs. DM logic
- `web/lib/session-store.ts` — Consider adding a `resumeExpired(id)` method to the interface for loading expired sessions with fresh idle windows
- `web/lib/types.ts` — Add `TeamsMapping` type, update `Channel` if needed
- `cli/src/index.js` — Add `history` and `resume` commands to the REPL
- `cli/src/server-client.js` — Add function to fetch conversation list and conversation by ID
- `scripts/provision-cosmos-db.ps1` — Add teams-mappings container to provisioning (if using a separate container)
- `.env.example` — No changes expected

## Open Questions

1. Should channel thread sessions use a synthetic owner (Option B above) or track individual participants (Option A)? Option B is simpler but means any channel member could theoretically interact with the bot in any thread — is that acceptable from a security perspective? yes that is acceptable. RBAC is enforced at the channel level.
2. When resuming an expired session, should the full message history be loaded into context, or should it be summarized/truncated to stay within token limits? Long investigations could have very large message arrays. summarized.
3. Should the Teams mapping container be a separate Cosmos DB container (`teams-mappings`) or a document type within the existing `conversations` container (discriminated by a `type` field)? separate container
4. For the CLI `resume` command, should the user need to provide the full conversation ID, or should the CLI support selecting from a numbered list (e.g., `resume 3` to pick the third most recent conversation)? numbered list
5. Should the bot send a message in Teams when it detects a resumed session (e.g., "Resuming previous conversation...") to make the context continuity visible to the user? no
