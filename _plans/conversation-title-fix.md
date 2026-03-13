# Conversation Title Fix

## Context

CLI and Teams conversations are stored in Cosmos DB without titles because the Teams route never calls `extractAutoTitle()` and the existing `title-generator.ts` (Haiku-based LLM title generation) is never imported. The user wants to wire up the Haiku-based title generator for all channels as a fire-and-forget enhancement, with the simple first-message extraction as a synchronous fallback. The web channel's title generation via `extractAutoTitle()` in `stream.ts` already works and must not regress.

---

## Key Design Decisions

- **Wire up `title-generator.ts` for all channels.** The user confirmed they want Haiku-generated titles (e.g., "Suspicious Login from Russia") rather than raw user messages. This applies to web, CLI, and Teams equally.
- **Fire-and-forget pattern for LLM title generation.** The Haiku call must never block or delay the agent response. Call it asynchronously after the first agent response, with errors caught and logged.
- **Use `extractAutoTitle` as synchronous fallback.** Set the first-message-based title immediately via `saveMessages`, then overwrite with the Haiku-generated title asynchronously. This ensures every conversation gets a title even if the Haiku call fails.
- **Extract `extractAutoTitle` from `stream.ts` into a shared utility.** Both the stream handler and the Teams route need it, so it should be importable from a shared location rather than duplicated.
- **Title is set-once in Cosmos but Haiku can overwrite.** The current `if (title && !resource.title)` guard prevents overwrites. The Haiku-generated title needs a separate `updateTitle()` call that explicitly overwrites the fallback title.

---

## Files to Change

| File | Change |
|------|--------|
| `web/lib/stream.ts` | Move `extractAutoTitle` to a shared location; import it back. After `saveMessages` with the fallback title, fire-and-forget the Haiku title generator and call `updateTitle` on success. |
| `web/lib/title-generator.ts` | No functional changes needed — already correctly implemented. Verify the model ID is current. |
| `web/lib/title-utils.ts` | New file — home for `extractAutoTitle` (moved from `stream.ts`) and a `generateAndSetTitle` orchestrator function that calls `generateTitle` and then `updateTitle`. |
| `web/app/api/teams/messages/route.ts` | After each `saveMessages` call that follows an agent loop result, pass the auto-title as the third argument. Also fire-and-forget the Haiku title generator for new conversations. |
| `web/lib/conversation-store.ts` | No changes — `updateTitle` already exists and handles the Haiku overwrite path. |
| `test/conversation-title.test.js` | New test file for `extractAutoTitle` and the title orchestration logic. |

---

## Implementation Steps

### 1. Create `web/lib/title-utils.ts`

- Create a new file `web/lib/title-utils.ts`
- Move the `extractAutoTitle` function from `web/lib/stream.ts` into this file, along with the `MAX_TITLE_LENGTH` constant and `CONTROL_CHAR_RE` regex it depends on
- Export `extractAutoTitle` as a named export
- Add a new exported function `generateAndSetTitle(sessionId: string, messages: Message[])` that:
  - Finds the first user message and first assistant message from the messages array
  - If either is missing, returns early (no title to generate)
  - Calls `generateTitle(firstUserMessage, firstAssistantResponse)` from `title-generator.ts`
  - If the result is not the fallback "New conversation", calls `sessionStore.saveMessages(sessionId, messages, generatedTitle)` — but since the set-once guard would block this, instead import and call `updateTitle` from `conversation-store.ts` via a new `SessionStore` method
  - Wraps everything in a try-catch that logs warnings on failure but never throws

### 2. Add `updateTitle` method to the `SessionStore` interface

- In `web/lib/session-store.ts`, add `updateTitle(id: string, title: string): Promise<void>` to the `SessionStore` interface
- In `InMemorySessionStore`, implement it as a no-op (in-memory sessions don't persist titles)
- In `web/lib/conversation-store.ts` `CosmosSessionStore`, implement it by resolving the ownerId and calling the existing `updateTitle(id, ownerId, title)` function

### 3. Update `generateAndSetTitle` to use `SessionStore.updateTitle`

- In the `generateAndSetTitle` function, import `sessionStore` from `session-factory` and call `sessionStore.updateTitle(sessionId, generatedTitle)` instead of directly calling the Cosmos function
- This keeps the abstraction clean and works for both in-memory and Cosmos stores

### 4. Update `web/lib/stream.ts`

- Remove the `extractAutoTitle` function, the `MAX_TITLE_LENGTH` constant, and the `CONTROL_CHAR_RE` regex
- Import `extractAutoTitle` from `./title-utils`
- Import `generateAndSetTitle` from `./title-utils`
- In `writeAgentResult`, after the existing `saveMessages` call (which sets the fallback title), add a fire-and-forget call to `generateAndSetTitle(sessionId, result.messages)` — use `void generateAndSetTitle(...).catch(...)` pattern so it doesn't block the response stream
- Only call `generateAndSetTitle` when the result type is a response (not confirmation_required), since confirmations don't produce a meaningful assistant response for titling

### 5. Update Teams route to pass auto-title

- In `web/app/api/teams/messages/route.ts`, import `extractAutoTitle` and `generateAndSetTitle` from `@/lib/title-utils`
- **Branch B (regular message), post-agent-loop `saveMessages` call (around line 483):** Pass `extractAutoTitle(result.messages)` as the third argument to `saveMessages`. Then fire-and-forget `generateAndSetTitle(resolvedSessionId, result.messages)`
- **Branch A (confirmation response), `saveMessages` call (around line 339):** Pass `extractAutoTitle(result.messages)` as the third argument. Do not fire the Haiku generator here since the conversation should already have a title from the initial message
- **Branch B, pre-agent-loop `saveMessages` call (around line 469):** This persists just the user message before the agent runs. Do not pass a title here — the title should come after the agent responds

### 6. Create test file `test/conversation-title.test.js`

- Create `test/conversation-title.test.js` using `node:test`
- Import `extractAutoTitle` from `../web/lib/title-utils` (this requires the function to be exported and have no heavy dependencies — it's a pure function)
- Test cases:
  - Returns the first user message text when a user message exists
  - Returns undefined when no user message exists in the array
  - Truncates messages longer than 200 characters and appends "..."
  - Strips control characters from the message
  - Handles content array format (array of text blocks) correctly
  - Returns undefined when user message content is empty/whitespace-only

---

## Verification

1. Run the new tests: `/Users/pkeenan/.nvm/versions/node/v24.14.0/bin/node --test test/conversation-title.test.js`
2. Run `cd web && npm run build` to verify TypeScript compiles without errors
3. Manual test — CLI: run `cd cli && npm start`, send a message, then check `history` to confirm the conversation has a title (not "Untitled")
4. Manual test — Web: send a message in the web UI, verify the sidebar shows a title
5. Manual test — Teams: send a message in Teams, then check the web conversation list or CLI `history` for the Teams conversation's title
6. Verify in Cosmos DB (or application logs) that the Haiku-generated title overwrites the initial auto-title after a short delay
