# Fix Database Message Persistence

## Context

Conversations in Cosmos DB often show `messageCount: 1` with only the user message — assistant responses, tool calls, and tool results are lost. The user message is saved eagerly on receipt, but full conversation persistence only happens in the happy path at the end of `writeAgentResult`. If the agent loop throws, the stream disconnects, or `writer.write` fails, the catch block in the async IIFE does not save messages. The fix adds an `onTurnComplete` callback to save messages after each agent loop turn, and a fire-and-forget save in the error path.

---

## Key Design Decisions

- **Per-turn save via callback** — Add an `onTurnComplete` callback to `AgentCallbacks` that fires after each assistant response is appended to `localMessages`. The API route handler hooks this callback to call `sessionStore.saveMessages()`. This ensures intermediate state (assistant response + tool calls) is persisted even if the loop errors on a later turn or the stream disconnects.
- **Fire-and-forget save in error path** — Per the user's answer to the open question, the error-path save is best-effort (no await). This avoids blocking the error response if Cosmos DB is slow/down.
- **`session.messages` kept in sync** — Currently `session.messages` is only updated in `writeAgentResult` via `session.messages = result.messages`. The `onTurnComplete` callback will update `session.messages` on each turn so the session object always has the latest state.
- **No changes to `writeAgentResult`** — The existing happy-path save in `stream.ts` remains as the authoritative final save. The per-turn saves are incremental insurance.

---

## Files to Change

| File | Change |
|------|--------|
| `web/lib/types.ts` | Add `onTurnComplete` callback to `AgentCallbacks` interface |
| `web/lib/agent.ts` | Call `onTurnComplete` after each turn in `runAgentLoop` (after assistant message is pushed to `localMessages` and after tool results are pushed) |
| `web/app/api/agent/route.ts` | Wire `onTurnComplete` to save messages; add fire-and-forget save in catch block |
| `web/app/api/agent/confirm/route.ts` | Wire `onTurnComplete` to save messages in `resumeAfterConfirmation` path |

---

## Implementation Steps

### 1. Add `onTurnComplete` callback to `AgentCallbacks` in `web/lib/types.ts`

- Add a new optional callback to the `AgentCallbacks` interface: `onTurnComplete?: (messages: Message[]) => void`
- This fires after each complete turn (assistant response added, or tool results added) with the current accumulated messages array

### 2. Call `onTurnComplete` in `runAgentLoop` in `web/lib/agent.ts`

- After line 130 (`localMessages.push({ role: "assistant", content: response.content })`), add: if `callbacks.onTurnComplete` exists, call it with `localMessages`
- This fires after each assistant message is added — both for `end_turn` responses (right before the return) and for `tool_use` responses (before tool execution begins)
- Also fire after line 204 (`localMessages.push({ role: "user", content: toolResults })`) — after tool results are appended. This captures the complete tool call + result state before the next API call.
- Note: do NOT fire `onTurnComplete` for the `confirmation_required` return path — that's handled by `writeAgentResult` which already saves messages

### 3. Wire `onTurnComplete` in `web/app/api/agent/route.ts`

- In the callbacks object passed to `runAgentLoop` (around line 240), add an `onTurnComplete` callback that:
  - Updates `session.messages` to the latest messages array
  - Calls `void sessionStore.saveMessages(sessionId, messages).catch(...)` as fire-and-forget
  - Catches errors with a `logger.warn` to avoid breaking the agent loop
- In the `catch` block (line 268), add a fire-and-forget save: `void sessionStore.saveMessages(sessionId, session.messages).catch(...)` — since `session.messages` is now kept in sync by `onTurnComplete`, this captures whatever state was accumulated before the error

### 4. Wire `onTurnComplete` in `web/app/api/agent/confirm/route.ts`

- In the `resumeAfterConfirmation` call (around line 120), the callbacks object currently only has `onThinking` and `onToolCall`. Add `onTurnComplete` with the same pattern: update `session.messages` and fire-and-forget save
- In the catch block (around line 135), add the same fire-and-forget save of `session.messages`

---

## Verification

1. Build: `cd /Users/pkeenan/Documents/Neo/web && export PATH="/Users/pkeenan/.nvm/versions/node/v24.14.0/bin:$PATH" && npm run build 2>&1 | tail -10`
2. Run existing tests to verify no regressions: `cd /Users/pkeenan/Documents/Neo && /Users/pkeenan/.nvm/versions/node/v24.14.0/bin/node --test test/enhanced-observability-logging.test.js test/appomni-risk-analyzer.test.js test/threatlocker-maintenance-mode.test.js`
3. Manual verification: run `npm run dev`, send a message that triggers a multi-tool investigation, verify in Cosmos DB that `messageCount` is > 1 and includes assistant + tool messages
4. Manual verification: send a message, then navigate away mid-response — verify the conversation is still saved with intermediate state
