# Chat Persistence with Azure Cosmos DB

## Context

This plan replaces the in-memory `SessionStore` with Azure Cosmos DB (NoSQL, serverless tier) so chat conversations survive server restarts, support multi-instance deployments, and allow users to browse/resume past conversations from the sidebar. The implementation follows the architecture recommendation in `staging/neo-chat-persistence-recommendation.md`: a single `conversations` container partitioned by `ownerId`, Managed Identity auth (no connection strings), auto-TTL expiration, and a `conversation-store.ts` module that provides CRUD operations. The existing in-memory store is retained as a fallback for `MOCK_MODE=true` development.

---

## Key Design Decisions

- **Cosmos DB serverless tier** — at expected SOC team volume (5–30 analysts), cost is under $1/month. No idle charges. Serverless has a 2MB document limit which comfortably fits even 200-message conversations with tool results (~200KB typical).
- **Single document per conversation** — every conversation load is a 1 RU point-read. No fan-out across message sub-documents. If a conversation ever approaches 2MB (extremely unlikely), splitting can be addressed then.
- **Partition key: `/ownerId`** — all queries are user-scoped (sidebar list, conversation load). Single-partition operations are cheapest and fastest. Natural data isolation.
- **Managed Identity auth** — `DefaultAzureCredential` from `@azure/identity`. No `COSMOS_DB_CONNECTION_STRING` in env vars. Uses Managed Identity in Azure, VS Code/CLI credentials locally. Single env var: `COSMOS_ENDPOINT`.
- **Dual TTL strategy** — active session idle timeout (30 minutes, controlled by application logic) determines when a session can no longer accept new messages. Document TTL (90 days) controls when Cosmos auto-deletes the document. Users can browse history for 90 days.
- **Lazy session creation** — "New Operation" button does not create a Cosmos document. The document is created only when the first message is sent, avoiding empty session clutter.
- **Auto-generated titles with edit support** — after the first assistant response, a lightweight Claude Haiku call generates a title asynchronously. Users can rename via PATCH endpoint.
- **In-memory fallback** — when `MOCK_MODE=true` or `COSMOS_ENDPOINT` is not set, the existing `InMemorySessionStore` is used. No Azure infrastructure needed for local development.
- **Session store interface abstraction** — extract a `SessionStore` interface from the current class, then provide `CosmosSessionStore` and `InMemorySessionStore` implementations. All consumers import from a factory module.
- **Rename `Session` to `Conversation` in Cosmos layer** — the Cosmos document type is `Conversation` (with `title`, `channel`, `updatedAt`). The in-memory hot cache during streaming keeps the existing `Session` shape for backward compatibility with the agent loop.
- **New API routes under `/api/conversations`** — separate from the existing `/api/agent/sessions` endpoint. The sessions endpoint is kept for backward compatibility but delegates to the same store.

---

## Files to Change

| File | Change |
|------|--------|
| `web/lib/types.ts` | Add `Conversation`, `ConversationMeta`, and `Channel` types. Add `COSMOS_ENDPOINT` to `EnvConfig`. |
| `web/lib/config.ts` | Add `COSMOS_ENDPOINT` env var to `env` object and validation. |
| `web/lib/session-store.ts` | Extract `SessionStore` interface. Rename class to `InMemorySessionStore`. Export both. Keep existing sweeper logic unchanged. |
| `web/lib/conversation-store.ts` | **New** — Cosmos DB CRUD module: `createConversation`, `getConversation`, `listConversations`, `appendMessages`, `updateTitle`, `deleteConversation`, `setPendingConfirmation`, `clearPendingConfirmation`, `isRateLimited`. |
| `web/lib/session-factory.ts` | **New** — factory function that returns `CosmosSessionStore` or `InMemorySessionStore` based on env config. Exports singleton `sessionStore`. |
| `web/lib/title-generator.ts` | **New** — async function that calls Claude Haiku to generate a short conversation title from the first user message and first assistant response. |
| `web/app/api/agent/route.ts` | Replace `import { sessionStore }` from `session-store` with import from `session-factory`. Add post-stream Cosmos write-back. On new conversation, defer creation until first message. After first assistant response, trigger async title generation. |
| `web/app/api/agent/confirm/route.ts` | Replace session store import with factory. Add Cosmos write-back after confirmation result. |
| `web/app/api/agent/sessions/route.ts` | Replace session store import with factory. Delegate to same interface. |
| `web/app/api/teams/messages/route.ts` | Replace session store import with factory. Add Cosmos write-back after agent result and confirmation flows. |
| `web/app/api/conversations/route.ts` | **New** — `GET` lists user's conversations (50 most recent). Returns `ConversationMeta[]`. |
| `web/app/api/conversations/[id]/route.ts` | **New** — `GET` loads full conversation. `DELETE` removes conversation. `PATCH` renames title. All enforce ownership. |
| `web/components/ChatInterface/ChatInterface.tsx` | Replace hardcoded `RECENT_LOGS` sidebar with live conversation list fetched from `/api/conversations`. Add conversation selection, new conversation creation, title display, and API integration for sending messages via `/api/agent`. |
| `web/components/ChatInterface/ChatInterface.module.css` | Add styles for conversation list items (active state, timestamp, editable title). |
| `web/app/chat/page.tsx` | Pass initial conversation list (fetched server-side) to `ChatPageClient` as a prop. |
| `web/app/chat/ChatPageClient.tsx` | Accept and forward conversation list prop to `ChatInterface`. |
| `web/package.json` | Add `@azure/cosmos` and `@azure/identity` dependencies. |
| `web/next.config.js` | Add `"@azure/cosmos"` and `"@azure/identity"` to `serverExternalPackages`. |
| `.env.example` | Add `COSMOS_ENDPOINT` with comment. |
| `scripts/provision-cosmos-db.ps1` | **New** — PowerShell script to create Cosmos DB account (serverless), database (`neo-db`), container (`conversations` with `/ownerId` partition key and 90-day default TTL), and Managed Identity role assignment. |

---

## Implementation Steps

### 1. Install dependencies and update config

- Run `cd web && npm install @azure/cosmos @azure/identity`
- Add `"@azure/cosmos"` and `"@azure/identity"` to the `serverExternalPackages` array in `web/next.config.js`
- Add `COSMOS_ENDPOINT: string | undefined` to the `EnvConfig` interface in `web/lib/types.ts`
- Add `COSMOS_ENDPOINT: process.env.COSMOS_ENDPOINT` to the `env` object in `web/lib/config.ts`
- Add `COSMOS_ENDPOINT=` to `.env.example` under a new `# Cosmos DB (chat persistence)` section

### 2. Define Conversation types

In `web/lib/types.ts`, add:

- `Channel` type: `"web" | "cli" | "teams"`
- `Conversation` interface with fields: `id` (string, prefixed `conv_`), `ownerId` (string), `title` (string or null), `createdAt` (string, ISO 8601), `updatedAt` (string, ISO 8601), `messageCount` (number), `role` (Role), `channel` (Channel), `messages` (Message[]), `pendingConfirmation` (PendingTool or null), `ttl` (number, optional)
- `ConversationMeta` type: `Omit<Conversation, "messages" | "pendingConfirmation">`

### 3. Extract SessionStore interface

In `web/lib/session-store.ts`:

- Define a `SessionStore` interface with all public methods of the current class: `create`, `get`, `delete`, `list`, `listForOwner`, `setPendingConfirmation`, `clearPendingConfirmation`, `isRateLimited`
- Rename the existing `SessionStore` class to `InMemorySessionStore` implementing the interface
- Export both the interface and the class
- Remove the module-level `sessionStore` singleton export (moved to factory)

### 4. Create conversation-store.ts

New file `web/lib/conversation-store.ts`:

- Initialize `CosmosClient` using `DefaultAzureCredential` from `@azure/identity` and `COSMOS_ENDPOINT` from config
- Get a reference to the `neo-db` database and `conversations` container
- Implement `createConversation(ownerId, role, channel)`: generate `conv_` prefixed UUID, create document with null title, empty messages, current timestamps, 90-day TTL. Return the ID.
- Implement `getConversation(id, ownerId)`: point-read by id and partition key. Return null on 404.
- Implement `listConversations(ownerId)`: parameterized query selecting metadata fields only (no messages), ordered by `updatedAt` descending, limited to 50. Return `ConversationMeta[]`.
- Implement `appendMessages(id, ownerId, newMessages, title?)`: read-then-replace pattern. Push new messages, update `messageCount`, `updatedAt`, and optionally set `title` if currently null.
- Implement `updateTitle(id, ownerId, title)`: partial update of `title` and `updatedAt` fields.
- Implement `deleteConversation(id, ownerId)`: delete by id and partition key.
- Implement `setPendingConfirmation(id, ownerId, tool)`: read-then-replace, set `pendingConfirmation` field.
- Implement `clearPendingConfirmation(id, ownerId)`: read-then-replace, return the old `PendingTool` and set field to null.
- Implement `isRateLimited(id, ownerId)`: point-read, check `messageCount` against `RATE_LIMITS[doc.role]`.

### 5. Create CosmosSessionStore adapter

Within `web/lib/conversation-store.ts` (or a separate file), create a `CosmosSessionStore` class that implements the `SessionStore` interface by delegating to the conversation-store functions. This adapter bridges the existing `Session`-shaped interface expected by the agent routes with the `Conversation`-shaped Cosmos documents:

- `create(role, ownerId)` → calls `createConversation(ownerId, role, "web")`
- `get(id)` → calls `getConversation(id, ownerId)`, converts `Conversation` to `Session` shape (Date objects for timestamps, etc). Checks idle timeout (30 minutes from `updatedAt`). Returns undefined if expired.
- `delete(id)` → calls `deleteConversation(id, ownerId)`
- `list()` / `listForOwner(ownerId)` → calls `listConversations(ownerId)`, maps to `SessionMeta[]`
- `setPendingConfirmation` / `clearPendingConfirmation` / `isRateLimited` → delegate to corresponding conversation-store functions

The adapter needs the `ownerId` for Cosmos partition key reads. Since the current `SessionStore` interface methods like `get(id)` don't take `ownerId`, the adapter must either: (a) do a cross-partition query by id (slightly more expensive but works), or (b) maintain a lightweight in-memory id→ownerId cache populated on create/get. Option (a) is simpler and acceptable at this scale.

### 6. Create session-factory.ts

New file `web/lib/session-factory.ts`:

- Import `InMemorySessionStore` from `session-store` and `CosmosSessionStore` from `conversation-store`
- Import `env` from `config`
- If `env.COSMOS_ENDPOINT` is set and `env.MOCK_MODE` is not `"true"`, instantiate and export `CosmosSessionStore`
- Otherwise, instantiate and export `InMemorySessionStore` with a console warning that Cosmos DB is not configured
- Export as `sessionStore` (same name as before, so imports in route files just change path)

### 7. Create title-generator.ts

New file `web/lib/title-generator.ts`:

- Export an async function `generateTitle(firstUserMessage: string, firstAssistantResponse: string): Promise<string>`
- Call Claude Haiku (`claude-haiku-4-5-20250414`) with max_tokens 30
- Prompt asks for a short title (max 8 words) for a SOC analyst conversation, returning only the title text
- On failure, return `"New conversation"` as fallback
- This function is called asynchronously (fire-and-forget with error logging) — never blocks the user's response stream

### 8. Update agent route

In `web/app/api/agent/route.ts`:

- Change session store import to `import { sessionStore } from "@/lib/session-factory"`
- After the streaming response completes (after `writeAgentResult`), if the store is Cosmos-backed, the write-back happens automatically through the adapter's mutation tracking
- For new conversations (no `sessionId` in request), create the session only when the first message is sent (lazy creation — already the current behavior since `create` is called in the route)
- After the first assistant response in a new conversation (when `session.messageCount === 1`), call `generateTitle` asynchronously and then call `updateTitle` on the conversation store
- Add `channel: "web"` when creating conversations from this route

### 9. Update confirm route

In `web/app/api/agent/confirm/route.ts`:

- Change session store import to `import { sessionStore } from "@/lib/session-factory"`
- No other changes needed — the interface is the same

### 10. Update sessions route

In `web/app/api/agent/sessions/route.ts`:

- Change session store import to `import { sessionStore } from "@/lib/session-factory"`
- No other changes needed

### 11. Update Teams route

In `web/app/api/teams/messages/route.ts`:

- Change session store import to `import { sessionStore } from "@/lib/session-factory"`
- When creating sessions, pass `channel: "teams"`. This requires the `SessionStore` interface `create` method to accept an optional `channel` parameter.
- After agent loop completes and messages are assigned, the Cosmos adapter handles persistence

### 12. Create conversations API routes

**`web/app/api/conversations/route.ts`** (GET):

- Authenticate via `resolveAuth(request)`
- Call `listConversations(identity.name)` from conversation-store
- Return JSON array of `ConversationMeta` objects
- Admin role can optionally list all conversations (query param `?all=true`)

**`web/app/api/conversations/[id]/route.ts`** (GET, DELETE, PATCH):

- GET: authenticate, call `getConversation(id, ownerId)`, enforce ownership (or admin), return full conversation JSON
- DELETE: authenticate, enforce ownership (or admin), call `deleteConversation(id, ownerId)`, return 204
- PATCH: authenticate, enforce ownership, read `{ title }` from request body, call `updateTitle(id, ownerId, title)`, return updated meta

### 13. Update ChatInterface component

In `web/components/ChatInterface/ChatInterface.tsx`:

- Add new props: `initialConversations: ConversationMeta[]` (passed from server component)
- Replace the hardcoded `RECENT_LOGS` array with state initialized from `initialConversations`
- Add `activeConversationId` state (string or null)
- On mount, if conversations exist, do not auto-select one (show empty state with initial greeting)
- "New Operation" button: clear `activeConversationId` and reset messages to `INITIAL_MESSAGES`
- Clicking a sidebar conversation: set `activeConversationId`, fetch full conversation from `GET /api/conversations/[id]`, populate messages
- Sending a message: POST to `/api/agent` with `{ sessionId: activeConversationId, message }`. Parse NDJSON stream. On `session` event, set `activeConversationId` if it was null (new conversation). On `response` event, add assistant message. On `tool_call` and `confirmation_required`, handle accordingly.
- Sidebar items show: conversation title (or "New conversation"), relative timestamp (e.g., "2h ago"), active state highlight
- Add inline rename: double-click conversation title in sidebar to edit, PATCH on blur/enter
- After sending a message and receiving response, re-fetch conversation list to get updated title and ordering
- Show scrollable conversation list, max 50 items

### 14. Update ChatInterface styles

In `web/components/ChatInterface/ChatInterface.module.css`:

- Add `.conversationItem` class for sidebar list items with hover state
- Add `.conversationItemActive` with highlighted background
- Add `.conversationTitle` with truncation (ellipsis)
- Add `.conversationTimestamp` with smaller muted text
- Add `.conversationTitleInput` for inline rename field
- All with `:global(html.dark)` overrides following the established pattern

### 15. Update chat page server component

In `web/app/chat/page.tsx`:

- After auth check, fetch the user's conversation list server-side by importing `listConversations` from conversation-store (or calling the API internally)
- Pass the list as a prop to `ChatPageClient`
- In dev bypass mode, pass an empty array

### 16. Update ChatPageClient

In `web/app/chat/ChatPageClient.tsx`:

- Accept `initialConversations` prop
- Forward to `ChatInterface`

### 17. Create provisioning script

New file `scripts/provision-cosmos-db.ps1`:

- Parameters: `$ResourceGroupName` (default "neo-rg"), `$AccountName` (default "neo-cosmos"), `$DatabaseName` (default "neo-db"), `$ContainerName` (default "conversations"), `$Location` (default "eastus"), `$DefaultTtl` (default 7776000 / 90 days), `$WebAppName` (for Managed Identity assignment)
- Prerequisites check: `az` CLI installed, logged in, display subscription for confirmation
- Create resource group (idempotent)
- Create Cosmos DB account with serverless capability, Session consistency level, GlobalDocumentDB kind
- Create database
- Create container with `/ownerId` partition key and default TTL enabled
- Assign "Cosmos DB Built-in Data Contributor" role to the web app's Managed Identity
- Output the Cosmos endpoint URL for `.env` configuration

---

## Verification

1. `cd web && npm run build` — zero errors, all new files compile
2. Dev server with no `COSMOS_ENDPOINT` — in-memory fallback, console warning "Cosmos DB not configured, using in-memory session store", existing chat behavior unchanged
3. Dev server with `COSMOS_ENDPOINT` set — conversations persist to Cosmos DB, survive server restart
4. Open web UI → sidebar shows "No conversations yet" initially
5. Send a message → new conversation created, appears in sidebar after response
6. Wait for title generation → sidebar item updates with auto-generated title
7. Refresh page → conversation persists in sidebar, click to reload messages
8. Click "New Operation" → starts fresh conversation, previous one remains in sidebar
9. Double-click sidebar title → inline rename, PATCH saves
10. Delete conversation → removed from sidebar and Cosmos
11. Teams bot message → creates conversation with `channel: "teams"`, visible in web sidebar
12. 30+ minutes idle → session marked inactive (cannot send new messages), but still browsable in sidebar for 90 days
13. `scripts/provision-cosmos-db.ps1` — creates account, database, container, assigns Managed Identity role
14. Re-run provisioning script — idempotent, no errors
