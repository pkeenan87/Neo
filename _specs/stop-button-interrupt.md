# Spec for Stop Button to Interrupt In-Flight Agent Runs

branch: claude/feature/stop-button-interrupt

## Summary

Add a stop button to the Neo web UI that lets users interrupt an in-flight agent run after submitting a prompt. The button replaces the send button while the assistant is streaming. Clicking it cleanly cancels the Anthropic API call via `AbortController`, halts the agent loop between iterations, and persists a coherent session state to Cosmos DB — including the user's original prompt, whatever assistant content streamed before the cancel, and any completed tool results. Destructive tool calls already in-flight at the moment of abort are allowed to complete and persist their results before the loop terminates.

## Functional Requirements

### Frontend
- Stop button replaces the send button while `isStreaming === true`
- Stop button uses the same visual slot as the send button with a square/stop icon instead of the arrow-up icon
- Clicking the stop button calls `AbortController.abort()` on the controller passed into the streaming `fetch` call
- After abort, the chat input is re-enabled so the user can immediately send another message
- The interrupted assistant message bubble shows a visually distinct "interrupted" indicator (e.g., a small badge or muted styling)

### Backend (API Route)
- The POST /api/agent route reads `request.signal` from the incoming NextRequest
- The signal is propagated into `runAgentLoop()` as a new parameter
- The Anthropic SDK `messages.create()` (or `messages.stream()`) call receives the signal via `{ signal }` so the streaming completion is cancelled at the network layer
- The agent loop checks `signal.aborted` between iterations and between tool executions
- When `signal.aborted` is true, the loop breaks cleanly and returns whatever messages have accumulated so far

### Cosmos Persistence (Critical)
- **User message persisted on turn start** — The user's prompt must be saved to Cosmos DB as the very first thing that happens in the request handler, before any model call. This is already partially implemented (incremental persistence was added earlier) but should be explicitly called out as the first side effect of the turn.
- **Partial assistant message on abort** — When the loop is interrupted, the partial assistant message (whatever content streamed before cancellation) must be persisted with a status flag `interrupted: true` in the session's message metadata.
- **Completed tool calls persisted** — Tool calls that finished successfully before the abort are persisted with their results as normal.
- **In-flight tool calls marked cancelled** — Tool calls that were in-flight at the moment of abort are marked with a status indicator so the next turn's context is coherent.

### Tool Execution Semantics
- **Destructive/stateful executors** (e.g., `reset_user_password`, `isolate_machine`, `approve_threatlocker_request`, `block_indicator`, `set_maintenance_mode`, etc.): the abort signal is NOT propagated into these tool calls. If they are in-flight at the moment of abort, let them complete and persist their result, then break the agent loop.
- **Read-only executors** (e.g., `run_sentinel_kql`, `get_user_info`, `search_abnormal_messages`, `list_appomni_findings`): the abort signal CAN be propagated to cancel the HTTP call since the side effects are safe to discard.
- The `DESTRUCTIVE_TOOLS` set already classifies destructive tools — use it to gate which executors receive the signal.

### UI Feedback
- After abort, the chat shows the interrupted assistant message with a subtle indicator (e.g., an orange border, "Interrupted" badge, or italic muted text appended)
- The send button re-enables immediately so the user can send a follow-up
- No modal or confirmation — stop is a direct action

## Possible Edge Cases

- Stop clicked before any response streams — abort must still persist the user message; the assistant side returns empty (no partial content to save)
- Stop clicked during a tool call — destructive tools complete, read-only tools cancel; partial assistant content (reasoning text before the tool call) is preserved
- Stop clicked during context trimming / Haiku compression — abort should cancel the compression too since it's read-only
- Multiple rapid stop clicks — `AbortController.abort()` is idempotent; subsequent clicks are no-ops
- Abort fires after `writeAgentResult` has already saved — the abort is a no-op (normal completion already persisted)
- Network disconnect vs. intentional abort — both trigger the same code path; distinguishing them isn't necessary since both should persist partial state
- `DOMException` with `name === "AbortError"` must be caught separately from other errors so the abort path persists cleanly without rethrowing
- Teams and CLI channels are OUT OF SCOPE for this iteration — this is web-only
- Scheduled/autonomous task cancellation is OUT OF SCOPE — separate future ticket

## Acceptance Criteria

- [ ] Stop button appears in the web UI while a run is streaming and is hidden otherwise
- [ ] Clicking stop cancels the Anthropic API call within ~1 second
- [ ] User message is always present in Cosmos DB after abort, regardless of when the user clicked stop
- [ ] Partial assistant message is persisted with `interrupted: true` and any completed tool results are included
- [ ] Next turn in the same session loads cleanly and references the interrupted message without errors
- [ ] Destructive executors in-flight at abort time complete and persist their results
- [ ] Read-only executors in-flight at abort time are cancelled cleanly
- [ ] UI shows an "interrupted" indicator on the interrupted assistant message bubble
- [ ] Send button re-enables immediately after abort
- [ ] Abort works during agent loop iterations AND during tool execution phases
- [ ] No regression in normal happy-path chat flow

## Open Questions

- Should the "interrupted" indicator be a badge, a border color, an icon, or a combination? a badge
- Should we log a dedicated `session_interrupted` structured event for analytics dashboards? yes
- Should the stop button have a keyboard shortcut (e.g., Escape)? no
- When the loop is interrupted mid-tool, should the partial assistant message include a synthetic "[interrupted]" text block so Claude's next turn sees coherent context? yes

## Testing Guidelines

Create test file(s) in `./test/` for:

- `AbortController` signal propagation: signal passed to `runAgentLoop` triggers loop exit
- Agent loop iteration check: `signal.aborted` between iterations breaks the loop
- Agent loop tool check: `signal.aborted` between tool executions breaks the loop
- Destructive tool bypass: destructive tools are NOT passed the signal even when abort is pending
- Read-only tool propagation: read-only tools receive the signal and can cancel
- Persistence on abort: user message is saved before any model call
- Persistence on abort: partial assistant message is saved with `interrupted: true` flag
- `DOMException AbortError` is caught separately from generic errors in the catch block
- Idempotent abort: multiple `abort()` calls don't throw or cause duplicate saves
