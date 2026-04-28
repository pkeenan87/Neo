# Output Budget

## Context

Neo's agent loop hits Anthropic's 200 K input-token ceiling mid-turn during long investigations, surfacing as the opaque "Agent ran out of output budget while planning a tool call" error and silently aborting in-flight workflows. Per `_specs/output-budget.md`, the fix spans proactive per-turn input-token budgeting, a two-tier compression cascade that fires *before* Claude errors, in-flight tool-result offload to complement the existing persistence-time offload, a machine-readable in-progress plan so truncated multi-step workflows can resume, a user-visible status event that replaces the generic error, and destructive-batch input preflights. All changes are server-side except for a small new status-card pattern in the web chat UI and an equivalent stderr notice in the CLI.

---

## Key Design Decisions

- **Proactive ceiling lives in `context-manager.ts`, not `agent.ts`.** `prepareMessages` already centralises trim/compress; extending the check to use a dedicated `NEO_CONTEXT_MAX_INPUT_TOKENS` ceiling (separate from `TRIM_TRIGGER_THRESHOLD`) keeps the trigger logic in one module. `TRIM_TRIGGER_THRESHOLD` stays as the *start compressing* watermark; the new ceiling is the *must not exceed* watermark.
- **Reorder compression trigger, not the compression algorithm.** The existing `compressOlderMessages` + `validateAndRepairConversationShape` + emergency-truncation loop is correct; the bug is that today it runs after Haiku already errored when the Haiku call itself was over 200 K. Pre-truncate the Haiku input (capped middle slice) to a dedicated `HAIKU_INPUT_MAX_TOKENS` budget before calling the Haiku API.
- **Single anchor-trim helper for huge first messages.** Currently the anchor (first user message) is always preserved verbatim. Add a `maybeSummarizeAnchor` helper that fires only when the first message alone exceeds a `FIRST_MESSAGE_MAX_TOKENS` cap, replacing it with a Haiku summary in-place.
- **In-flight offload is opt-in per turn.** Only applied when projected prompt exceeds ceiling. This keeps short sessions fast; large sessions convert oversized tool results in earlier turns to envelope strings matching `wrapAndMaybeOffloadToolResult`. The current turn's tool result (the one the agent is about to reason over) is NEVER offloaded — that would require a pointless extra `get_full_tool_result` round-trip.
- **In-progress plan lives on the conversation root as a new typed field.** Storing it in the root doc (rather than a synthetic system message) keeps the message array clean and matches how `pendingConfirmation` is already handled. The field type is `InProgressPlan | null` with a versioned shape so future plan formats can evolve. Dispatched through both v1 (`replace` full doc) and v2 (`patch` root) via the existing `dual-write` / `dual-read` plumbing.
- **Plan capture is agent-side, not server-side parsing.** Rather than regexing assistant text for "Action plan:" strings, add a dedicated tool `emit_plan` that the system prompt teaches the agent to call when starting a multi-step batch. Explicit signal beats fragile pattern-match. Falls back to detecting the `stop_reason: "max_tokens"` with `phase: "tool_use"` (existing `IncompleteToolUseError` path) and recording whatever text the previous assistant turn contained as a best-effort plan.
- **Plan resumption is automatic, not click-to-continue.** Matches the spec's Question 2 — option A. Rationale: users in the Notion incident log already typed follow-ups trying to continue ("lets remediate 5 at a time, start with the first 5"). Forcing an extra click adds friction for no safety benefit; the plan is already gated behind a new user message.
- **User-visible truncation feedback uses two distinct events, not one.** Input-context compression and max-tokens output truncation are different conditions. The NDJSON stream already has `context_trimmed` for the former; add `output_truncated` (replaces today's `{ type: "error", code: "INCOMPLETE_TOOL_USE" }`) for the latter. Two events → two UI cards → two recovery actions.
- **Destructive batch preflight lives in `abnormal-helpers.ts` / tool executors, not a new middleware layer.** Extends `validateRemediateInput` with a `MAX_EXPLICIT_MESSAGES` cap (default 20). Mirrors the existing validation pattern — zero new indirection.
- **No schema change to Anthropic tool shapes.** `emit_plan` is a new tool entry in `tools.ts`; all other tools are unchanged.
- **Backward-compat for in-flight sessions.** If the deploy catches users mid-session with no `inProgressPlan` field, reads return `null` (field optional in type; deserializer tolerates missing key); next truncation on that session populates it. No migration needed.

---

## Files to Change

| File | Change |
|------|--------|
| `web/lib/config.ts` | Add `NEO_CONTEXT_MAX_INPUT_TOKENS` (default 180 000), `HAIKU_INPUT_MAX_TOKENS` (default 160 000), `FIRST_MESSAGE_MAX_TOKENS` (default 100 000), and `REMEDIATE_MAX_EXPLICIT_MESSAGES` (default 20). Boot-time sanity check: assert `TRIM_TRIGGER_THRESHOLD < NEO_CONTEXT_MAX_INPUT_TOKENS < 200 000`. |
| `web/lib/context-manager.ts` | Split `prepareMessages` into two passes: (1) the existing trim+compress path using `TRIM_TRIGGER_THRESHOLD`, (2) a new ceiling-enforcement pass that runs AFTER compression and guarantees the final estimate is below `NEO_CONTEXT_MAX_INPUT_TOKENS`. Add `maybeSummarizeAnchor` (Haiku call; gated by `FIRST_MESSAGE_MAX_TOKENS`). Add in-flight offload via a new `offloadLargeToolResultsInPrompt` helper that replaces oversized `tool_result.content` strings with trust-marked envelope strings (same format as `injection-guard.ts#wrapAndMaybeOffloadToolResult`). Cap Haiku compression input to `HAIKU_INPUT_MAX_TOKENS` by additional pre-trimming of the capped middle slice. |
| `web/lib/types.ts` | Add `InProgressPlan` interface (`createdAt: string`, `planText: string`, `toolCallsRemaining: number`, `originalTurnNumber: number`, `schemaVersion: 1`). Add `inProgressPlan?: InProgressPlan \| null` to `Conversation` and `ConversationV2Root`. Add `"output_truncated"` to `AgentEvent` union with `{ phase: "tool_use" \| "text", remainingPlan?: InProgressPlan \| null }`. Add `"context_engineering"` to `LogEventType` for the emergency-truncation audit signal. |
| `web/lib/tools.ts` | Add a new `emit_plan` tool schema (non-destructive, always available to the agent). Inputs: `{ steps: string[], estimatedToolCalls: number }`. Register in the tool list and the `emit_plan` function name in executors. |
| `web/lib/executors.ts` | Add `emit_plan` executor that writes `InProgressPlan` to the session via a new `sessionStore` method. Extend `validateRemediateInput` call in `remediate_abnormal_messages` to reject when `messages.length > REMEDIATE_MAX_EXPLICIT_MESSAGES` with a clear error pointing at chunking. |
| `web/lib/abnormal-helpers.ts` | Extend `validateRemediateInput` to accept a `maxExplicitMessages` option (default from config) and throw a typed `BatchTooLargeError` when exceeded. |
| `web/lib/agent.ts` | In the `max_tokens` / `IncompleteToolUseError` branch, read any `inProgressPlan` already on the session and emit a new `output_truncated` NDJSON event (carrying `remainingPlan` if present). When a NEW user turn arrives and the session has an `inProgressPlan`, inject a structured system-prompt addendum before the Claude call explaining the plan and instructing the agent to resume from the unexecuted steps. Clear `inProgressPlan` when `stop_reason: "end_turn"` fires AND the plan's `estimatedToolCalls` budget has been exhausted. |
| `web/lib/session-store.ts` | Add `setInProgressPlan(id, plan \| null)` and `getInProgressPlan(id)` to the `SessionStore` interface. |
| `web/lib/conversation-store.ts` | Implement v1 `setInProgressPlan` via the existing replace-with-ETag pattern. Wire the dispatch so `dual-read` / `dual-write` use the existing `dualReadWriteWithV1Fallback` / `dualWriteV2BestEffort` helpers and `DualWriteDivergencePayload.operation` gains a `"setInProgressPlan"` case. |
| `web/lib/conversation-store-v2.ts` | Implement `setInProgressPlanV2` as a narrow root patch (mirrors `setConversationPendingConfirmationV2`); throw `ConversationNotFoundV2Error` on missing root. Include the field in `splitConversationToDocs` (preserves round-trip) and `rebuildConversationFromDocs`. |
| `web/lib/session-factory.ts` | Add `setInProgressPlan` / `getInProgressPlan` to `DispatchingSessionStore`. Dual-read write path uses `v2WriteWithV1Fallback` on `ConversationNotFoundV2Error`. |
| `web/lib/mock-conversation-store.ts` | Add in-progress-plan support to the mock store (stored on the mock conversation doc alongside `pendingConfirmation`) for `MOCK_MODE=true` parity. |
| `web/app/api/agent/route.ts` | Replace the `code: "INCOMPLETE_TOOL_USE"` error write with an `output_truncated` NDJSON event that carries the remaining plan. Remove the now-dead generic "try a more focused follow-up" string. |
| `web/app/api/agent/confirm/route.ts` | Apply the same replacement in the confirm route's `IncompleteToolUseError` handler. |
| `web/components/ChatInterface/ChatInterface.tsx` | Handle the new `context_trimmed` and `output_truncated` NDJSON events by rendering a distinct status card (mirrors existing `confirmation_required` pattern): context-trimmed is a passive "summary inserted" notice; output-truncated is an actionable "continue" card that shows the remaining plan and hints at automatic resumption on the next turn. Keep ANSI-free, respect `prefers-reduced-motion`, reuse existing card tokens from `ChatInterface.module.css`. |
| `web/components/ChatInterface/ChatInterface.module.css` | New `.statusCard` variant classes for the two states (context-trimmed info vs output-truncated action). Follow the 3-class inline rule + `@reference` header pattern. |
| `cli/src/server-client.js` | The `processStream` NDJSON decoder already dispatches unknown event types; wire the two new event types to new optional callbacks `onContextTrimmed` / `onOutputTruncated`. |
| `cli/src/index.js` | REPL + `neo prompt` plain-mode render the new events to stderr as one-line notices (`[context compressed — N → M tokens]`, `[output truncated; next turn will resume]`). `--json` mode inherits pass-through via the existing `onRawEvent` hook. |
| `docs/user-guide.md` | New subsection under "Using the CLI" → "Context management" explaining how compression appears, what "continue on next turn" means, and the `emit_plan` tool's purpose. |
| `docs/configuration.md` | Add the four new env vars to the environment-variable table + explain the budget hierarchy (`TRIM_TRIGGER_THRESHOLD < NEO_CONTEXT_MAX_INPUT_TOKENS < 200K`). |
| `.env.example` | Add the four new env vars with defaults + comments. |
| `web/test/context-manager-budget.test.ts` | **NEW** — unit tests for the proactive ceiling, Haiku pre-trimming, anchor summarisation, and in-flight offload. |
| `web/test/agent-plan-resumption.test.ts` | **NEW** — mid-tool-use truncation → in-progress-plan persisted → next user turn resumes. |
| `web/test/api-agent-output-truncated-event.test.ts` | **NEW** — route-level test that `output_truncated` and `context_trimmed` are distinct NDJSON events. |
| `web/test/destructive-batch-preflight.test.ts` | **NEW** — `remediate_abnormal_messages` rejects batches > 20 with a clear error. |
| `web/test/dual-store-in-progress-plan.test.ts` | **NEW** — dual-write / dual-read routing of the in-progress-plan field, including v1-only fallback. |
| `web/test/emit-plan-tool.test.ts` | **NEW** — `emit_plan` writes to the session and is a no-op when called a second time in the same turn without a new plan. |
| `web/test/conversation-store-v2-schema.test.ts` | Extend split/rebuild round-trip to cover the new `inProgressPlan` field. |
| `web/test/dispatching-session-store.test.ts` | Extend to cover `setInProgressPlan` / `getInProgressPlan` dispatch across all four modes. |

---

## Implementation Steps

### 1. Config + types scaffolding

- Add four env-var parses in `lib/config.ts`: `NEO_CONTEXT_MAX_INPUT_TOKENS`, `HAIKU_INPUT_MAX_TOKENS`, `FIRST_MESSAGE_MAX_TOKENS`, `REMEDIATE_MAX_EXPLICIT_MESSAGES`. Export defaults (180 000, 160 000, 100 000, 20).
- Extend the existing boot-time sanity-check block: warn if `TRIM_TRIGGER_THRESHOLD >= NEO_CONTEXT_MAX_INPUT_TOKENS` (compression would never enforce the ceiling) or if `NEO_CONTEXT_MAX_INPUT_TOKENS >= 200 000` (no headroom).
- Add `InProgressPlan` interface to `lib/types.ts` with fields `createdAt`, `planText`, `toolCallsRemaining`, `originalTurnNumber`, `schemaVersion: 1`. Export a version guard helper `isInProgressPlan(value)`.
- Add the optional `inProgressPlan?: InProgressPlan | null` field to both `Conversation` and `ConversationV2Root`.
- Add `"output_truncated"` to the `AgentEvent` union. Payload: `{ type: "output_truncated"; phase: "tool_use" | "text"; message: string; remainingPlan?: InProgressPlan | null }`.
- Add `"setInProgressPlan"` to `DualWriteDivergencePayload.operation`.
- Add `BatchTooLargeError` class (mirrors `CsvAttachmentCapError` — `extends Error`, preserves its own prototype, carries `actual` and `limit` numeric fields).

### 2. Proactive ceiling in context-manager

- Inside `prepareMessages`, after the existing compress-if-over-threshold block (ends at line ~521 today), add a new "ceiling guard" block: re-estimate tokens on the returned compressed messages, and if still above `NEO_CONTEXT_MAX_INPUT_TOKENS`, invoke the existing emergency-truncation loop directly (not as a fallback inside `compressOlderMessages`, but as a standalone pass). Promote the emergency-truncation loop body into an exported `enforceCeiling(messages, ceiling, systemPromptTokenEstimate)` helper for reuse + testability.
- Add `maybeSummarizeAnchor(messages, systemPromptTokenEstimate)` helper in the same file. Fires only when the first user-role message's estimated tokens > `FIRST_MESSAGE_MAX_TOKENS`. Calls Haiku with the first message as input, replaces with `"[Anchor summary — original was N tokens]\n" + summary`. Failure path: hard truncate to `FIRST_MESSAGE_MAX_TOKENS` characters (chars, not tokens, for safety) with a "[anchor truncated]" marker.
- Call `maybeSummarizeAnchor` from `prepareMessages` before `compressOlderMessages` so the anchor itself doesn't dominate the compression budget.
- In `compressOlderMessages`, before the Haiku call, pre-trim `validatedMiddle` so its own estimated tokens are below `HAIKU_INPUT_MAX_TOKENS`. Use `findSafeSliceStart` to keep tool pairs intact when dropping from the start.
- Log a dedicated `logger.emitEvent("context_engineering", ...)` line for every compression/enforcement path that fired, with fields `{ reason, originalTokens, afterCompressionTokens, afterEnforcementTokens }`. Emission goes through `LogEventType` so dashboards can alert on it.

### 3. In-flight tool-result offload

- In `context-manager.ts`, add `offloadLargeToolResultsInPrompt(messages, { conversationId, skipLastTurn: true })`. Iterates through messages, for each `tool_result` block whose `content` is a string over `PER_TOOL_RESULT_TOKEN_CAP * CHARS_PER_TOKEN`, replaces the content with the same trust-marked envelope string that `wrapAndMaybeOffloadToolResult` produces (call `maybeOffloadToolResult` from `tool-result-blob-store.ts`). `skipLastTurn: true` protects the current turn's tool results from being offloaded and then immediately re-fetched.
- Wire `offloadLargeToolResultsInPrompt` into `prepareMessages` — only called when projected tokens exceed `NEO_CONTEXT_MAX_INPUT_TOKENS` and before any compression. Order: anchor-summarise → in-flight offload → compress → enforce ceiling.
- Update the existing `truncateToolResults` path so it runs only AFTER the offload path; a blob-offloaded tool result (envelope string) should be smaller than the truncation cap and skipped.

### 4. `InProgressPlan` session persistence

- Add `setInProgressPlan(id, plan | null)` and `getInProgressPlan(id)` to the `SessionStore` interface in `lib/session-store.ts`.
- Implement in `CosmosSessionStore` (v1) via read-with-etag → set `resource.inProgressPlan` → `container.item(id, ownerId).replace(resource, { accessCondition })`, retry once on 412.
- Implement `setInProgressPlanV2` in `lib/conversation-store-v2.ts` as a narrow root patch at `/inProgressPlan`. Throw `ConversationNotFoundV2Error` when missing root.
- Add `setInProgressPlan` dispatch in `lib/conversation-store.ts` top-level function with the standard 4-mode switch. Reuse `dualReadWriteWithV1Fallback` + `dualWriteV2BestEffort`.
- Thread the new method through `DispatchingSessionStore` in `lib/session-factory.ts`, mirroring the shape of `setPendingConfirmation`.
- Extend `splitConversationToDocs` / `rebuildConversationFromDocs` so the field round-trips through the v2 schema.
- Add mock-store support in `lib/mock-conversation-store.ts` (field on the disk doc).

### 5. `emit_plan` tool

- Add the tool schema entry in `lib/tools.ts`: `name: "emit_plan"`, description: "Call this at the start of a multi-step batch operation to persist the full plan. Neo will retain the remaining steps if this turn runs out of output budget, and resume them on your next turn." Inputs: `{ steps: string[] (min 1, max 50), estimatedToolCalls: number }`. Mark as non-destructive.
- Add the executor in `lib/executors.ts`. It reads the current sessionId from the tool context, builds an `InProgressPlan`, and calls `sessionStore.setInProgressPlan(sessionId, plan)`. Returns `{ acknowledged: true, stepCount: steps.length }` to the agent.
- Extend `agent.ts` to pass `sessionId` into the executor dispatch context so `emit_plan` can look it up (current context already threads it for blob offload — reuse).

### 6. Agent-loop truncation recovery

- In `agent.ts`, at the top of each loop iteration: read `sessionStore.getInProgressPlan(sessionId)` once per turn. If present AND this iteration is the *first* iteration of a new user turn (detect via `iterationCount === 0`), append a system-prompt addendum string explaining: "The previous turn was truncated mid-execution. Here is the remaining plan: [planText]. Pick up from the unexecuted steps without re-prompting the user for confirmation." Use `cache_control: ephemeral` on the addendum so it doesn't fight the main system-prompt cache.
- When `stop_reason: "end_turn"` fires AND `response.usage.output_tokens > 0` AND `inProgressPlan.toolCallsRemaining > 0`, decrement `toolCallsRemaining` by the number of `tool_use` blocks executed this turn. If it reaches 0, clear the plan with `setInProgressPlan(id, null)`.
- In the existing `IncompleteToolUseError` branch (end of the loop), before `throw`, record `setInProgressPlan(id, <current plan with updated counters>)` if a plan exists. If no plan exists, best-effort capture the text content of the last assistant message as a `planText` fallback.

### 7. NDJSON event split

- In `lib/stream.ts` and `lib/agent.ts`, replace the `code: "INCOMPLETE_TOOL_USE"` error write at both emit sites (agent route + confirm route) with an `output_truncated` NDJSON event carrying `{ phase: "tool_use", message: <human-readable>, remainingPlan: <plan or null> }`.
- Keep `context_trimmed` untouched (already emitted from the agent route on line 486). Ensure both events fire in the correct order: `context_trimmed` → any tool calls → `output_truncated` (if it fires at all).
- The existing `"error"` event type remains reserved for actual infra failures (agent errors, unhandled exceptions).

### 8. Destructive-batch preflight

- Extend `validateRemediateInput` in `lib/abnormal-helpers.ts` to accept `options: { maxExplicitMessages?: number }`. When `input.messages && input.messages.length > maxExplicitMessages`, throw `BatchTooLargeError` with actual + limit + a clear fix hint ("chunk to ≤N per call").
- In `lib/executors.ts`, pass `{ maxExplicitMessages: REMEDIATE_MAX_EXPLICIT_MESSAGES }` when calling `validateRemediateInput`. Catch `BatchTooLargeError` at the tool boundary and return a structured error that the agent can read (surface as a tool_result with `isError: true` and the fix hint — NOT a thrown exception that aborts the loop).
- Audit other destructive tools (`isolate_machine`, `unisolate_machine`) for similar batch-input vectors. If any take arrays, wire the same preflight; if not, document why they're exempt.

### 9. Web UI status cards

- In `ChatInterface.tsx`, extend the NDJSON event switch to handle `context_trimmed` and `output_truncated`. Each creates a synthetic non-assistant message with `kind: "statusCard" | "actionCard"` (new discriminator on the local chat message shape) rendered by a small new `StatusCard` subcomponent.
- `context_trimmed` card is compact: "Context compressed from N → M tokens". No action. Auto-collapsible.
- `output_truncated` card is a call-to-action: "The previous response didn't fit. Type your next message and Neo will pick up from: <planText preview>." Includes a "show full plan" disclosure for the remaining steps.
- Follow CLAUDE.md styling rules: 3-class inline rule, CSS module with `@reference`, no `hover:opacity-*`, only shade tokens, `:focus-visible` outline.
- Gate any entry animation behind `@media (prefers-reduced-motion: no-preference)`. Add `aria-live="polite"` on the card container.

### 10. CLI renderers

- In `cli/src/server-client.js#processStream`, extend the switch to dispatch new event types to optional callbacks `onContextTrimmed` and `onOutputTruncated`. Existing `onRawEvent` path continues to receive every event before the switch (covers `--json` mode).
- In `cli/src/index.js`, the REPL `callbacks` object gets two new handlers. `onContextTrimmed` prints a single gray stderr line (`[context compressed — N → M tokens]`). `onOutputTruncated` prints a yellow stderr line (`[output truncated — type your next message to resume]`) and if a `remainingPlan` is present, prints the plan as a dimmed block beneath.
- `neo prompt` plain mode: same stderr lines. `--json` mode: existing raw pass-through covers it, no change.

### 11. Docs + env

- `docs/user-guide.md`: add a "Context management" subsection under "Using the CLI" that explains what the two status cards mean, when they fire, and how the automatic resumption works.
- `docs/configuration.md`: extend the Environment Variables table with the four new vars. Add a short paragraph on the budget hierarchy (`TRIM_TRIGGER_THRESHOLD` → `NEO_CONTEXT_MAX_INPUT_TOKENS` → hard 200 K).
- `.env.example`: append the four new vars with comments explaining each.

### 12. Tests

- **`web/test/context-manager-budget.test.ts`** — test cases: projected input below `TRIM_TRIGGER_THRESHOLD` → no compression; above but below `NEO_CONTEXT_MAX_INPUT_TOKENS` → summary compression; above `NEO_CONTEXT_MAX_INPUT_TOKENS` after compression → enforceCeiling fires; Haiku input would exceed `HAIKU_INPUT_MAX_TOKENS` → pre-trim; anchor > `FIRST_MESSAGE_MAX_TOKENS` → `maybeSummarizeAnchor` fires; all three compression paths emit the new `context_engineering` audit event.
- **`web/test/agent-plan-resumption.test.ts`** — simulate a mock turn where `stop_reason: "max_tokens"` with `phase: "tool_use"` fires; assert `setInProgressPlan` is called; simulate a follow-up user turn; assert the system-prompt addendum is appended on the next Claude call; assert the plan clears after the remaining tool calls complete.
- **`web/test/api-agent-output-truncated-event.test.ts`** — route-level test that `output_truncated` is emitted in place of the old `INCOMPLETE_TOOL_USE` error; verify `context_trimmed` still fires independently; verify both events have distinct shapes and ordering.
- **`web/test/destructive-batch-preflight.test.ts`** — `validateRemediateInput` unit tests: accept `messages.length <= 20`, reject 21+, reject `remediate_all: true` with no filters, accept explicit message list at the cap boundary, extension `maxExplicitMessages` option override works.
- **`web/test/dual-store-in-progress-plan.test.ts`** — four modes (v1, v2, dual-read, dual-write): set+get round-trips, v2 root-missing triggers fallback under dual-read, dual-write divergence event fires on v2 failure, clear semantics (setting `null` removes the field).
- **`web/test/emit-plan-tool.test.ts`** — the `emit_plan` executor writes the plan to the session store; re-invocation overwrites (no append); session with a plan visible via `getInProgressPlan`.
- **`web/test/conversation-store-v2-schema.test.ts`** — add a split→rebuild round-trip case covering a root with `inProgressPlan` populated.
- **`web/test/dispatching-session-store.test.ts`** — add dispatch-wiring cases for the two new SessionStore methods across all four modes.

### 13. Manual verification

- Drive a `MOCK_MODE` session to ≥180 K estimated tokens (repeat `run_sentinel_kql` returning large mock payloads). Confirm: `context_engineering` log fires, `context_trimmed` NDJSON event arrives at the client, web UI shows the status card, session continues.
- Force a `max_tokens` truncation mid-tool-use in MOCK_MODE (set `MAX_TOKENS_DEFAULT=200` + prompt an `emit_plan` call with 10 steps + let one iteration run). Confirm: `output_truncated` event, card with plan preview, next user message resumes without re-prompting.
- Drive `remediate_abnormal_messages` with 25 explicit messages. Confirm: tool_result `isError: true` with the chunking hint, agent is told in its own context what to do.
- Repeat the Notion-scenario (long session + big KQL result) under real dark-mode + light-mode; confirm the status cards are contrast-accessible and respect `prefers-reduced-motion`.

---

## Verification

1. `cd web && npx tsc --noEmit` — no new type errors; the `InProgressPlan` field propagates through `Conversation`, `ConversationV2Root`, `TurnDoc` read paths, mock store, and route handlers without `any`.
2. `cd web && npx vitest run` — all 343 existing tests still pass; 7 new test files green (≥25 new test cases total).
3. `cd web && npm run build` — production build succeeds.
4. `node --check cli/src/index.js && node --check cli/src/server-client.js` — CLI files parse.
5. Manual smoke tests in MOCK_MODE per step 13 above.
6. Deploy to a staging App Service, tail `az webapp log tail`, drive one session that hits `NEO_CONTEXT_MAX_INPUT_TOKENS` and one that hits `max_tokens`. Confirm the new log events appear and the legacy `Emergency truncation: dropping messages to fit context` + `Context summarization failed, using hard truncation fallback` lines drop to zero over a 24 h window. (Per the spec acceptance criteria; measurable via Log Analytics KQL.)
7. After staging soak, deploy to prod on a Thursday afternoon (low-activity window based on the token-usage logs in the Notion issue).

---

## Follow-ups (deferred)

- **Haiku-anchor injection scan** — `maybeSummarizeAnchor` ships the first user message to Haiku without a pre-scan. Haiku has no action capability (no tools, isolated call), so the impact is limited to Haiku producing a misleading summary that then influences the main model. Low severity, but worth adding a `scanUserInput` pass on the anchor before the Haiku dispatch as defence-in-depth. Skipped during initial rollout to keep the change scoped; file separately.
