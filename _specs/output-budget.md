# Spec for output-budget

branch: claude/feature/output-budget
figma_component (if used): —

## Summary

Neo's agent loop hits Anthropic's 200K input-token ceiling mid-turn during long multi-step investigations, which manifests to users as a generic "Agent ran out of output budget while planning a tool call. Try a more focused follow-up question." message and silently aborts the in-flight workflow. The error is a shared symptom of three underlying problems: (1) context compression fires reactively *after* the prompt is already over budget, (2) in-flight tool results inflate the per-turn prompt beyond what `truncateToolResults` + blob offload cover, and (3) when truncation does fire the user loses the agent's multi-step plan with no recovery path. The Notion issue "Output Budget" captures a concrete incident on 2026-04-23 where a 20-message phishing-remediation workflow for `keenan@goodwinlaw.com` aborted mid-batch and the user had to re-prompt from scratch, and a second incident on 2026-04-24 where user `Etienne, Tyler` sent a turn with 586K input tokens and cascaded through repeated `Emergency truncation: dropping messages to fit context` → `Context summarization failed, using hard truncation fallback ("prompt is too long: 205183 tokens > 200000 maximum")` before recovering with a visibly degraded response.

This feature adds proactive per-turn input-token budgeting, pre-emptive compression that fires before the Anthropic 200K ceiling, explicit in-progress-plan persistence so a truncated turn can be resumed intelligently on the next user message, and user-visible feedback that replaces the opaque truncation error with actionable guidance.

## Functional requirements

- **Proactive input-token ceiling.** Every agent-loop iteration computes projected prompt size (system prompt + messages + tools schema) *before* the Claude API call. If projected size exceeds `NEO_CONTEXT_MAX_INPUT_TOKENS` (default 180K — 20K headroom under Anthropic's 200K ceiling), the loop synchronously compresses older messages *before* invoking Claude, rather than reactively after the API errors.
- **Two-tier compression path.** The existing `compressOlderMessages` (Haiku-powered summarization of mid-conversation messages) remains the preferred path. If Haiku itself exceeds the 200K ceiling on the compression call, the loop cascades to structured hard truncation that drops whole turn pairs (tool_use + tool_result) starting from the oldest past the anchor, never orphaning half-pairs. The existing emergency-truncation loop at `lib/context-manager.ts:363-383` covers this; today it fires *after* the Haiku summarization call has already failed 400, so we reorder the trigger.
- **In-flight tool-result offloading.** Today blob offload in `lib/tool-result-blob-store.ts` happens at persistence time, but the Claude API call for the *current turn* still carries the full tool result. Extend the compression logic so that when a tool result exceeds the per-result cap (`PERSISTENCE_TOOL_RESULT_TOKEN_CAP`, currently 50K), the in-flight prompt replaces it with the trust-marked envelope (`{ _neo_trust_boundary, data: BlobRefDescriptor }`) and informs the agent that calling `get_full_tool_result` returns the full payload. Mirrors the persistence shape but applied one turn earlier.
- **Machine-readable in-progress plan.** When the agent emits a long batch plan (multiple intended tool calls in sequence — visible in the log as "Action plan: Via Abnormal `remediate_abnormal_messages` ..."), surface that plan to the session as structured state. On a mid-tool-use truncation, persist the remaining plan and on the next user message include it in the system prompt as a resumption hint. Goal: "continue" after truncation completes the workflow without the user re-typing the plan.
- **User-visible truncation feedback.** Replace the current `"The agent couldn't finish planning the next step within the token budget. Try a more focused follow-up."` client-facing message with a structured event that the web UI can render as an actionable card: "Context was compressed; N earlier turns are summarized. [Show what I remember]". CLI gets an equivalent stderr notice.
- **Per-tool input sanity gates.** For destructive tools (`remediate_abnormal_messages`, `isolate_machine` batch variants) add an input-size preflight that rejects the tool_use with a clear message when the input exceeds a safe threshold (e.g. >20 messages per batch), prompting the agent to chunk. This catches the degenerate case from the Notion log where `toolInput: "{}"` was sent because the agent had run out of budget mid-construction.

## Figma Design Reference

Not applicable — server-side context engineering + CLI messaging. Web UI changes are limited to a new "context compressed" status card that follows existing card/badge patterns from `.claude/skills/ui-standards-refactor/references/component-patterns.md`.

## Possible Edge Cases

- **Haiku compression call itself exceeds 200K.** Current behavior: 400 error, hard truncation fires, agent loses state. Desired: detect projected Haiku input before the call and pre-truncate the input to Haiku to under 180K.
- **First user message is enormous** (copy-pasted log dump, huge CSV content). Anchor preservation currently means it never drops. Need a soft anchor-trim: if the first message alone is >100K tokens, summarize it aggressively and replace in-place.
- **Agent plans a batch of N tool calls in one turn** and only executes M<N before running out of output tokens. Currently the plan is lost because the assistant's text message with the plan is replaced by the truncated response. Persist the original plan text as a hidden session-level field (not in the conversation), replay it on next turn.
- **User resumes a session from yesterday** (loaded via `listConversations`) where the last turn was a truncation. The resumption hint should fire exactly once and clear itself when acknowledged.
- **Dual-read fallback to v1 for writes** under storage-v2's `dual-read` mode (see `lib/conversation-store.ts:dualReadWriteWithV1Fallback`) adds extra RUs. The in-progress-plan field needs to be patched through both stores to avoid drift — use the existing `dualWriteV2BestEffort` pattern.
- **Tool result that is legitimately >50K AND needed in-prompt** (e.g. a KQL result the agent will iterate over within the same turn). The in-flight offload replacement would force an extra `get_full_tool_result` round-trip per iteration. The offload should be opt-in per-turn — only fire when projected total exceeds the context ceiling, not on every large result.
- **`prefers-reduced-motion` users on the web UI.** The context-compressed status card should not animate in/out aggressively. Gate any transitions behind the existing `@media (prefers-reduced-motion: no-preference)` wrapper pattern.
- **Teams bot** has the same agent loop but no sidebar or status card. Deliver the "context compressed" signal as an inline bot message so the user sees what happened.
- **Multiple concurrent turns on the same conversation** (double-clicked Send, two tabs) — saveMessages already throws 409 under the storage-v2 concurrent-write detection. The in-progress-plan patch must use the same etag-guarded pattern.
- **The agent intentionally generates long text** (a full incident report) and the truncation trigger misclassifies this as context-size overflow. Distinguish input-size-driven truncation from output-size-driven (`stop_reason: "max_tokens"`) truncation; they are different symptoms from the user's POV.

## Acceptance Criteria

- A conversation that previously failed at input-token count >180K completes a full turn without hitting Anthropic's 200K ceiling.
- When compression fires, the `context_trimmed` NDJSON event is emitted to the client with `method: "summary"` or `method: "truncation"` and `originalTokens`/`newTokens` populated — both the web UI and CLI render it non-intrusively.
- When a multi-step batch tool plan is interrupted by max-tokens truncation (`stop_reason: "max_tokens"`), the next user message's turn automatically includes the remaining plan in the system prompt, and the agent can resume without the user re-typing the plan.
- The user-facing truncation message is replaced by a structured status line that distinguishes "context was compressed, here's what I remember" from "I hit my per-turn output limit, continue with a more focused follow-up" — two different conditions with two different recovery actions.
- `Context summarization failed, using hard truncation fallback` with errorMessage `prompt is too long: ...` drops to zero in production logs over a 7-day window after rollout.
- `Emergency truncation: dropping messages to fit context` count per session drops below 2 on average for the top quartile of long-session users (currently users like `Etienne, Tyler` fire this 5+ times in a single turn per the Notion log).
- The `remediate_abnormal_messages` + other destructive batch tools no longer accept `toolInput: "{}"` — they fail preflight with a clear "batch input too large, chunk to ≤N per call" error before reaching the vendor API.
- All 343 existing tests continue to pass; at least 10 new tests cover the budget-ceiling, compression-cascade, in-flight-offload, and plan-resumption paths.
- `/api/cli/version` and the `neo update` flow are unaffected.

## Open Questions

- **Default budget values.** 180K as the input-token ceiling is my proposal for 20K headroom against Anthropic's 200K. Should it be configurable per-user (readers get a lower cap to preserve per-session cost budgets)? Should admins be able to lift it in Settings? let admins lift it in settings.
- **Plan-resumption UX.** Two viable designs:
  - (A) Automatic — next user message silently includes the plan in the system prompt, agent picks up where it left off.
  - (B) Explicit — the web UI shows a "Continue" button that, when clicked, sends a synthetic `/continue` prompt with the plan attached.
  Option A is lower-friction but could surprise users if the plan is stale. Option B is explicit but adds a click. Which? Option B.
- **In-flight blob offload scope.** Should it apply to EVERY tool result above 50K tokens, or only when projected total is over ceiling? The former is simpler; the latter preserves fast-path performance for short sessions. every tool result above 50k.
- **Plan persistence location.** A dedicated `inProgressPlan: string | null` field on the Conversation root (storage-v2), OR a synthetic system message at the head of the next turn. The former is cleaner but adds a schema field; the latter avoids a schema change but pollutes the message array. former.
- **Retroactive fix for in-progress sessions** during rollout. When we deploy, users whose last turn was a truncation will not have the in-progress-plan persisted. Do we (a) best-effort detect this on session resume and re-derive the plan from the last assistant message, or (b) just say "this kicks in for new sessions"? B
- **Should the 180K ceiling track the active model?** Opus 4.7 is 200K today; some Anthropic models offer 1M context on specific endpoints. If we hard-code 180K in config, we don't auto-benefit from the larger ceilings. Worth making model-aware, or keep simple? make it model aware.
- **Teams bot rendering.** The inline "context compressed" message is conceptually similar to the existing confirmation-required prompt. Reuse the same adaptive card pattern, or a lighter inline text message? same card pattern.

## Testing Guidelines

Create test file(s) in the `./web/test/` folder for the new feature. Keep coverage focused — the goal is to lock in the budget contracts and the truncation-recovery state machine, not exhaustively cover every token-count edge case.

- **`context-manager-budget.test.ts`** — unit tests around the proactive-ceiling check in `lib/context-manager.ts`. Cover: projected input under ceiling → no compression; projected over → Haiku compression fires; Haiku call would exceed its own ceiling → pre-truncate Haiku input; hard-truncation fallback when Haiku fails; anchor-trim when the first message alone exceeds the first-message cap.
- **`in-flight-offload.test.ts`** — tests that when a tool result >50K is in the current turn's messages AND projected prompt exceeds ceiling, the in-flight compression replaces the tool result with the trust-marked envelope. Verify `get_full_tool_result` resolution still succeeds on the envelope on the next turn.
- **`agent-plan-resumption.test.ts`** — simulates a multi-step batch plan interrupted by `stop_reason: "max_tokens"`. Assert: the in-progress plan is persisted to the session; the next user message's turn receives the plan in the system prompt; once the plan is fully executed the field clears.
- **`api-agent-context-compressed-event.test.ts`** — route-level test that the `context_trimmed` NDJSON event fires in the correct order (before the assistant text response), carries the expected payload, and is distinct from the max-tokens truncation event.
- **`destructive-batch-preflight.test.ts`** — unit test of the tool-input preflight on `remediate_abnormal_messages` (and whichever other batch tools get the gate). Assert that `toolInput: "{}"` is rejected with the clear "batch input too large, chunk to ≤N" error, and that a valid batch of 5 messages passes through.
- **`dual-store-in-progress-plan.test.ts`** — under `dual-write` and `dual-read` modes, verify that the in-progress-plan field is patched on the v2 root AND that the `dualReadWriteWithV1Fallback` helper continues to route the patch correctly when the conversation only exists in v1.

Existing `context-manager.test.ts` (if present) and `conversation-store-v2-schema.test.ts` suites should stay green with zero test churn.
