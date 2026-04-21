# Spec for max-tokens-reached-for-skill

branch: claude/feature/max-tokens-reached-for-skill

Notion issue: [Max Tokens Reached for Skill](https://www.notion.so/3417b36249e2807d9003c6c06ee299b7) — urgency: High, category: Web, date captured: 2026-04-13.

## Summary

Users invoking skills (e.g. `/abnormal-message-search`, `/cli-response-formatting`, etc.) intermittently hit the Anthropic API's `max_tokens` limit mid-response. The agent loop currently sets `max_tokens: 4096` as a hard-coded constant and throws `Unexpected stop_reason: max_tokens` when the model is forced to stop early, surfacing to the user as an inline error message inside the chat log with no way to recover. The cause: skill invocations produce longer, more structured output than a typical conversational turn (multi-step security investigations, tables of findings, explicit tool-call plans), so 4096 is too tight for this mode of use.

The feature does three things: (1) raise the per-turn output budget for skill invocations specifically, so the common case doesn't fail; (2) handle `stop_reason: "max_tokens"` gracefully so if we still hit the cap we surface the partial response instead of crashing the loop; (3) surface a clear, user-facing signal (via the existing toast system + an inline note on the partial message) so the operator understands they're seeing a truncated response and can ask a follow-up to continue.

## Functional requirements

- **Dynamic per-turn `max_tokens`**: the agent loop must select a `max_tokens` value based on the current turn's context, not a hardcoded constant. At minimum, skill-invocation turns get a higher budget than ordinary chat turns. Budget is bounded by the model's per-response ceiling and by any remaining headroom inside the context window.
- **Graceful `stop_reason: "max_tokens"` handling**: the agent loop must NOT throw when the model returns `stop_reason: "max_tokens"`. Instead it must (a) treat the partial text as the final response of that turn, (b) flag the message as truncated, (c) emit a telemetry event, and (d) return control to the UI so the user can follow up with "continue" without losing the partial output.
- **User-facing notice on truncation**: the partial response renders in the chat bubble with a visible "Response was truncated — ask to continue" badge or inline note. A toast (via the existing `ToastContext` — `_plans/gemini-ui-audit.md` Phase 3) fires with intent `warning` so the truncation is noticed even if the user isn't looking at the bottom of the stream.
- **Configuration**: the new max-token budgets (ordinary chat default, skill-invocation default, ceiling) must be configurable via `env` / `lib/config.ts` with sensible defaults so operators can tune per deployment without a code change.
- **Observability**: every truncation event is logged with event type `max_tokens_reached`, including sessionId, turn index, skill id (if applicable), input tokens, output tokens at truncation, and whether it happened inside a tool loop vs. a final response.
- **Backward compatibility**: existing non-skill chat flows must continue to work unchanged. The default `max_tokens` for plain conversational turns stays at 4096 (or is lifted only if explicitly opted in via config) so we don't regress token usage on small exchanges.

## Figma Design Reference (only if referenced)

Not applicable — this is a backend + UX-affordance change. The "truncated" affordance reuses existing design tokens (warning color for the badge, existing toast styling).

## Possible Edge Cases

- **Skill + tool loop**: a skill invokes multiple tool calls before the final text response. If `max_tokens` is hit during an intermediate `tool_use` response (the model couldn't finish the tool_use block), the agent cannot proceed safely — the tool_use is incomplete. Must surface as an error, NOT as a "truncated partial response", because there's no text to show the user yet.
- **Context-window vs. max-tokens confusion**: hitting the 180K input token ceiling is a different failure than hitting a 4K–16K output ceiling. The handler must distinguish `stop_reason: "max_tokens"` (output ceiling) from the existing "prompt is too long" error (input ceiling); treatment differs.
- **Model-specific ceilings**: different Claude model families have different absolute output maxes (Sonnet 4.6 is different from Opus 4.7). Config must not silently exceed the model's ceiling; if configured higher than the model allows, clamp and warn.
- **Repeated truncation across follow-ups**: if the user types "continue" and the next turn also truncates, the UX must not degrade into an infinite truncation loop. After N consecutive truncations in a session (suggest 3), surface a stronger "this conversation may be too complex to complete in one response" message.
- **Persisted partial messages**: the truncated partial is written to the conversation store exactly like a normal completed message (minus a `truncated: true` flag). On reload, the chat must render the flag so users revisiting the conversation still see the truncation state.
- **CLI channel parity**: the CLI channel calls the same agent loop. The truncation handling must be channel-aware: CLI users see a text marker ("[response truncated — type /continue]") instead of a toast.
- **Non-skill high-output turns**: a regular chat turn that happens to produce a long response (e.g. the user asks for a long KQL primer) would also benefit from the lifted ceiling. The feature should handle this generously rather than gating the higher ceiling strictly to skill invocations.
- **Budget interaction with usage tracker**: `lib/usage-tracker.ts` enforces per-user 2-hour and weekly rolling limits. A higher `max_tokens` ceiling means a single turn can burn more quota. The feature must not double-count, and budgeted users hitting their quota mid-turn should degrade to a cleanly truncated response rather than a stream error.

## Acceptance Criteria

- Invoking a skill (e.g. `/abnormal-message-search`) that used to fail with `Unexpected stop_reason: max_tokens` now completes successfully with a full response inside the turn's budget, for the operator's typical workload.
- When the model genuinely cannot fit the response even with the lifted ceiling, the agent loop does NOT throw. The partial response is returned as the assistant turn's content, flagged `truncated: true`, the `response` stream event carries the same flag, and a `warning` toast appears in the web UI with copy "Response was truncated — ask Neo to continue for the rest."
- The chat bubble for a truncated assistant message renders a visible badge ("Truncated" — warning-toned, design-tokenised) next to the toolbar at the bottom of the message, consistent with the existing `Interrupted` badge pattern.
- Config values (`MAX_TOKENS_DEFAULT`, `MAX_TOKENS_SKILL`, `MAX_TOKENS_CEILING`) exist in `lib/config.ts` and are documented in `.env.example`. Defaults are chosen so the reported failing skill invocations succeed without operator intervention.
- A new log event `max_tokens_reached` fires once per truncation with the fields listed in the functional requirements; the existing `tool_execution` / `token_usage` events continue unchanged.
- Intermediate tool-use truncations are surfaced as errors (not silent partial responses) and logged separately so operators can distinguish them from final-response truncations.
- Reloading a conversation that contains a truncated message displays the truncation badge correctly (persistence round-trip).
- The CLI channel prints a readable truncation marker in place of the toast.
- All unit tests pass, including new ones covering the truncation handler branch.

## Open Questions

- **What's the right default for skill invocations?** The model supports up to 32K output on Claude Opus 4.7 and 64K on some configurations. Do we want to default skill turns to 8K, 16K, or something adaptive based on the skill's own declared complexity? Recommend starting at 16K and revising with data. 24K.
- **Should the "continue" affordance be explicit UI (button) or implicit (type /continue)?** The existing UX has no "continue" concept; the simplest MVP is "type anything and Neo will continue", but a dedicated button on the truncated bubble would be better UX. Recommend deferring the button to a follow-on spec; the badge + toast is enough for MVP. agreed.
- **How does truncation interact with the Phase 4 tool-trace accordions?** If a skill truncates before the final text, the tool traces that did execute should still render. Confirm the existing `toolTraces` accumulator attaches to the partial message.
- **Do we need to expose the remaining token budget to users?** An advanced operator might want to see "47K of 180K input tokens used, 4096 output requested" per turn. Not needed for MVP.
- **Ceiling vs. model's actual limit**: do we hard-clamp to the model's published ceiling, or trust the SDK to error and let us catch it? Recommend hard-clamping with a one-time warning at startup. agreed.

## Testing Guidelines

Create test file(s) in `web/test/` for the new feature. Meaningful coverage without going too heavy:

- `test/agent-max-tokens-handling.test.ts` — unit tests on the agent loop's `stop_reason` branch:
  1. `stop_reason: "end_turn"` still returns a normal response (regression guard).
  2. `stop_reason: "max_tokens"` on a text-only response returns `{ type: "response", truncated: true, text: <partial> }` instead of throwing.
  3. `stop_reason: "max_tokens"` on a turn whose last content block was `tool_use` (incomplete) throws an explicit `IncompleteToolUseError` — NOT a silent partial.
  4. Repeated truncation (3 consecutive in one session) triggers the "too complex" escalation flag.
- `test/agent-max-tokens-budget.test.ts` — unit tests on the budget selector:
  1. Plain chat turn uses `MAX_TOKENS_DEFAULT`.
  2. Skill-invocation turn (first user message matches the `[SKILL INVOCATION: …]` prefix) uses `MAX_TOKENS_SKILL`.
  3. Configured value above the model's published ceiling is clamped with a warning.
- `test/chat-truncation-rendering.test.tsx` — mini-harness mirroring the assistant-bubble render predicate (same pattern as `chat-tool-traces.test.tsx`):
  1. `truncated: true` message renders the "Truncated" badge.
  2. `truncated: false` / undefined does NOT render the badge.
  3. Reloaded conversation with persisted `truncated: true` still renders the badge (hydration round-trip).
- No changes needed to existing copy-button / tool-trace / toast tests; the toast for truncation is a new call site and should be covered in the rendering test above via the shared `ToastProvider` wrapper.
