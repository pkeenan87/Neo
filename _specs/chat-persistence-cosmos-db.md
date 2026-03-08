# Chat Persistence with Azure Cosmos DB

> Replace the in-memory session store with Azure Cosmos DB so chat conversations survive server restarts, support multi-instance deployments, and give users access to their conversation history.

## Problem

All Neo chat sessions and message history are stored in an in-memory Map within the Node.js process. This means every conversation is lost on server restart, deployment, or crash. Users cannot return to a previous conversation, there is no audit trail of past interactions, and the application cannot scale to multiple instances because session state is not shared. For a security operations tool where analysts may need to reference prior investigation context, this is a critical gap.

## Goals

- Persist all chat sessions and their full message history to Azure Cosmos DB
- Allow users to resume previous conversations from the sidebar
- Support multi-instance deployments by removing all in-memory session state
- Maintain the existing 30-minute idle timeout with TTL-based expiration in Cosmos DB
- Preserve the existing RBAC model — users can only access their own sessions
- Provide a PowerShell provisioning script for the Cosmos DB infrastructure
- Graceful degradation — if Cosmos DB is unreachable, the application should surface a clear error rather than silently losing data

## Non-Goals

- Full-text search across conversation history (future enhancement)
- Exporting or sharing conversations between users
- Storing LLM token usage or cost tracking per conversation
- Migrating the Teams session map (`teams-session-map.ts`) to Cosmos DB — that remains in-memory for now
- Building a conversation analytics or reporting dashboard
- Message editing or deletion by users

## User Stories

1. **As a SOC analyst**, I can close my browser and reopen the chat later to find my previous conversations in the sidebar, so I don't lose investigation context.
2. **As a SOC analyst**, I can click on a previous conversation in the sidebar to reload its full message history, so I can continue where I left off.
3. **As a SOC analyst**, I can start a new conversation while keeping my previous ones accessible, so I can work on multiple investigations.
4. **As a platform admin**, I can run a single PowerShell script to provision the Cosmos DB account, database, and container needed for chat persistence.
5. **As a platform admin**, I can configure the idle timeout via environment variable so sessions expire based on organizational policy.
6. **As a developer**, I can run the application in `MOCK_MODE=true` without Cosmos DB credentials and have sessions fall back to in-memory storage, so local development works without Azure infrastructure.

## Design Considerations

### Data Model

Each session document in Cosmos DB should contain:

- `id` — the session UUID (existing format)
- `ownerId` — the user identity (partition key, ensures data isolation and efficient queries)
- `role` — the user's RBAC role at session creation time
- `title` — a short summary of the conversation (derived from the first user message or auto-generated)
- `messages` — the full array of Anthropic `MessageParam` objects
- `messageCount` — for rate limiting
- `pendingConfirmation` — the pending destructive tool confirmation state (if any)
- `createdAt` — ISO 8601 timestamp
- `lastActivityAt` — ISO 8601 timestamp, updated on each interaction
- `ttl` — Cosmos DB's built-in TTL field in seconds, set based on idle timeout

### Partition Strategy

Partition by `ownerId`. This ensures:

- All queries for a user's sessions hit a single logical partition (efficient)
- Users cannot access other users' data (natural data isolation)
- Rate limiting remains per-session, read from the document's `messageCount`

### TTL and Expiration

Cosmos DB supports document-level TTL. Set `ttl` to the configured idle timeout (default 1800 seconds / 30 minutes). On each interaction, update `lastActivityAt` and reset `ttl`. Cosmos DB automatically deletes expired documents — no sweeper needed.

Consider a separate longer TTL for conversation history (e.g., 30 days) versus the active session timeout. The idle timeout controls when a session can no longer accept new messages, but the document could persist longer for history access.

### Session Store Abstraction

Replace the current concrete `SessionStore` class with an interface, then provide two implementations:

- `CosmosSessionStore` — production implementation backed by Cosmos DB
- `InMemorySessionStore` — current implementation, used when `MOCK_MODE=true` or Cosmos DB credentials are not configured

The store used at runtime is determined by environment configuration. All consumers (`agent.ts`, `route.ts`, `confirm/route.ts`, `sessions/route.ts`) continue to call the same interface — no changes needed in those files beyond importing the factory.

### ChatInterface Integration

The frontend `ChatInterface` component needs to:

- Fetch the user's conversation list on mount (for the sidebar)
- Load full message history when a conversation is selected
- Send messages to the existing `/api/agent` endpoint (which now persists to Cosmos DB)
- Create new conversations via a "New Operation" button (already in the UI)
- Show conversation titles in the sidebar (replacing the hardcoded `RECENT_LOGS`)

### Sidebar Conversation List

The sidebar currently shows hardcoded `RECENT_LOGS`. Replace this with a live list of the user's recent conversations fetched from a new API endpoint. Each item shows the conversation title and a relative timestamp. Clicking loads that conversation's messages into the chat area.

### Conversation Titles

Auto-generate a title from the first user message (truncated to ~50 characters). This avoids requiring the user to name conversations manually. A future enhancement could use the LLM to generate a smarter summary title.

### Provisioning Script

A new PowerShell script (`scripts/provision-cosmos-db.ps1`) should create:

- **Cosmos DB Account** — with serverless capacity mode for cost efficiency at low-to-moderate volume
- **Database** — named `neo` (or configurable)
- **Container** — named `sessions` with `ownerId` as partition key and TTL enabled
- **Connection string** — output for `.env` configuration

The script should follow the patterns of `scripts/provision-azure.ps1` and `scripts/provision-event-hub.ps1`: parameterized, idempotent, validates prerequisites.

### Environment Variables

New variables needed:

- `COSMOS_DB_CONNECTION_STRING` — connection string for the Cosmos DB account
- `COSMOS_DB_DATABASE_NAME` — database name (default: `neo`)
- `COSMOS_DB_CONTAINER_NAME` — container name (default: `sessions`)
- `SESSION_TTL_SECONDS` — idle timeout in seconds (default: `1800`)
- `SESSION_HISTORY_TTL_SECONDS` — how long to keep conversation history accessible after idle expiry (default: `2592000` / 30 days)

## Key Files

- `web/lib/session-store.ts` — Refactor to interface + in-memory implementation
- `web/lib/cosmos-session-store.ts` — New Cosmos DB session store implementation
- `web/lib/session-factory.ts` — Factory that returns the correct store based on environment
- `web/components/ChatInterface/ChatInterface.tsx` — Wire up sidebar with real conversation list, load/create conversations
- `web/app/api/agent/sessions/route.ts` — Extend to support listing conversations with titles
- `web/app/api/agent/route.ts` — No changes expected (uses session store interface)
- `scripts/provision-cosmos-db.ps1` — Cosmos DB provisioning script
- `web/lib/config.ts` — Add new env vars
- `web/lib/types.ts` — Extend `EnvConfig` with new env vars
- `.env.example` — Document new env vars

## Open Questions

1. Should conversation history have a separate, longer TTL than the active session idle timeout? For example, 30 minutes idle timeout for active sessions but 30 days for browsing history. This affects whether users can return to old conversations days later. Yes. Please reference ../staging/neo-chat-persistence-recommendation.md
2. Should the "New Operation" button create an empty session immediately, or only when the first message is sent? Creating on first message avoids empty session documents. only when first message is sent.
3. What is the maximum number of conversations to show in the sidebar? Should there be pagination or infinite scroll, or is a fixed limit (e.g., 50 most recent) sufficient? 50 most recent with scrolling.
4. Should the Cosmos DB account use serverless or provisioned throughput? Serverless is cheaper for low-to-moderate traffic but has a 1MB document size limit and 5000 RU/s burst limit. Please reference ../staging/neo-chat-persistence-recommendation.md
5. Should conversation titles be editable by the user, or always auto-generated? editable
