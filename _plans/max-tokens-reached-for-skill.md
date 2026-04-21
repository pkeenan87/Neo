# Max Tokens Reached for Skill

## Context

Skill invocations hit the Anthropic API's `max_tokens` limit mid-response because the agent loop hardcodes `max_tokens: 4096` and throws `Unexpected stop_reason: max_tokens` when the model can't finish inside that budget. Per the spec (`_specs/max-tokens-reached-for-skill.md`), this plan: (1) raises the per-turn output budget for skill invocations to 24K with config-driven defaults and a model-ceiling clamp, (2) handles `stop_reason: "max_tokens"` gracefully by returning the partial response flagged as truncated rather than throwing, and (3) surfaces the truncation to the user via a warning toast plus a "Truncated" badge on the message (no continue-button UX in this MVP — deferred per user direction). Observability is extended with a new `max_tokens_reached` log event.

---

## Key Design Decisions

- **Three env-tunable max-token constants in `lib/config.ts`**: `MAX_TOKENS_DEFAULT` (default 4096, preserves existing non-skill behavior), `MAX_TOKENS_SKILL` (default 24_576 = user-selected 24K), `MAX_TOKENS_CEILING_OVERRIDE` (optional — if set, hard-caps the budget even below the model's published max). Defaults chosen so skill invocations succeed without operator intervention; the original 4K remains for plain chat to avoid regressing token consumption.
- **Per-model ceiling map** exported from `lib/config.ts` so the budget selector can clamp against the model's published output max (Sonnet 4.6, Opus 4.7, Haiku 4.5). Budget = `min(requestedBudget, modelCeiling, MAX_TOKENS_CEILING_OVERRIDE)`. If the chosen budget was clamped, emit a one-time startup warning listing requested vs. effective.
- **Skill detection via the existing `[SKILL INVOCATION:` prefix** already used in `app/api/agent/route.ts:95`. The agent-loop budget selector walks backward from the end of `localMessages` to the most recent non-tool-result user message and checks its leading text. Computing once per loop-entry (not per iteration) is fine because the prefix is stable across the skill's multi-turn tool loop. An explicit `RunAgentLoopOptions.skillInvocation?: boolean` is added for callers (triage, confirm) that want to force / suppress skill-budget behavior.
- **`stop_reason: "max_tokens"` handling mirrors the existing `[interrupted]` pattern**: the partial text becomes the turn's response, `[truncated]` is appended to the persisted assistant content, the loop returns `{ type: "response", text, messages, truncated: true }`. Web UI strips the marker in `conversationToChatMessages` via a regex (same shape as `INTERRUPTED_SUFFIX_RE`) and reads the flag for rendering. CLI prints the marker as plain text — no channel-specific code.
- **Tool-use truncation is an explicit error, not a silent partial.** If `stop_reason === "max_tokens"` arrives on a turn where the final content block is `tool_use` (the model couldn't finish writing its tool call), the loop throws `IncompleteToolUseError`. The route surfaces it as an error event so the user sees "The agent couldn't finish planning the next tool call — try a more focused question." — persistence is NOT written (no orphan tool_use).
- **Stream-event shape**: `truncated?: boolean` added to the existing `response` AgentEvent variant. Not a new event type — parallels how `interrupted?: boolean` is already piggybacked on `response`. Client listens for it exactly the same way.
- **`max_tokens_reached` is a new LogEventType**, logged once per truncation with: `sessionId`, `skillId` (if detected), `requestedMaxTokens`, `outputTokensProduced`, `inputTokens`, `phase` (`"text"` or `"tool_use"`). Existing `token_usage` and `tool_execution` events unchanged.
- **Repeated-truncation counter is client-side state** in `ChatInterface.tsx`, incremented on each `response` with `truncated: true` and reset on any non-truncated `response`. When it reaches 3 inside a single conversation, the toast copy escalates from "Response was truncated — ask Neo to continue for the rest." to "This conversation may be too complex to complete in one response. Consider starting a new session or narrowing the request." No server-side state (simplest MVP).
- **Truncation badge reuses the existing interrupted-badge pattern** at the bottom of the assistant bubble. Classname `.truncatedBadge`, warning-500 background, same shape as `.interruptedBadge` so they can even stack if both apply (unlikely but handled).
- **Toast warning is a single `toast({ intent: "warning", title: ..., description: ... })` call** on the truncated response stream event. Uses the `useToast` hook wired up in Phase 3 of the Gemini UI Audit.
- **Triage API does NOT use the skill budget.** Triage responses are structured verdict JSON that must complete fully to be valid. Pass `skillInvocation: false` explicitly from `app/api/triage/route.ts` and treat any truncation as a triage failure (fail-safe verdict).
- **No persistence schema change** — `truncated: true` is encoded as the `[truncated]` text suffix on the assistant message content, consistent with how `[interrupted]` is persisted. Zero Cosmos migration needed.

---

## Files to Change

| File | Change |
|------|--------|
| `web/lib/config.ts` | Add three new env-parsed constants (`MAX_TOKENS_DEFAULT`, `MAX_TOKENS_SKILL`, `MAX_TOKENS_CEILING_OVERRIDE`) using the existing `parsePositiveInt` helper. Add a `MODEL_OUTPUT_CEILINGS` record mapping each known model id to its max output tokens. Add a `resolveMaxTokens(model, { skillInvocation })` helper that computes the effective budget (min of skill/default, model ceiling, optional override) and emits a one-time startup warning if the user's configured value exceeds the model ceiling. Document the three new env vars in the existing config comments. |
| `web/.env.example` | Document `MAX_TOKENS_DEFAULT`, `MAX_TOKENS_SKILL`, `MAX_TOKENS_CEILING_OVERRIDE` with defaults and a short note explaining when to raise them. |
| `web/lib/types.ts` | Add `truncated?: boolean` to the `AgentLoopResult` `"response"` variant (line ~341) and to the `AgentEvent` `"response"` variant (line ~229). Add `"max_tokens_reached"` to the `LogEventType` union (line ~149). Add `IncompleteToolUseError` class export (named, subclasses `Error`, distinguishable in `instanceof` checks). Optionally add a `RunAgentLoopOptions.skillInvocation?: boolean` field (already near the end of the file). |
| `web/lib/agent.ts` | Replace the hardcoded `max_tokens: 4096` at line 222 with `resolveMaxTokens(model, { skillInvocation })`. Compute `skillInvocation` once at the top of `runAgentLoop` by checking whether the first (or most recent) user message's text starts with `[SKILL INVOCATION:`, unless the caller passed an explicit `options.skillInvocation`. Add a new branch in the stop-reason switch (after `"tool_use"`, before the "unexpected" throw) for `response.stop_reason === "max_tokens"`: if the last content block is `tool_use`, throw `new IncompleteToolUseError(toolUseBlockName)`; otherwise join text blocks, append `[truncated]` to the last assistant message's content, emit a `max_tokens_reached` log event with the fields listed in Key Design Decisions, and return `{ type: "response", text, messages: localMessages, truncated: true }`. Do NOT alter the existing `"end_turn"` or `"tool_use"` branches. Leave the `summarizeConversation` helper's internal `max_tokens: 1024` untouched. |
| `web/lib/agent.ts` (resumeAfterConfirmation) | Apply the same `resolveMaxTokens` change to the single `messages.create` call there (confirmed-tool resume path). Inherits skill-invocation detection from the persisted first user message; no new parameter needed. |
| `web/app/api/agent/route.ts` | Forward the existing skill-invocation detection (already on line 95) through to `runAgentLoop` as `options.skillInvocation = true` when a `skill` was resolved. This is cleaner than re-parsing the prefix inside the agent loop for the same request. Keep the `[SKILL INVOCATION:` fallback detection in the agent loop for the resume path. On the agent result, forward `result.truncated` into the `response` NDJSON event so the client sees it. |
| `web/app/api/agent/confirm/route.ts` | Forward `result.truncated` into the `response` NDJSON event on the confirm path too. No skill option needed; detection is message-based. |
| `web/app/api/triage/route.ts` | Pass `skillInvocation: false` explicitly when invoking `runAgentLoop`. If the agent result comes back with `truncated: true`, wrap the triage response as a fail-safe verdict (reason `"response_truncated"`) rather than trying to parse the partial JSON. |
| `web/components/ChatInterface/ChatInterface.tsx` | Add `truncated?: boolean` to the local `ChatMessage` shape. Add `truncated?: boolean` to the `ResponseEvent` TS interface. In `processNDJSONStream`, on a `response` event with `truncated: true`: set the new message's `truncated: true`, call `toast({ intent: "warning", title: ..., description: ... })` via `useToast()`. Maintain a `consecutiveTruncationsRef` ref incremented on each truncation and reset on a clean response; when it hits 3, use the escalated toast copy. In `conversationToChatMessages`, add a `TRUNCATED_SUFFIX_RE` (shape mirrors `INTERRUPTED_SUFFIX_RE`), strip the suffix from reloaded content, set `truncated: true` when it was present. Render a `.truncatedBadge` span in the assistant bubble whenever `msg.truncated` is true, co-located with the existing `.interruptedBadge` so both can render together if ever needed. |
| `web/components/ChatInterface/ChatInterface.module.css` | Add `.truncatedBadge` rules — reuse the `.interruptedBadge` styling as a starting point but use `warning-500` instead of `error-500`. Dark-mode variant. Inline with the existing interrupted-badge rules for proximity. |
| `web/test/agent-max-tokens-handling.test.ts` (new) | Unit tests on the stop-reason branch of `runAgentLoop`. Mocks the Anthropic SDK create. Covers (a) `end_turn` regression guard — still returns a normal response, (b) `max_tokens` on a text-only response returns `{ truncated: true, text: <partial> }` and does NOT throw, (c) `max_tokens` when last content block is `tool_use` throws `IncompleteToolUseError`, (d) that the `max_tokens_reached` log event fires with the expected fields. |
| `web/test/agent-max-tokens-budget.test.ts` (new) | Unit tests on `resolveMaxTokens`. Covers: plain chat → `MAX_TOKENS_DEFAULT`, skill → `MAX_TOKENS_SKILL`, explicit `skillInvocation: false` override, configured value above the model ceiling → clamped + warning, `MAX_TOKENS_CEILING_OVERRIDE` env value wins when lower than the model ceiling. |
| `web/test/chat-truncation-rendering.test.tsx` (new) | Mini-harness mirroring the assistant-bubble predicate (same pattern as `chat-tool-traces.test.tsx`). Covers: `truncated: true` message renders the badge, `truncated` absent renders no badge, hydration round-trip (a persisted message whose content ends with `[truncated]` round-trips with `truncated: true` and the badge renders). Wraps in `ToastProvider` for provider resolution. |
| `web/test/chat-message-rendering.test.tsx` (if necessary) | No change expected; confirm no regression in the existing snapshots/assertions. Included here as a checkpoint. |

---

## Implementation Steps

### 1. Config additions

- Add `MAX_TOKENS_DEFAULT` / `MAX_TOKENS_SKILL` / `MAX_TOKENS_CEILING_OVERRIDE` to `web/lib/config.ts` using the existing `parsePositiveInt` helper. Defaults: 4096, 24_576, undefined (unset = no override).
- Add a `MODEL_OUTPUT_CEILINGS: Record<string, number>` record mapping each known model id to its published max output tokens. Populate it from Anthropic's published docs for every model id actively referenced elsewhere in the config (`claude-sonnet-4-6`, `claude-opus-4-7`, `claude-haiku-4-5`, and the 1M-context variants used in tests).
- Add `resolveMaxTokens(model: string, opts: { skillInvocation: boolean }): number` exported from `lib/config.ts`. Logic: pick `MAX_TOKENS_SKILL` if `skillInvocation`, else `MAX_TOKENS_DEFAULT`. Clamp at `MODEL_OUTPUT_CEILINGS[model] ?? Infinity`. Clamp again at `MAX_TOKENS_CEILING_OVERRIDE ?? Infinity`. Memoize a per-model "emitted warning" set so the "configured value exceeds model ceiling" warning fires at most once per model per process.
- Document the three new env vars in `.env.example` with brief inline comments.

### 2. Type additions

- In `web/lib/types.ts`: add `truncated?: boolean` to the `AgentEvent` variant `{ type: "response" }` and the `AgentLoopResult` variant `{ type: "response" }`.
- Add `"max_tokens_reached"` to the `LogEventType` union.
- Export a new `IncompleteToolUseError` class (extends `Error`, stores the tool name in a `toolName` field for the route to surface).
- Add `skillInvocation?: boolean` to `RunAgentLoopOptions`.

### 3. Agent loop — budget selection

- In `runAgentLoop` (`web/lib/agent.ts`), compute `skillInvocation` once near the top of the function:
  - If `options.skillInvocation !== undefined`, use that value.
  - Otherwise, walk `messages` backwards to find the most recent user message whose content is a string (or whose first text-block starts with `[SKILL INVOCATION:`). If found, set `skillInvocation = true`; else `false`.
- Replace the hardcoded `max_tokens: 4096` at line 222 with `resolveMaxTokens(model, { skillInvocation })`.
- Apply the same change to the `messages.create` call in `resumeAfterConfirmation` — the skill-invocation flag is derived the same way from the persisted message array.
- Do NOT change the `summarizeConversation` helper's `max_tokens: 1024` — that's an unrelated internal summarization call.

### 4. Agent loop — `stop_reason: "max_tokens"` branch

- In the stop-reason switch inside the main `while (true)` loop in `runAgentLoop`, add a new branch BEFORE the final `Unexpected stop_reason` warning/throw:
  - If `response.stop_reason === "max_tokens"`:
    - Identify the final content block: if `response.content[response.content.length - 1].type === "tool_use"`, throw `new IncompleteToolUseError(blockName)`.
    - Otherwise (text-only or mixed-text-then-nothing), extract text from the content via the same `filter(b => b.type === "text").map(b => b.text).join("\n")` pattern used in the `end_turn` branch.
    - Append `[truncated]` to the assistant message content being persisted — mirror the `[interrupted]` logic at line 149-156 (push a new text block if the assistant message doesn't already end with one, else mutate the last text block). Use the same `alreadyMarked` guard pattern.
    - Call `logger.emitEvent("max_tokens_reached", ...)` with `sessionId`, `skillInvocation`, `requestedMaxTokens`, `outputTokens`, `inputTokens`, `phase: "text"`.
    - Return `{ type: "response", text, messages: localMessages, truncated: true }`.
  - Keep the existing "Unexpected stop_reason" path for truly unexpected values (`"stop_sequence"`, etc.) so we still get visibility.

### 5. Routes — forward `truncated` and the skill flag

- In `web/app/api/agent/route.ts`, after the skill lookup (around line 95), pass `skillInvocation: true` into `runAgentLoop`'s options when `resolvedSkill` is truthy. Leave the fallback detection path in `agent.ts` intact for calls that don't explicitly pass it.
- In the same route, when forming the `response` NDJSON event from the agent result, include `truncated: result.truncated` so it reaches the client.
- In `web/app/api/agent/confirm/route.ts`, include `truncated: result.truncated` on the `response` event emitted after `resumeAfterConfirmation`.
- Catch `IncompleteToolUseError` at the route level: emit an `error` event with a friendly copy ("The agent couldn't finish planning the next step — try a more focused follow-up") and log the tool name. Do NOT persist the assistant turn (the tool_use block is incomplete and would corrupt the next API call).

### 6. Triage route — fail-safe on truncation

- In `web/app/api/triage/route.ts`, pass `{ skillInvocation: false }` explicitly when calling `runAgentLoop` so triage turns use `MAX_TOKENS_DEFAULT`.
- After the agent result returns, before attempting JSON-parse of the verdict, check `result.truncated === true`. If so, return a fail-safe `TriageResponse` with `verdict: "inconclusive"`, `reason: "response_truncated"`, `originalVerdict` unset, and a descriptive `reasoning` field. Log a `max_tokens_reached` event with `phase: "triage"` so operators can detect triage budget issues.

### 7. Client — stream handling + badge + toast

- In `web/components/ChatInterface/ChatInterface.tsx`:
  - Extend the local `ChatMessage` interface with `truncated?: boolean`.
  - Extend the `ResponseEvent` type with `truncated?: boolean`.
  - Add `const TRUNCATED_SUFFIX_RE = /\s*\[truncated\]\s*$/` near the existing `INTERRUPTED_SUFFIX_RE`.
  - In `conversationToChatMessages`, mirror the interrupted-handling code: test for `TRUNCATED_SUFFIX_RE` before pushing, strip the suffix, set `truncated: true` on the ChatMessage.
  - Import `useToast` from `@/context/ToastContext`. Call it at the top of `ChatInterface`; destructure `toast`.
  - Add a `consecutiveTruncationsRef = useRef(0)`.
  - In `processNDJSONStream` handling of the `response` event: when `event.truncated` is true, set `truncated: true` on the appended message and call `toast(...)`. If `consecutiveTruncationsRef.current >= 2` at entry (will become 3 after increment), use the escalated copy. Increment the ref. On any non-truncated `response` event, reset the ref to 0.
  - In the assistant-bubble render (co-located with the existing `{msg.interrupted && <span>Interrupted</span>}`), add `{msg.truncated && <span className={styles.truncatedBadge}>Truncated</span>}`.

### 8. CSS — truncated badge

- In `web/components/ChatInterface/ChatInterface.module.css`, add `.truncatedBadge` next to the existing `.interruptedBadge` rule. Use design tokens (`warning-500` background, high-contrast text) following the same padding / border-radius / font-size as `.interruptedBadge`. Add a `:global(html.dark)` variant.

### 9. Tests

- Write `test/agent-max-tokens-handling.test.ts` with the four cases listed in Files-to-Change. Mock `client.messages.create` to return synthetic responses with different `stop_reason` values. For the `IncompleteToolUseError` case, the fixture response must end with a `tool_use` content block.
- Write `test/agent-max-tokens-budget.test.ts` with five cases for `resolveMaxTokens`. Vitest's `beforeEach` should reset the per-model warning memoization so tests don't interfere.
- Write `test/chat-truncation-rendering.test.tsx` with three cases (badge present when flag set, absent when flag unset, hydration round-trip). Follow the exact structure of `test/chat-tool-traces.test.tsx` and `test/chat-message-copy-affordance.test.tsx` — a mini-harness mirroring the assistant-bubble predicate, wrapped in `ToastProvider`.

### 10. Commit, test, push

- Run `npx tsc --noEmit` from `web/`.
- Run `npx vitest run` — all 187 + 10 new tests must pass.
- Run `npm run build` — production build must succeed.
- Commit with message prefix `✨ feat: dynamic max_tokens with graceful truncation for skills` and push the branch.

---

## Verification

1. **Regression guard**: an existing `/chat` conversation with plain prose responses still uses 4096 tokens; `token_usage` event output still matches pre-change numbers for an identical prompt.
2. **Skill happy path**: invoke `/abnormal-message-search` (the skill that originally surfaced the bug). Full response renders without the `Unexpected stop_reason: max_tokens` error. Network tab shows `max_tokens: 24576` on the API call.
3. **Forced truncation**: temporarily set `MAX_TOKENS_SKILL=256` in `.env.local`, invoke a skill, verify: (a) assistant bubble shows the partial text followed by a "Truncated" warning-toned badge, (b) a warning toast appears bottom-right with the single-truncation copy, (c) reload the page — the badge still renders (hydration), (d) `max_tokens_reached` appears in the server log with the expected fields. Reset the env value after.
4. **Repeated truncation**: still with the low env cap, send three consecutive prompts. On the 3rd, verify the toast copy switches to the escalated "This conversation may be too complex…" message.
5. **Tool-use truncation**: synthetic SDK response (in the unit test) with `stop_reason: "max_tokens"` and a trailing `tool_use` block → `IncompleteToolUseError` thrown; route emits an `error` event; no assistant message persisted.
6. **Ceiling clamp**: set `MAX_TOKENS_SKILL=999999` in `.env.local`, start the dev server. Expect a single `WARN` log line on boot stating the requested value was clamped to the model's ceiling for each model that would otherwise overflow. Agent calls use the clamped value.
7. **Triage fail-safe**: POST a triage request designed to exceed 4096 output tokens. Verify the response is `verdict: "inconclusive"`, `reason: "response_truncated"`, logged with `max_tokens_reached` + `phase: "triage"`.
8. **CLI parity**: `cd cli && npm start`, invoke a skill that truncates under the low env cap. Expect the partial response to print with `[truncated]` literally at the end (no toast / badge in CLI context).
9. **Test suite**: `cd web && npx tsc --noEmit && npx vitest run && npm run build` — all green.
10. **Manual a11y check** (post-toast-review): keyboard-only nav reaches the Truncated badge's containing bubble; screen reader announces it through the existing message aria-label; the warning toast is in a `role="alert"` container (per Phase 3 toast system) so it preempts other announcements.
