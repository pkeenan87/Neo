# Stop Button to Interrupt In-Flight Agent Runs

## Context

Add an interrupt mechanism to the Neo web chat. The frontend gets a stop button that replaces the send button while `isLoading === true`, clicking it aborts the NDJSON fetch via `AbortController`, and the backend propagates the abort signal through the agent loop so the Anthropic SDK call is cancelled at the network layer. Critical persistence rules: the user message is always saved before the model call, partial assistant content is persisted with an `interrupted: true` flag, destructive tool calls in-flight complete before the loop terminates (read-only tools receive the signal and cancel), and the interrupted message renders with a visual badge on reload.

---

## Key Design Decisions

- **`AbortController` on the frontend, `request.signal` on the backend** — Next.js App Router exposes `request.signal` on `NextRequest`, which is aborted when the client disconnects or calls `controller.abort()`. No separate cancellation endpoint needed.
- **Propagate signal into agent loop via new `signal` parameter** — Add `signal?: AbortSignal` to `runAgentLoop`'s signature, plumb it through to `createWithRetry` which passes it to `client.messages.create()` as the second-arg `{ signal }` request options.
- **Check `signal.aborted` at safe break points** — Between loop iterations, between tool executions, and before/after the API call. Never in the middle of a destructive tool call.
- **Destructive tool bypass** — Already have `DESTRUCTIVE_TOOLS` Set in `tools.ts`. Tool execution for destructive tools does NOT receive the signal. For read-only tools, pass the signal through so their HTTP calls can cancel cleanly (requires threading signal into fetch calls in executors.ts — limited to read-only tools only in this iteration).
- **`interrupted` flag on the assistant message** — Since `Anthropic.Messages.MessageParam` content is strictly typed, the flag is stored via the message's text content: append a synthetic "[interrupted]" text block to the partial assistant content so Claude's next turn sees coherent context (per the user's answer to the open question). For rendering, the `ChatMessage` type in ChatInterface gets a new `interrupted?: boolean` field inferred from the text block.
- **Persist on abort via existing `onTurnComplete` + catch block** — The incremental persistence we already built (from the previous "fix database persistence" work) handles most of this. We add one more save in the `AbortError` catch branch to ensure the final interrupted state lands in Cosmos.
- **New `session_interrupted` structured event** — Per the user's answer, emit a dedicated logger event for analytics dashboards.
- **No keyboard shortcut** — Per the user's answer, no Escape key binding.
- **Out of scope** — Teams, CLI, and scheduled tasks. Spec explicitly defers these.

---

## Files to Change

| File | Change |
|------|--------|
| `web/lib/types.ts` | Add `LogEventType` case `"session_interrupted"` to the union; no new interfaces needed |
| `web/lib/agent.ts` | Add `signal?: AbortSignal` parameter to `runAgentLoop` and `createWithRetry`; propagate into `client.messages.create()`; check `signal.aborted` between iterations and tool executions; catch `AbortError` and return partial messages with interrupted marker |
| `web/lib/executors.ts` | Add optional `signal?: AbortSignal` context parameter to `executeTool`; pass it through to read-only tool HTTP calls; destructive tools ignore the signal |
| `web/app/api/agent/route.ts` | Pass `request.signal` into `runAgentLoop`; catch `AbortError` in the async IIFE and emit the `session_interrupted` event + persist final state before closing writer |
| `web/lib/logger.ts` | Add `"session_interrupted"` to the `LogEventType` union and to the operational event type set (routed to the primary hub) |
| `web/components/ChatInterface/ChatInterface.tsx` | Add `abortControllerRef` state; create new `AbortController` per request; pass `controller.signal` to `fetch`; show stop button when `isLoading` is true; add `handleStop()` that calls `controller.abort()`; detect interrupted assistant messages and render a badge; update `conversationToChatMessages` to detect the interrupted marker text and set the badge field |
| `web/components/ChatInterface/ChatInterface.module.css` | Add `.stopBtn` styles (red/warning variant of `.sendBtn`) and `.interruptedBadge` |
| `test/stop-button-interrupt.test.js` | New test file verifying signal propagation, abort behavior, persistence, and tool execution semantics |

---

## Implementation Steps

### 1. Add `session_interrupted` event type to `web/lib/logger.ts` and `web/lib/types.ts`

- In `web/lib/types.ts`, add `"session_interrupted"` to the `LogEventType` union
- In `web/lib/logger.ts`, ensure `session_interrupted` routes to the operational Event Hub (add to the operational set, not the analytics set — this is an audit event that belongs alongside `destructive_action` and `budget_alert`)
- Add `session_interrupted` to the safe metadata allowlist if any new metadata fields are needed (e.g., `interruptedAtTurn` counter)

### 2. Update `runAgentLoop` and `createWithRetry` in `web/lib/agent.ts`

- Add `signal?: AbortSignal` as a new parameter to `runAgentLoop` (after `model`)
- Add `signal?: AbortSignal` as a second parameter to `createWithRetry`
- Inside `createWithRetry`, pass `{ signal }` as the second argument to `client.messages.create(params, { signal })`
- Inside `runAgentLoop`, at the top of the `while (true)` loop, check `if (signal?.aborted)` — if true, break and return a special interrupted result
- After the API call returns and the assistant message is pushed to `localMessages`, check `signal?.aborted` again — if true, append a synthetic text block `{ type: "text", text: "[interrupted]" }` to the last assistant message's content array and return `{ type: "response", text: "[interrupted]", messages: localMessages, interrupted: true }`
- Inside the tool-use branch, after processing each tool execution (both successful and failed), check `signal?.aborted` — if true, append the interrupted marker and return
- Wrap the entire function body in a `try/catch` that specifically catches `AbortError` (check `err instanceof DOMException && err.name === "AbortError"` OR `(err as Error).name === "AbortError"`), and returns the same interrupted result shape instead of rethrowing
- Add a new `interrupted?: boolean` field to the `AgentLoopResult` return type in `web/lib/types.ts` (for the `{ type: "response" }` variant)

### 3. Update `executeTool` signature in `web/lib/executors.ts` for read-only signal propagation

- Add `signal?: AbortSignal` to the `ExecuteToolContext` interface
- For read-only tools (any tool NOT in `DESTRUCTIVE_TOOLS`), pass `signal` through to their underlying `fetch()` calls — this requires threading it through the config helpers like `abnormalApi()`, `appOmniApi()`, etc. In this iteration, only the read-only tools' HTTP calls get the signal; destructive tools continue without it.
- For simplicity, ONLY instrument the most common read-only tools in this first iteration: `run_sentinel_kql`, `get_user_info`, `search_abnormal_messages`, and a few high-frequency ones. Other read-only tools can be updated incrementally.
- Note: the agent loop calls `executeTool(name, input, { sessionMessages, signal })` where `signal` is the loop's signal. Destructive tools still receive the `signal` in the context but are expected to ignore it.

### 4. Update `web/app/api/agent/route.ts` to pass `request.signal` and handle abort

- Inside the async IIFE that runs the agent loop, pass `request.signal` as the new `signal` parameter to `runAgentLoop(apiMessages, callbacks, session.role, sessionId, model, request.signal)`
- In the catch block of the IIFE, detect `AbortError` specifically (`err instanceof DOMException && err.name === "AbortError"` or `(err as Error).name === "AbortError"`)
- On AbortError path:
  - Emit `logger.emitEvent("session_interrupted", "Agent run interrupted by user", "api/agent", { sessionId })`
  - Save the current `session.messages` (which now includes the interrupted marker from the loop's return) to Cosmos via `sessionStore.saveMessages()`
  - Write a final `type: "interrupted"` event to the NDJSON stream so the client knows the loop stopped cleanly
  - Do NOT write the generic `"error"` event — that's for real failures
- Non-abort errors continue to use the existing `logger.error` + generic error event path
- If the agent loop returns with `result.interrupted === true` (signal-aborted but handled gracefully inside the loop), emit the `session_interrupted` event and save messages the same way before writing a final `type: "response"` event with the interrupted marker

### 5. Update `AgentLoopResult` type and `writeAgentResult` helper

- In `web/lib/types.ts`, add `interrupted?: boolean` to the `{ type: "response"; ... }` variant of `AgentLoopResult`
- In `web/lib/stream.ts`, update `writeAgentResult` to check `result.interrupted` on the `response` variant. If interrupted, write a new NDJSON event type (e.g., `{ type: "interrupted" }`) in addition to the response, and still call `sessionStore.saveMessages` as usual
- Add `"interrupted"` to the `AgentEvent` union in `web/lib/types.ts`

### 6. Update frontend `ChatInterface.tsx` — abort controller and stop button

- Add `const abortControllerRef = useRef<AbortController | null>(null)` near the other refs
- In `handleSendMessage`, before the fetch call, create a new `AbortController` and store it in `abortControllerRef.current`; pass `controller.signal` to the `fetch()` options
- After the response finishes (happy path or stream end), clear `abortControllerRef.current = null`
- Add a `handleStop` function that calls `abortControllerRef.current?.abort()` and clears the ref
- In the input actions area where `sendBtn` is rendered, conditionally render the stop button when `isLoading === true`:
  - Stop button uses a `Square` lucide icon instead of `ArrowUp`
  - On click: `handleStop()`
  - Uses new `styles.stopBtn` class
- The send button should be hidden (not just disabled) when `isLoading` is true so only the stop button shows
- Handle the new NDJSON event types in `processNDJSONStream`:
  - `type: "interrupted"` — mark the last assistant message with `interrupted: true` in the local messages state

### 7. Update message rendering in `ChatInterface.tsx` to show interrupted badge

- Extend the `ChatMessage` interface with an optional `interrupted?: boolean` field
- In `conversationToChatMessages`, detect when an assistant message's content includes the synthetic `[interrupted]` text block — when found, set `interrupted: true` on the resulting `ChatMessage` and strip the marker from the displayed text
- In the message rendering JSX (near where `skillBadge` is rendered), add conditional rendering for an "Interrupted" badge when `msg.interrupted === true`
- The badge should be visually distinct (e.g., warning-500 color with 10% opacity background), styled similarly to the existing skill badge

### 8. Add styles in `web/components/ChatInterface/ChatInterface.module.css`

- Add `.stopBtn` class matching `.sendBtn` dimensions but with a warning/red color scheme (e.g., `background: #ef4444` light mode, `background: #b91c1c` dark mode)
- Hover state: slightly darker (`#dc2626` light, `#991b1b` dark)
- Add `.interruptedBadge` class for the message bubble indicator: small inline badge with warning-500 color, 10% opacity background, rounded, 0.75rem text

### 9. Create test file `test/stop-button-interrupt.test.js`

- Tests for:
  - `AbortSignal` propagation: a mock `runAgentLoop` with an aborted signal returns early with `interrupted: true`
  - Interrupted marker: when signal aborts mid-loop, the last assistant message has an "[interrupted]" text block appended
  - `DESTRUCTIVE_TOOLS` membership check: destructive tools list matches expected set
  - `AbortError` detection: `new DOMException("aborted", "AbortError")` is correctly identified
  - Event type: `session_interrupted` is in the valid `LogEventType` union
  - Idempotent abort: calling `abort()` twice is a no-op
  - UI rendering: `ChatMessage.interrupted === true` would render an "Interrupted" badge (logical test)

---

## Verification

1. Build: `cd /Users/pkeenan/Documents/Neo/web && export PATH="/Users/pkeenan/.nvm/versions/node/v24.14.0/bin:$PATH" && npm run build 2>&1 | tail -10`
2. Run new tests: `cd /Users/pkeenan/Documents/Neo && /Users/pkeenan/.nvm/versions/node/v24.14.0/bin/node --test test/stop-button-interrupt.test.js`
3. Run existing tests for regressions: `cd /Users/pkeenan/Documents/Neo && /Users/pkeenan/.nvm/versions/node/v24.14.0/bin/node --test test/file-upload.test.js test/toggle-usage-limits.test.js test/enhanced-observability-logging.test.js`
4. Manual: Run `npm run dev`, send a prompt that triggers a long multi-turn investigation, click stop mid-stream, verify:
   - The stream stops within ~1 second
   - The user message persists in Cosmos
   - The partial assistant message shows an "Interrupted" badge
   - The send button re-enables immediately
   - A follow-up message in the same session works
5. Manual: Send a prompt that triggers a destructive tool (e.g., `reset_user_password`), click stop during the confirmation gate — verify the gate still works and the destructive action is not bypassed
6. Manual: Send a prompt that triggers an Abnormal Security API call, click stop during the API call — verify the read-only call cancels cleanly and partial state persists
7. Manual: Reload a conversation containing an interrupted message — verify the badge displays correctly
