# Chat Route and Persistence Fix

> Add a `/chat/[id]` route for direct conversation access, fix messages not being persisted to Cosmos DB after agent responses, fix the rename operation losing chat history, and add conversation prefetching/caching for faster sidebar switching.

## Problem

The chat persistence layer has several interrelated bugs and missing features:

1. **Messages not written to Cosmos DB** — The agent API route (`/api/agent`) runs the agent loop and streams results back to the client, but never calls `appendMessages()` to persist the conversation to Cosmos DB. The `session.messages` array is updated in-memory (via `writeAgentResult` in `stream.ts`), but this in-memory state is never flushed to the database. When the user reloads the page or switches conversations, the messages are gone.

2. **Rename loses chat history** — The `updateTitle()` function in `conversation-store.ts` reads the conversation, updates the title, and replaces the entire document. However, since messages were never persisted to Cosmos in the first place (bug #1), the document in Cosmos has an empty `messages: []` array. The replace operation writes this empty-messages document back, effectively "losing" any history that might have existed.

3. **No `/chat/[id]` route** — There is no way to navigate directly to a conversation by URL. The current routing only supports `/chat` which always starts fresh. Users cannot share or bookmark a specific conversation, and browser navigation (back/forward) does not work between conversations.

4. **No prefetching or caching** — Every conversation switch requires a full round-trip to `GET /api/conversations/[id]`. There is no client-side caching, no prefetch on hover, and no stale-while-revalidate pattern. Switching between recent chats feels slow, especially with large conversation histories.

## Goals

- Persist all messages to Cosmos DB after each agent response completes (both regular responses and confirmation results)
- Add a `/chat/[id]` dynamic route that loads a specific conversation by ID
- Update the sidebar to use `router.push('/chat/[id]')` so conversation switches update the URL
- Fix the rename operation to not overwrite conversation data (or make it moot by ensuring messages are always persisted)
- Add client-side conversation caching so switching between recently-viewed conversations is instant
- Prefetch conversation metadata and optionally message content for sidebar items
- Ensure the "New Operation" button navigates to `/chat` (no ID) to start a fresh conversation

## Non-Goals

- Full-text search across conversations
- Sharing conversations between users or generating shareable links
- Real-time sync across multiple browser tabs
- Offline support or service worker caching
- Infinite scroll or pagination for the sidebar beyond the existing 50-conversation limit
- Changing the Cosmos DB data model or partition strategy

## User Stories

1. **As a SOC analyst**, I can click a conversation in the sidebar and have the URL update to `/chat/[id]`, so I can use browser back/forward to navigate between conversations and bookmark important investigations.
2. **As a SOC analyst**, I can send a message and close my browser, and when I return later, the full conversation history is intact because messages are persisted to the database after each response.
3. **As a SOC analyst**, I can rename a conversation without losing any messages, because the rename operation does not interfere with message storage.
4. **As a SOC analyst**, I can switch between recent conversations quickly because previously-viewed conversations are cached on the client and load instantly.
5. **As a SOC analyst**, I can share a `/chat/[id]` URL with a teammate (who has appropriate access), and they can view that conversation directly.
6. **As a SOC analyst**, when I click "New Operation", I'm navigated to `/chat` to start a fresh conversation without any stale state from the previous one.

## Design Considerations

### Message Persistence

The core fix is to call `appendMessages()` after the agent loop completes in the API route. This should happen in `writeAgentResult()` (in `stream.ts`) or immediately after it, since that is where `session.messages` is updated with the full message history. The persistence call should include both the user message and the assistant response (the full delta since the last persist).

For the `CosmosSessionStore`, the `get()` method already returns the session with messages. The gap is that after the agent loop mutates `session.messages`, nobody writes the updated messages back. The store needs an explicit save/update step after each agent turn.

Consider whether to persist the full message array each time (simpler, handles all edge cases) or only append the new messages (more efficient, requires tracking a high-water mark). Given that conversations are bounded by rate limits and the 50-message typical length, full replacement is likely acceptable.

### `/chat/[id]` Route

Add a Next.js dynamic route at `web/app/chat/[id]/page.tsx`. This server component should:

- Authenticate the user (same as current `/chat` page)
- Fetch the specific conversation from Cosmos DB by ID and ownerId
- Return 404 or redirect to `/chat` if the conversation doesn't exist or the user doesn't own it
- Pass the conversation data (messages, title, metadata) to the client component
- Reuse the existing `ChatInterface` component with the conversation pre-loaded

The existing `/chat` page (no ID) continues to work as the "new conversation" entry point.

### URL Management

When a new conversation is created (first message sent), the URL should update from `/chat` to `/chat/[newId]` without a full page reload. Use `router.replace('/chat/[id]')` via Next.js `useRouter()` to update the URL after receiving the `session` event from the NDJSON stream.

When clicking a sidebar conversation, use `router.push('/chat/[id]')` so the navigation is tracked in browser history.

### Client-Side Caching

Implement a lightweight client-side cache for conversation data:

- Cache full conversation data after it's loaded (messages + metadata)
- On sidebar click: if cached, render immediately from cache, then revalidate in the background (stale-while-revalidate pattern)
- Cache invalidation: clear a conversation's cache entry when a new message is sent to it, or when the conversation list is refreshed and shows a newer `updatedAt` timestamp
- Keep the cache bounded — evict least-recently-used entries when the cache exceeds a reasonable size (e.g., 10 conversations)

Consider using a React context or a simple `Map` in a custom hook rather than pulling in a full data-fetching library like SWR or react-query, to keep the dependency footprint small.

### Prefetching

Prefetch conversation metadata (not full messages) for sidebar items that are visible. This is already partially done via the `initialConversations` prop passed from the server component. For message-level prefetching, consider prefetching on hover or on intersection observer visibility for the top few conversations.

### Rename Fix

Once message persistence is working (bug #1 fix), the rename issue is largely resolved — `updateTitle()` will read a document that has the full message history, update the title, and write it back. However, the `updateTitle()` function should be updated to use optimistic concurrency (etag) like `appendMessages()` already does, to prevent race conditions between a rename and a message append happening concurrently.

### Conversation Title Auto-Generation

Currently there is an `appendMessages()` function that accepts an optional `title` parameter to auto-set the title on the first response. The agent API route should pass a generated title (e.g., first 50 characters of the user's first message, or a Claude-generated summary) when persisting the first message pair.

## Key Files

- `web/lib/stream.ts` — Add `appendMessages()` call after updating `session.messages` in `writeAgentResult()`
- `web/lib/conversation-store.ts` — Add etag to `updateTitle()`, verify `appendMessages()` works correctly
- `web/app/chat/[id]/page.tsx` — New dynamic route server component
- `web/app/chat/[id]/ChatPageClient.tsx` — New or reuse existing client component with pre-loaded conversation
- `web/app/chat/page.tsx` — May need minor updates for URL management coordination
- `web/components/ChatInterface/ChatInterface.tsx` — Add URL management (`router.push`/`router.replace`), client-side cache, prefetch logic, accept pre-loaded conversation prop
- `web/app/api/agent/route.ts` — Ensure persistence call is made after agent loop (may be handled in `stream.ts`)
- `web/app/api/agent/confirm/route.ts` — Same persistence fix for confirmation results

## Open Questions

1. Should the cache be implemented as a React context provider wrapping the chat routes, or as a custom hook with module-level state? Context is more "React-correct" but adds a provider to the tree; module-level Map is simpler but doesn't trigger re-renders. Context
2. Should full message arrays be prefetched for sidebar items, or only metadata? Full prefetch gives instant switching but uses more bandwidth/memory. Full
3. When navigating to `/chat/[id]` for a conversation the user doesn't own, should we show a 404 page or redirect to `/chat` with a toast notification? 404
4. Should auto-generated conversation titles use a simple truncation of the first message, or call Claude (Haiku) to generate a short summary? The summary is better UX but adds latency and cost. Simple truncation.
5. Should the URL update to `/chat/[id]` happen immediately when the `session` event arrives, or only after the full response completes? Immediate gives correct URL sooner for bookmarking; delayed avoids URL changes for failed requests. immediate
