# Chain-of-Thought Hierarchy

## Context

Follow-on to the Gemini UI Audit (see `_plans/gemini-ui-audit.md` Phase 5). The audit recommended visually distinguishing the agent's reasoning from its final answer so analysts can skim the verdict and drill into the thought process when needed. Today the web UI has no reasoning stream — the `thinking` stream event is a pre-response spinner, not a display of actual pre-response text — so implementing this is a product decision with cost, latency, and content-policy implications that deserve separate deliberation. This plan captures the implementation shape so the work can be picked up later without re-planning.

---

## Key Design Decisions

- **Enable extended thinking in the Anthropic SDK call, gated behind a feature flag.** Adds cost (thinking tokens are billed), adds latency (model produces more output before streaming text), and the output quality varies by task. Ship behind `ENABLE_EXTENDED_THINKING=true` so we can A/B it in production and turn it off if it regresses UX.
- **Stream reasoning as a separate `reasoning_delta` event, not inline text.** Keeps the existing `response` event clean — the final user-facing answer stays in its own event so the agent loop, session persistence, and CLI consumers don't need to learn a new content shape.
- **Render reasoning as a collapsed `<details>` ABOVE the answer bubble content, inside the same assistant bubble.** Matches the `<details>`/`<summary>` pattern already used for tool traces in Phase 4 of the Gemini UI Audit. Default collapsed keeps the bubble visually calm; analysts can expand when they want to audit the chain.
- **Style the reasoning body with muted color + italic.** Visual de-emphasis vs. the bold, prominent answer body. Monospace stays in the mono-font family (reasoning often includes tool names, IP addresses, hashes).
- **Persist reasoning alongside the text response in Cosmos.** The final answer is already a `text` block on the assistant message — we add the reasoning as an additional content block (Anthropic's message shape already supports `type: "thinking"`). On reload, `conversationToChatMessages` hydrates the reasoning the same way the current code hydrates text.
- **Opt out on skill-invocation / triage pathways.** Extended thinking for a one-shot triage call is wasted tokens and latency — the triage endpoint doesn't show a reasoning UI. Keep the flag scoped to interactive chat conversations.

---

## Files to Change

| File | Change |
|------|--------|
| `web/.env.example` | Document `ENABLE_EXTENDED_THINKING` (default `false`) and a budget knob like `EXTENDED_THINKING_BUDGET_TOKENS` (default 4000). |
| `web/lib/config.ts` | Parse new env vars into the `EnvConfig` interface. |
| `web/lib/types.ts` | Add `reasoning_delta` AgentEvent variant carrying `{ type: "reasoning_delta"; text: string }`. Extend `AgentCallbacks` with `onReasoningDelta?: (text: string) => void`. Extend `ChatMessage` in the client types with `reasoning?: string`. |
| `web/lib/agent.ts` | When the flag is on, set `thinking: { type: "enabled", budget_tokens: env.EXTENDED_THINKING_BUDGET_TOKENS }` on the Anthropic `messages.stream()` call. Intercept `thinking_delta` events from the stream, accumulate into a buffer, and emit `onReasoningDelta` for each delta so the UI can stream-render. Persist the accumulated reasoning as a `thinking` content block on the assistant message alongside the `text` block. |
| `web/app/api/agent/route.ts` | Wire `onReasoningDelta` to write `reasoning_delta` NDJSON events through the existing stream writer. |
| `web/app/api/agent/confirm/route.ts` | Same wiring on the destructive-tool resume path. |
| `web/components/ChatInterface/ChatInterface.tsx` | Add a `reasoning?: string` field to the local `ChatMessage` shape. In `processNDJSONStream`, handle `reasoning_delta` by accumulating into a local buffer and flushing onto the in-flight assistant message on `response`. In `conversationToChatMessages`, hydrate `reasoning` from a `thinking` content block on the persisted assistant message. Render a `<details>` labeled "Reasoning" above the MarkdownRenderer answer body, collapsed by default. |
| `web/components/ChatInterface/ChatInterface.module.css` | New rules: `.reasoningSummary` (muted italic summary), `.reasoningBody` (indented prose with a left accent border), `.reasoningChevron` (rotate on open, gated behind `prefers-reduced-motion: no-preference`). |
| `web/test/chat-reasoning-hierarchy.test.tsx` (new) | 4–5 tests: renders collapsed `<details>` when reasoning present, does NOT render when reasoning is empty, reasoning is visually above the answer in DOM order, persistence round-trip reconstructs reasoning from the `thinking` content block, feature-flag off renders nothing. |

---

## Implementation Steps

### 1. Feature flag & config

- Add `ENABLE_EXTENDED_THINKING` and `EXTENDED_THINKING_BUDGET_TOKENS` to `.env.example` and parse in `lib/config.ts` (boolean + integer with sensible defaults).
- Type-check; no runtime changes yet.

### 2. Type additions

- Extend `AgentEvent` with the new `reasoning_delta` variant.
- Extend `AgentCallbacks` with `onReasoningDelta`.
- Don't touch the UI yet — these are pure type additions.

### 3. Backend: opt into extended thinking

- In `lib/agent.ts` where `createWithRetry` / `messages.stream()` is called, when the flag is on, pass `thinking: { type: "enabled", budget_tokens: <configured> }`.
- Subscribe to `thinking_delta` events from the SDK stream and forward via `onReasoningDelta`.
- Accumulate the full reasoning text alongside the response text.
- When persisting the assistant message, attach both blocks: `content: [{ type: "thinking", text: <reasoning> }, { type: "text", text: <answer> }]`.

### 4. Route wiring

- In `app/api/agent/route.ts` + `confirm/route.ts`, wire `onReasoningDelta` to write a `reasoning_delta` NDJSON event. Keep the existing `response` event semantics (carries the final answer only).

### 5. Frontend type + stream handling

- Extend the local `ChatMessage` with `reasoning?: string`.
- In `processNDJSONStream`, maintain a `reasoningBuffer: string` reset on each `session` event. Append on `reasoning_delta`. Attach to the assistant message on `response` (same place `toolsUsed` + `toolTraces` are attached today).
- In `conversationToChatMessages`, detect `thinking` content blocks on assistant messages and hydrate `reasoning`.

### 6. Render

- In the assistant bubble, above the MarkdownRenderer answer block, conditionally render a `<details>` when `msg.reasoning` is a non-empty string. `<summary>` reads "Reasoning" with a chevron and a duration/length hint. Body is muted italic with a left accent border (keep `:global(html.dark)` variant).
- The existing MessageActions (copy button) sits below and copies the answer text only — never the reasoning.
- Gate the chevron rotate behind `prefers-reduced-motion: no-preference` like other motion in this component.

### 7. Tests

- New `test/chat-reasoning-hierarchy.test.tsx`: mini-harness mirroring the assistant-bubble render predicate. Covers collapsed default, no-reasoning case, DOM order (reasoning before answer), persistence hydration, feature-flag off.

### 8. Observability & rollout

- Add a log line / metric for reasoning token count per turn (via the existing `onUsage` callback — Claude returns thinking_tokens in the usage object).
- Roll out with `ENABLE_EXTENDED_THINKING=false` in production, toggle on for a subset of users via env var, measure latency + satisfaction before global rollout.

---

## Verification

1. **Feature flag off (default)**: all existing behavior unchanged. No `<details>` in the assistant bubble. 187/187 tests still pass.
2. **Feature flag on**: run a multi-tool prompt, stream shows a "Reasoning" disclosure above the answer bubble. Expand → reads the chain-of-thought. Copy button copies answer only (not reasoning). Refresh → reasoning persists via the `thinking` content block on the assistant message.
3. **Mixed legacy**: old conversations without persisted reasoning render normally — no empty `<details>`.
4. **Cost & latency**: measure per-turn token usage before/after enabling the flag; budget `EXTENDED_THINKING_BUDGET_TOKENS` to stay within the per-user 2-hour / weekly windows enforced by `lib/usage-tracker.ts`.
5. **Tests**: `npx tsc --noEmit`, `npx vitest run`, `npm run build` all green from `web/`.
6. **a11y sanity**: the new `<details>` is keyboard-reachable; Enter/Space toggles; focus ring visible; screen reader announces the label and expanded state.
