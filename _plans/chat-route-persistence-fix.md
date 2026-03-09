# Chat Route and Persistence Fix

## Context

The chat persistence layer has a critical gap: after the agent loop completes, messages are updated in-memory (`session.messages = result.messages`) but never flushed to Cosmos DB. This means conversations appear empty when reloaded, and renaming a conversation overwrites its (empty) document. Additionally, there is no `/chat/[id]` dynamic route, so users cannot navigate directly to a conversation by URL, and there is no client-side caching for fast conversation switching. This plan fixes all four issues based on the resolved spec at `_specs/chat-route-persistence-fix.md`.

---

## Key Design Decisions

- **Persist in `writeAgentResult()`** — This is the single function where `session.messages` is updated after every agent turn (both normal responses and confirmations). Adding the persistence call here fixes both API routes (`/api/agent` and `/api/agent/confirm`) with one change, since both call `writeAgentResult()`.
- **Add `saveMessages()` to SessionStore interface** — The interface currently has no method to write messages back. Adding `saveMessages(id, messages, title?)` provides a clean abstraction for both `CosmosSessionStore` (calls `appendMessages`) and `InMemorySessionStore` (no-op, already mutated in-memory).
- **Pass `ownerId` through to `writeAgentResult()`** — The `CosmosSessionStore.saveMessages()` needs `ownerId` for the partition key. The `session` object already contains `ownerId`, so it's available.
- **React Context for conversation cache** — Per user decision, use a `ConversationCacheProvider` context rather than module-level state. This wraps the chat route layout and provides cache/prefetch methods to `ChatInterface`.
- **Full message prefetch** — Per user decision, cache full conversation data (not just metadata) for instant switching.
- **Simple title truncation** — Per user decision, auto-generate titles by truncating the first user message to 50 characters rather than calling Claude.
- **Immediate URL update** — Per user decision, update URL to `/chat/[id]` as soon as the `session` event arrives in the NDJSON stream.
- **404 for unauthorized conversation access** — Per user decision, show a 404 page rather than redirect.

---

## Files to Change

| File | Change |
|------|--------|
| `web/lib/session-store.ts` | Add `saveMessages(id: string, messages: Message[], title?: string): Promise<void>` to `SessionStore` interface. Add no-op implementation in `InMemorySessionStore`. |
| `web/lib/conversation-store.ts` | Add `saveMessages()` to `CosmosSessionStore` that calls `appendMessages()` (or full-replace, since we have all messages). Fix `updateTitle()` to use etag for optimistic concurrency. |
| `web/lib/stream.ts` | After setting `session.messages = result.messages`, call `sessionStore.saveMessages()` to persist. Generate auto-title from first user message when `session.messageCount` indicates it's the first turn. Pass through the `ownerId` context. |
| `web/app/chat/[id]/page.tsx` | **New** — Dynamic route server component. Auth check, fetch conversation by ID and ownerId, 404 if not found or not owned, pass data to client component. |
| `web/app/chat/layout.tsx` | **New** — Shared layout for `/chat` and `/chat/[id]` that wraps children in `ConversationCacheProvider`. |
| `web/app/chat/page.tsx` | Move auth logic to shared layout. Simplify to just render `ChatPageClient` with no pre-loaded conversation. |
| `web/app/chat/ChatPageClient.tsx` | Accept optional `initialConversation` prop (full conversation data for `/chat/[id]`). Pass to `ChatInterface`. |
| `web/context/ConversationCacheContext.tsx` | **New** — React context provider with `Map<string, Conversation>` cache. Exposes: `getCached(id)`, `setCached(id, conv)`, `invalidate(id)`, `prefetch(id)`. Max 10 entries with LRU eviction. |
| `web/components/ChatInterface/ChatInterface.tsx` | Accept `initialConversation` prop. Use `useRouter()` for URL management: `router.replace('/chat/[id]')` on session event, `router.push('/chat/[id]')` on sidebar click. Use conversation cache context for instant switching. On `loadConversation`, check cache first, render immediately if cached, revalidate in background. |
| `web/lib/types.ts` | No structural changes needed — `Conversation` type already exists and includes messages. |

---

## Implementation Steps

### 1. Add `saveMessages` to SessionStore interface and implementations

- In `web/lib/session-store.ts`, add `saveMessages(id: string, messages: Message[], title?: string): Promise<void>` to the `SessionStore` interface.
- In `InMemorySessionStore`, implement `saveMessages` as a no-op (the in-memory store already has the updated messages via direct object mutation in `writeAgentResult`).
- In `web/lib/conversation-store.ts` `CosmosSessionStore`, implement `saveMessages` that:
  - Resolves `ownerId` via the existing `resolveOwner()` cache
  - Reads the current document from Cosmos
  - Replaces the `messages` array with the new messages (full replacement, not incremental append — simpler and handles all edge cases since the full array is available)
  - Updates `messageCount`, `updatedAt`, and optionally `title` (if provided and document has no title yet)
  - Uses etag-based optimistic concurrency to avoid conflicts

### 2. Fix `updateTitle` to use etag

- In `web/lib/conversation-store.ts`, update the `updateTitle()` function to read with etag and pass the `accessCondition` to the `replace()` call, matching the pattern already used in `appendMessages()`.

### 3. Persist messages in `writeAgentResult`

- In `web/lib/stream.ts`, after the line `session.messages = result.messages`:
  - Call `sessionStore.saveMessages(sessionId, result.messages, autoTitle)` where `autoTitle` is the first user message truncated to 50 characters (only on the first turn — detect by checking if the session had 0 messages before this turn, or if the conversation has no title yet).
  - Wrap in try/catch so persistence failures don't break the NDJSON stream response. Log errors via `logger.error()`.
  - Import `logger` from `./logger`.
- To determine the auto-title: look at `result.messages` for the first entry with `role: "user"`, extract text content (handle both string content and content block arrays), truncate to 50 characters with ellipsis.

### 4. Create ConversationCacheContext

- Create `web/context/ConversationCacheContext.tsx` as a `'use client'` context provider.
- Internal state: `Map<string, { data: Conversation; accessedAt: number }>` — conversation data plus LRU timestamp.
- Exported context methods:
  - `getCached(id: string): Conversation | null` — returns cached conversation or null, updates `accessedAt`
  - `setCached(id: string, conv: Conversation): void` — stores conversation, evicts LRU if cache exceeds 10 entries
  - `invalidate(id: string): void` — removes a specific entry (called after sending a new message to that conversation)
  - `prefetch(id: string): Promise<void>` — fetches `GET /api/conversations/[id]` and stores result in cache, no-op if already cached and recent (within 30 seconds)
- Export a `useConversationCache()` hook that calls `useContext()`.

### 5. Create shared chat layout

- Create `web/app/chat/layout.tsx` as a server component that:
  - Authenticates the user (move auth check from `page.tsx`)
  - Redirects to `/` if not authenticated
  - Fetches `initialConversations` list from Cosmos (move from `page.tsx`)
  - Wraps `{children}` in `ConversationCacheProvider`
  - Passes user info and initial conversations via props to a new client layout wrapper (since context providers must be client components)
- Create `web/app/chat/ChatLayoutClient.tsx` as a `'use client'` component that:
  - Receives `userName`, `userRole`, `initialConversations`, and `children`
  - Wraps children in `ConversationCacheProvider`
  - Note: `ChatInterface` still needs access to `userName`, `userRole`, `initialConversations` — these can be passed via the cache context or a separate layout context

### 6. Create `/chat/[id]` dynamic route

- Create `web/app/chat/[id]/page.tsx` as a server component:
  - Extract the `id` parameter from the route params
  - Auth is handled by the shared layout, so this page just needs to fetch the specific conversation
  - Call `getConversation(id, ownerId)` — if null, render `notFound()` (Next.js built-in 404)
  - If conversation exists but `ownerId` doesn't match, also render `notFound()`
  - Pass the full conversation data to `ChatPageClient` as `initialConversation`
- Import `notFound` from `next/navigation`

### 7. Update ChatPageClient

- In `web/app/chat/ChatPageClient.tsx`:
  - Add optional `initialConversation?: Conversation` prop
  - Pass it through to `ChatInterface` as a new prop
  - Keep the existing `initialConversations` prop for the sidebar list (this now comes from the layout)

### 8. Refactor `/chat/page.tsx`

- Simplify `web/app/chat/page.tsx`:
  - Remove auth check (moved to layout)
  - Remove `fetchConversations` (moved to layout)
  - Just render `ChatPageClient` with no `initialConversation` (new conversation mode)

### 9. Update ChatInterface for URL management and caching

- In `web/components/ChatInterface/ChatInterface.tsx`:
  - Add `initialConversation?: Conversation` prop to `ChatInterfaceProps`
  - Import `useRouter` from `next/navigation` and `useConversationCache` from context
  - **On mount**: If `initialConversation` is provided, populate messages from it (same conversion logic as `loadConversation`), set `activeConversationId`, and cache it
  - **On `session` event in NDJSON stream**: If this is a new conversation (no prior `activeConversationId`), call `router.replace(`/chat/${sessionId}`)` to update URL immediately
  - **On sidebar conversation click**: Instead of just calling `loadConversation(id)`, call `router.push(`/chat/${id}`)`. However, since this would trigger a full page navigation, instead use shallow routing or keep the client-side load but update the URL with `window.history.pushState()` to avoid a server round-trip. The preferred approach: keep the existing `loadConversation` logic (client-side fetch) and add `window.history.pushState({}, '', `/chat/${id}`)` after successful load. This gives URL updates without re-rendering the layout.
  - **On `loadConversation`**: Check `useConversationCache().getCached(id)` first. If cached, render immediately and set as active. Then fetch in background and update if different (stale-while-revalidate). After fetch, call `setCached(id, freshData)`.
  - **After sending a message**: Call `invalidate(activeConversationId)` to clear stale cache for the current conversation.
  - **On "New Operation"**: Call `window.history.pushState({}, '', '/chat')` in addition to existing reset logic.
  - **Prefetch on hover**: Add `onMouseEnter` to sidebar conversation items that calls `prefetch(conv.id)` from the cache context.

### 10. Handle browser back/forward navigation

- In `ChatInterface`, add a `popstate` event listener (via `useEffect`) that reads the conversation ID from `window.location.pathname`:
  - Parse `/chat/[id]` from the URL
  - If an ID is present and different from `activeConversationId`, call `loadConversation(id)`
  - If no ID (just `/chat`), call `handleNewConversation()`
  - This ensures browser back/forward buttons work correctly with the `pushState` approach

---

## Verification

1. `cd web && npm run build` — zero errors, confirms TypeScript compiles and routes are valid
2. Start dev server with `MOCK_MODE=true` — verify `/chat` renders, new conversation works, URL stays at `/chat`
3. Start dev server with Cosmos DB configured:
   - Send a message → verify URL updates to `/chat/[id]` immediately on session event
   - Reload the page at `/chat/[id]` → verify full conversation loads from Cosmos (messages persisted)
   - Send another message → verify messages append correctly in Cosmos
   - Click sidebar conversation → verify URL updates and conversation loads (cache miss → fetch)
   - Click back to same conversation → verify instant load from cache
   - Use browser back button → verify previous conversation loads
   - Rename a conversation → verify messages are not lost (etag-protected replace)
   - Hover over sidebar items → verify prefetch calls fire (check Network tab)
4. Navigate to `/chat/nonexistent-id` → verify 404 page renders
5. Navigate to `/chat/[id-owned-by-other-user]` → verify 404 page renders
6. Click "New Operation" → verify URL changes to `/chat` and conversation resets
