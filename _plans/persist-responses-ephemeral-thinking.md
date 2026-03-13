# Persist Responses and Ephemeral Thinking

## Context

Agent responses from Teams conversations are not persisted to Cosmos DB — only user messages are saved. The CLI acts as a thin HTTP client to `/api/agent` (which does persist), but sessions are created without a `channel` identifier, making it impossible to separate CLI vs web conversation history. Additionally, thinking indicators are either invisible (web) or static text (CLI); both should show a brief animated indicator that disappears when the model starts responding. The user wants CLI-only history in CLI and web-only history in the web UI, with a skeleton bubble animation style for web thinking.

---

## Key Design Decisions

- **Teams persistence fix is a bug fix**: `sendAgentResult()` in the Teams route updates the in-memory session but never calls `saveMessages()`. Adding the call after both the regular message path and confirmation path fixes the gap.
- **CLI persistence already works via the web API**: The CLI calls `/api/agent` which persists via `writeAgentResult()`. The real work is adding channel-aware session creation so CLI and web conversations are separated.
- **Channel passed from client to API**: The `/api/agent` route will accept an optional `channel` field in the request body and pass it through to `sessionStore.create()`. The CLI will send `channel: "cli"` with every request.
- **Web conversation list filtered by channel**: `listForOwner()` calls in the web UI will filter to `channel: "web"` so CLI conversations don't appear in the sidebar.
- **Skeleton bubble for web thinking**: A lightweight component that renders an animated skeleton bubble (three pulsing dots inside a chat bubble shape) managed by a `isThinking` boolean state — not added to the messages array.
- **CLI thinking uses an interval-based spinner**: Replace the static "Thinking..." with a rotating spinner character that is cleared via ANSI escape when the next event arrives.

---

## Files to Change

| File | Change |
|------|--------|
| `web/app/api/teams/messages/route.ts` | Add `sessionStore.saveMessages()` calls after agent loop completes in both regular message (line ~456) and confirmation (line ~320) paths |
| `web/app/api/agent/route.ts` | Accept optional `channel` field from request body; pass to `sessionStore.create()` when creating new sessions |
| `web/lib/types.ts` | Ensure `Channel` type includes `"cli"` if not already present |
| `cli/src/server-client.js` | Include `channel: "cli"` in the POST body for `/api/agent` requests |
| `web/components/ChatInterface/ChatInterface.tsx` | Add `isThinking` state; render `ThinkingBubble` component when true; set true on `thinking` event, false on `tool_call`/`response`/`error` events |
| `web/components/ThinkingBubble/ThinkingBubble.tsx` | New component: skeleton chat bubble with three animated pulsing dots |
| `web/components/ThinkingBubble/ThinkingBubble.module.css` | Keyframe animation for pulsing dots with staggered delays |
| `web/components/ThinkingBubble/index.ts` | Barrel export |
| `web/components/index.ts` | Add `ThinkingBubble` to barrel exports |
| `cli/src/index.js` | Replace `printThinking()` with interval-based spinner; add `clearThinking()` that stops interval and clears the line; call `clearThinking()` from tool_call and response callbacks |
| `web/app/page.tsx` or equivalent sidebar | Filter conversation list to `channel: "web"` when listing history |
| `test/persist-responses-ephemeral-thinking.test.ts` | Tests per spec testing guidelines |

---

## Implementation Steps

### 1. Fix Teams response persistence

- In `web/app/api/teams/messages/route.ts`, after the agent loop completes in the regular message path (around line 455-456), add `await sessionStore.saveMessages(resolvedSessionId, result.messages)` after updating `session.messages = result.messages`
- In the confirmation path (around line 319-320), add the same `saveMessages()` call after `session.messages = result.messages`
- Wrap both in try/catch so a persistence failure does not prevent the Teams response from being sent

### 2. Add channel-aware session creation to the API route

- In `web/app/api/agent/route.ts`, extract `channel` from the request body (default to `"web"` if not provided)
- Pass `channel` as the third argument to `sessionStore.create(identity.role, identity.ownerId, channel)`
- Validate that `channel` is one of the allowed `Channel` values; reject unknown values

### 3. Send channel from CLI

- In `cli/src/server-client.js`, in the `streamMessage()` function, add `channel: "cli"` to the JSON body sent to `/api/agent`
- This ensures all CLI-originated sessions are tagged with channel `"cli"`

### 4. Filter web conversation list by channel

- Identify where the web UI fetches conversation history for the sidebar (likely via `sessionStore.listForOwner()` or equivalent API route)
- Add a `channel` filter parameter so the web sidebar only shows `channel: "web"` conversations
- If `listForOwner()` in `CosmosSessionStore` doesn't support channel filtering, add it as an optional parameter to the method signature and implement the Cosmos DB query filter

### 5. Create ThinkingBubble component

- Create `web/components/ThinkingBubble/ThinkingBubble.tsx`: a presentational component that renders an assistant-styled chat bubble containing three dots
- The three dots should animate with a pulsing/bouncing keyframe, each dot staggered by ~150ms delay
- Use CSS Modules (`ThinkingBubble.module.css`) for the animation since it will have 4+ Tailwind classes
- Style to match the existing assistant message bubble shape (same border radius, background color, alignment)
- Add barrel export in `index.ts` and register in `web/components/index.ts`

### 6. Wire ThinkingBubble into ChatInterface

- In `ChatInterface.tsx`, add `const [isThinking, setIsThinking] = useState(false)`
- In the `processNDJSONStream()` event handler:
  - On `thinking` event: call `setIsThinking(true)` (replacing the current no-op `break`)
  - On `tool_call` event: call `setIsThinking(false)` before existing handling
  - On `response` event: call `setIsThinking(false)` before existing handling
  - On `error` event: call `setIsThinking(false)` before existing handling
- In the message list JSX, after the last message and before the input area, conditionally render `{isThinking && <ThinkingBubble />}`
- Wrap in Framer Motion `AnimatePresence` with fade-in/fade-out for smooth appearance/disappearance
- Ensure `isThinking` is reset to `false` in the `finally` block of the stream processing to handle unexpected disconnections
- Auto-scroll to the thinking bubble when it appears (same scroll behavior as new messages)

### 7. Improve CLI thinking indicator

- In `cli/src/index.js`, replace `printThinking()` with a function that starts a `setInterval` updating a spinner character (e.g., cycling through `⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏`) on the current line using `\r`
- Store the interval ID in a module-level variable
- Create `clearThinking()` that clears the interval, writes spaces + `\r` to erase the spinner line
- Update the callbacks object: `onThinking` starts the spinner, `onToolCall` calls `clearThinking()` before printing tool info
- Call `clearThinking()` before printing the final response (around line 393 where the current clearing happens)
- Call `clearThinking()` in error handlers to ensure cleanup on failure

### 8. Write tests

- Create `test/persist-responses-ephemeral-thinking.test.ts`
- **Teams persistence test**: Mock `sessionStore.saveMessages()`, simulate the Teams message handler flow, assert `saveMessages` is called with the full message array after agent loop completion
- **ThinkingBubble render test**: Render the component, verify it displays the animated dots, verify it unmounts cleanly
- **ChatInterface thinking flow test**: Mock the NDJSON stream with events `[thinking, tool_call, response]`, verify `ThinkingBubble` appears after thinking event and disappears after tool_call event
- **Error cleanup test**: Mock stream with `[thinking, error]`, verify thinking indicator is removed
- **Multiple thinking events test**: Send two consecutive thinking events, verify only one indicator is visible

---

## Verification

1. Start web server with Cosmos DB configured; send a message via Teams bot; query Cosmos DB to confirm both user and assistant messages are stored in the conversation document
2. Start web server and CLI; send messages via CLI; query Cosmos DB to confirm messages are stored with `channel: "cli"`; verify the web UI sidebar does not show CLI conversations
3. Open web UI; send a message; observe skeleton bubble appears briefly during thinking and disappears when the response begins streaming — no residual thinking messages in chat
4. Open CLI; send a message; observe spinner animation during thinking; confirm it is cleanly replaced by tool output or the final response
5. Run test suite: `cd web && npm test` (or equivalent test command for the test file)
