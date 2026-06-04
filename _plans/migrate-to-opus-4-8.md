# Migrate to Opus 4.8

## Context

Anthropic shipped Claude Opus 4.8 as the new flagship. Per the migration
guide, it is **drop-in compatible** with Opus 4.7 — there are no breaking
API changes — but the model behaviour shifts in three load-bearing ways
for Neo: (1) the 1M-token context window is now the default with no beta
header and no pricing premium, (2) prompt-cache minimum drops to 1,024
tokens, and (3) `stop_details` on refusal responses are publicly
documented. Neo currently exposes Opus 4.7 (200K) and Opus 4.7 [1m] (1M)
as separate tiers behind a UI selector that locks at the first message.
With 4.8, the 200K/1M tier distinction collapses — every Opus 4.8 session
is a 1M session at the standard rate — so the selector becomes a
Sonnet-vs-Opus model picker rather than a context-tier toggle.

---

## Key Design Decisions

- **Phased rollout, not a hard cut.** Phase 1 makes Opus 4.8 the default
  "Opus" option and stops issuing new `[1m]` sessions. Phase 2 removes
  the `[1m]` sentinel infrastructure once the longest-running
  conversations have aged past their 30-day Cosmos TTL. Mid-flight
  sessions keep working because both `claude-opus-4-6` and
  `claude-opus-4-7[1m]` model lookups remain in `SUPPORTED_MODELS` /
  `TOKEN_PRICING` until Phase 2.
- **Selector role changes, not its UX.** The `<ContextTierSelector>`
  component already lives next to the send button with the right
  affordances (locks after first message, persists choice to
  `session.model`). The two options shift from
  `200K → Sonnet` / `1M → Opus 4.7[1m]` to
  `Sonnet → claude-sonnet-4-6` / `Opus → claude-opus-4-8`. Cost framing
  changes from the "10× 1M premium" warning to a "Opus ~5× the Sonnet
  rate" tooltip — the choice is now intelligence-vs-cost at the model
  level, not 200K-vs-1M at the tier level. The `'200k' | '1m'`
  literal values stay (Cosmos `session.model` persistence and the chat
  state machine depend on them); only labels and `modelId` mappings
  change.
- **"Powered by &lt;model&gt;" header updates reactively.** The chat
  header currently renders `<span>Powered by {defaultModelName}</span>`
  with a static prop set at page render time, so it doesn't track the
  user's selector choice. Replace with a derived value computed from
  the same `contextTier` state that drives the selector — so toggling
  the selector before the first message updates the header
  immediately, and resuming a conversation reflects its locked model
  in the badge. Add `displayNameForTier(tier)` next to
  `modelIdForTier` / `tierForModelId` in the selector module so the
  Sonnet/Opus mapping lives in one place.
- **No new env vars introduced.** `CLAUDE_OPUS_MODEL` already exists and
  defaults to `claude-opus-4-6`; we move that default to
  `claude-opus-4-8`. `CLAUDE_OPUS_1M_MODEL` becomes redundant but stays
  defined so existing App Service config that references it keeps
  parsing (its value is just ignored).
- **Drop the `context-1m-2025-08-07` beta header on Opus 4.8.** When the
  active model is Opus 4.8, the `resolveBetas` 1M branch is a no-op:
  Opus 4.8 serves 1M by default. Older models (Opus 4.7 [1m]) still get
  the header on legacy session resumes.
- **Keep `getContextBudget("claude-opus-4-8")` returning the 1M
  budget.** Same thresholds as 4.7 [1m] (900K ceiling, 800K trim trigger,
  500K anchor cap, 100K per-tool-result cap). The `isOneMillionContext
  Model` check is widened to "endsWith `[1m]` OR id is in the
  `ALWAYS_1M_MODELS` set" so future model ids that have 1M by default
  fall into the same bucket.
- **Pricing.** Opus 4.8 lands at $15/$75 per Mtok (same as Opus 4.7
  standard — confirm against [pricing docs](https://platform.claude.com/docs/en/pricing)
  before merge). The 2× premium that applied to `claude-opus-4-7[1m]`
  goes away on 4.8. `USAGE_LIMIT_2H_INPUT_TOKENS` doesn't change — it's
  already calibrated to $15/Mtok and matches the new Opus 4.8 rate.
- **No new effort parameter wiring this PR.** The migration guide notes
  Opus 4.8 defaults `effort` to `high` and recommends `xhigh` for
  high-autonomy work. Neo doesn't currently pass `effort`; default-high
  is fine. A follow-up plan can explicitly set `xhigh` on the
  scheduled-task runner if we want more thinking budget for cron-run
  investigations.
- **No `stop_details` handling in this PR.** Refusal categorisation is
  worth surfacing in audit logs, but it's an additive feature that
  belongs in its own change.

---

## Files to Change

| File | Change |
|------|--------|
| `web/lib/config.ts` | (1) Replace `SUPPORTED_MODELS["Opus"]` default from `claude-opus-4-6` → `claude-opus-4-8`. (2) Rename the `"Opus 4.7 (1M context)"` entry to `"Opus (1M, legacy)"` and keep its default `claude-opus-4-7[1m]` for in-flight session resumes; mark deprecated in comment. (3) Add `claude-opus-4-8` to `MODEL_OUTPUT_CEILINGS` (32,000) and `TOKEN_PRICING` ($15/$75). (4) Widen `isOneMillionContextModel` to return true for `claude-opus-4-8` (so `getContextBudget` returns the 1M thresholds) without touching the `[1m]` suffix path. (5) Update the comments referencing "Opus 4.7" to "Opus 4.7 / 4.8". |
| `web/lib/agent.ts` | (1) In `resolveBetas`, change the `model.endsWith("[1m]")` check to "1M-eligible model" — keep attaching `context-1m-2025-08-07` for `[1m]` IDs but skip it for `claude-opus-4-8` (the API rejects unknown betas; 4.8 already gives 1M without it). (2) In `createWithOptionalMcp`, the `[1m]` strip stays put (still needed for Opus 4.7 [1m] legacy sessions); add a passthrough comment that `claude-opus-4-8` needs no strip. |
| `web/components/ContextTierSelector/ContextTierSelector.tsx` | (1) Update the `OPTIONS` array: `200k` → label `Sonnet`, cost `Sonnet · standard pricing`, modelId `claude-sonnet-4-6`; `1m` → label `Opus`, cost `Opus 4.8 · 1M context · ~5× Sonnet`, modelId `claude-opus-4-8`. (2) Update the docstring + tooltip wording to drop "10× cost" (the 1M premium is gone; the new framing is Opus-vs-Sonnet model choice). (3) The component's `value` type (`'200k' \| '1m'`), `modelIdForTier`, and `tierForModelId` keep their existing names — they're stable API. (4) `tierForModelId` returns `'1m'` for **either** `[1m]`-suffixed IDs (legacy resume) or `claude-opus-4-8`. (5) Add `displayNameForTier(tier: ContextTier): string` exported alongside the existing helpers — returns `"Claude Sonnet 4.6"` for `'200k'` and `"Claude Opus 4.8"` for `'1m'`. Used by the chat header to render a reactive "Powered by …" label. |
| `web/components/ChatInterface/ChatInterface.tsx` | (1) Replace the static `<span>Powered by {defaultModelName}</span>` (line 1386) with `<span>Powered by {displayNameForTier(contextTier)}</span>`, importing `displayNameForTier` from the selector module. This makes the badge track the selector value before the first message AND the resumed conversation's locked model afterward. (2) Drop the `defaultModelName` prop and the `'Claude Sonnet'` default at the prop destructuring site (line 472) — it's no longer plumbed in. Search for any callers passing `defaultModelName` (likely `app/chat/page.tsx`) and remove. (3) Grep for `10×`, `2×`, `cost premium`, `1M premium` in this file (and the rest of the chat UI) and update copy to match the new Sonnet/Opus framing. |
| `web/app/chat/page.tsx` *(or wherever `<ChatInterface>` is rendered)* | Drop the `defaultModelName="…"` prop pass-through. The header now derives from `contextTier` state inside `ChatInterface`, so no external feed needed. |
| `web/lib/context-manager.ts` | Update the docstring at line 1260-1276 ("1M-context Opus 4.7 variant (suffix `[1m]`)") to mention 4.8 as the default-1M case. No code change — the `getContextBudget` call already routes correctly once `isOneMillionContextModel` is widened in config.ts. |
| `cli/src/index.js` | (1) Update the `--context` flag's `1m` mapping from `claude-opus-4-7[1m]` to `claude-opus-4-8`. (2) Add a `--model` alias that accepts `sonnet \| opus` and maps to the canonical IDs. Update the help text. (3) Keep `claude-opus-4-7[1m]` as a recognized input for backward compat with running shells. |
| `docs/configuration.md` | Update the `ORG_CONTEXT` / pricing / 1M tier references. Specifically: drop the "$30/Mtok" premium language; mention Opus 4.8 is 1M-by-default; note `CLAUDE_OPUS_1M_MODEL` is now legacy. |
| `docs/deployment.md` | Rewrite the lines at 318-320: `CLAUDE_OPUS_1M_MODEL` is legacy, `NEO_CONTEXT_MAX_INPUT_TOKENS_1M` now also applies to Opus 4.8 sessions, `USAGE_LIMIT_2H_INPUT_TOKENS` calibration stays at $15/Mtok (no caveat needed). |
| `docs/agent-loop.md` | Update lines 223, 289, 800, 810. Replace "Opus 4.7 [1m]" with "Opus 4.8 (1M default)" in the per-conversation model selection section. Note that the `[1m]` suffix is still recognised for backward compat. |
| `docs/user-guide.md` | Line 414: drop the `claude-opus-4-7[1m]` API example, replace with `claude-opus-4-8`. |
| `web/test/agent-mcp.test.ts` *(and other tests referencing `[1m]`)* | Add a new test pinning that `claude-opus-4-8` does NOT receive the `context-1m-2025-08-07` beta header (the model has 1M by default). The existing legacy-1M test stays — verify it still passes. |
| `web/test/usage-tracker.test.ts` | Add `claude-opus-4-8` to the pricing-coverage matrix (verify it computes correct USD given the $15/$75 rates). |
| `web/lib/config.ts` validator block | If there's a startup guard that asserts every `SUPPORTED_MODELS` value has a `TOKEN_PRICING` entry, the 4.8 add covers it. Verify `validateConfig()` doesn't need adjustment. |

---

## Implementation Steps

### 1. Add Opus 4.8 to the model registry (config-only)

- Edit `web/lib/config.ts`:
  - `MODEL_OUTPUT_CEILINGS`: add `"claude-opus-4-8": 32_000`.
  - `TOKEN_PRICING`: add `"claude-opus-4-8": { input: 15, output: 75 }`.
  - `SUPPORTED_MODELS["Opus"]`: change default to `claude-opus-4-8`.
  - Rename the `"Opus 4.7 (1M context)"` entry to `"Opus (1M, legacy)"`; update the docstring above it to call it the legacy entry, kept until in-flight sessions age out.
  - `isOneMillionContextModel`: return `true` for `claude-opus-4-8` in addition to the existing `endsWith("[1m]")` check. Add an `ALWAYS_1M_MODELS` Set for cleanliness: `new Set(["claude-opus-4-8"])`.
  - Update comments at lines 44 and 281-285 to reflect that 4.8 has 1M by default.

### 2. Skip the `context-1m` beta on Opus 4.8

- In `web/lib/agent.ts` `resolveBetas`:
  - Change `if (model.endsWith("[1m]")) betas.push(CONTEXT_1M_BETA);` to attach the beta only for the legacy `[1m]` path: `if (model.endsWith("[1m]") && !model.startsWith("claude-opus-4-8"))` — or, more simply, attach the beta only when `model.endsWith("[1m]")` and explicitly NOT when the model id matches `claude-opus-4-8`.
  - Add a comment noting Opus 4.8 has 1M by default; sending the beta header is harmless today but the API may reject it in future.

### 3. Repoint the tier selector + add display-name helper

- Edit `web/components/ContextTierSelector/ContextTierSelector.tsx`:
  - `OPTIONS`: `[{ value: '200k', label: 'Sonnet', modelId: 'claude-sonnet-4-6', cost: 'Sonnet · standard pricing' }, { value: '1m', label: 'Opus', modelId: 'claude-opus-4-8', cost: 'Opus 4.8 · 1M context · ~5× Sonnet' }]`.
  - Component docstring: drop the "1M tier is priced ~10× the default" line; reframe as a Sonnet-vs-Opus model picker that locks at first message.
  - `tierForModelId`: return `'1m'` for `claude-opus-4-8` as well as `[1m]`-suffixed legacy IDs.
  - Add new export `displayNameForTier(tier: ContextTier): string` — `'200k'` → `"Claude Sonnet 4.6"`, `'1m'` → `"Claude Opus 4.8"`. Lives next to `modelIdForTier` / `tierForModelId` so the Sonnet/Opus mapping has a single source of truth.
  - Consider renaming the value `'1m'` → `'opus'` and `'200k'` → `'sonnet'` for clarity — but this ripples through Cosmos persistence (`session.modelTier` if any) so keep the `'200k' | '1m'` literals stable in this PR.
- Re-export `displayNameForTier` from `web/components/index.ts` next to the existing `modelIdForTier` / `tierForModelId` exports.

### 4. Wire the chat header to track the tier

- Edit `web/components/ChatInterface/ChatInterface.tsx`:
  - Add `displayNameForTier` to the existing `@/components` import alongside `modelIdForTier` / `tierForModelId`.
  - Replace the badge at line 1386: `<span>Powered by {defaultModelName}</span>` → `<span>Powered by {displayNameForTier(contextTier)}</span>`. The `contextTier` state is already reactive — it updates when the selector changes, when a conversation resumes (via `tierForModelId(conv.model)`), and when "New conversation" fires (via `resetContextTierToPreference`). So the badge tracks all three paths for free.
  - Remove the `defaultModelName` prop from `ChatInterfaceProps` and the `defaultModelName = 'Claude Sonnet'` default at the destructuring site.
- Edit `web/app/chat/page.tsx` (or wherever `<ChatInterface>` is instantiated): drop the `defaultModelName={…}` prop pass-through if any.
- Grep `web/components` and `web/app` for `defaultModelName` to confirm no other references remain.

### 5. CLI parity

- Edit `cli/src/index.js`:
  - `--context 1m` → `claude-opus-4-8` (was `claude-opus-4-7[1m]`).
  - Help text: drop the "10× cost" warning; mention Opus 4.8 is the Opus option at standard pricing.

### 6. Docs sweep

- Update `docs/deployment.md`, `docs/configuration.md`, `docs/agent-loop.md`, `docs/user-guide.md` per the table above. Grep for `[1m]` and `Opus 4.7` to catch stragglers.

### 7. Tests

- Add `web/test/opus-4-8-migration.test.ts` (new file):
  - `claude-opus-4-8` resolves through `SUPPORTED_MODELS` and `TOKEN_PRICING`.
  - `resolveBetas("claude-opus-4-8", false)` does NOT include `context-1m-2025-08-07`.
  - `resolveBetas("claude-opus-4-7[1m]", false)` still includes the beta (legacy resume path).
  - `getContextBudget("claude-opus-4-8")` returns the 1M thresholds.
  - `isOneMillionContextModel("claude-opus-4-8")` returns true.
  - `tierForModelId("claude-opus-4-8")` returns `'1m'`.
  - `modelIdForTier('1m')` returns `'claude-opus-4-8'`.
  - `displayNameForTier('200k')` returns `"Claude Sonnet 4.6"`.
  - `displayNameForTier('1m')` returns `"Claude Opus 4.8"`.
- Add a chat-interface test (or extend an existing one) for the reactive header:
  - Render `<ChatInterface>` with no `initialConversation`. Expect the header to show `"Powered by Claude Sonnet 4.6"` (the persisted-preference default).
  - Toggle the `<ContextTierSelector>` to "Opus" before any message is sent. Expect the header to update to `"Powered by Claude Opus 4.8"` synchronously.
  - Render with `initialConversation={{ model: "claude-opus-4-8", ... }}` (resume path). Expect the header to show `"Powered by Claude Opus 4.8"` from first paint and the selector to be locked.
  - Render with `initialConversation={{ model: "claude-opus-4-7[1m]" }}` (legacy resume). Expect the header to show `"Powered by Claude Opus 4.8"` — `tierForModelId` collapses both into the `'1m'` tier whose display name is the current Opus label.
- Update `web/test/usage-tracker.test.ts` to add a `claude-opus-4-8` row to whichever pricing-coverage test exists.
- Re-run the legacy `[1m]` strip test in `web/test/agent-mcp.test.ts` to confirm it still passes — that path remains untouched.

### 8. Manual verification

- Spin up `npm run dev`, start a new conversation with the selector on "Sonnet". Header shows `"Powered by Claude Sonnet 4.6"`. Toggle to "Opus" — header flips to `"Powered by Claude Opus 4.8"` immediately, no page reload. Send a small message; confirm in the network panel that `body.model = "claude-opus-4-8"` and no `context-1m-2025-08-07` beta header is attached.
- Resume an existing Opus 4.7 [1m] conversation; header shows `"Powered by Claude Opus 4.8"` (or whatever the `'1m'` display name is), selector is locked, and the underlying API call still attaches the `context-1m-2025-08-07` beta and strips `[1m]` before calling the API.
- Watch the `token_usage` event for the Opus 4.8 turn: cost should be `inputTokens × 15 / 1_000_000 + outputTokens × 75 / 1_000_000`, not 2×.

---

## Verification

1. `npm run typecheck` — clean (cron-parser pre-existing warning unchanged).
2. `npm run lint` — clean (ApiKeysSection pre-existing warning unchanged).
3. `npm run test` — all suites pass, including the new `opus-4-8-migration.test.ts`.
4. Manual: new conversation on Opus → `body.model = "claude-opus-4-8"`, no beta header, no `[1m]` suffix, response succeeds. Header reads `"Powered by Claude Opus 4.8"`.
5. Manual: toggle selector Sonnet ↔ Opus before sending the first message — header label flips in real time, no page reload.
6. Manual: resume an Opus 4.7 [1m] conversation → `body.model = "claude-opus-4-7"` (stripped), `context-1m-2025-08-07` beta attached, response succeeds. Header reads the `'1m'`-tier display name, selector is locked.
6. Manual: cost meter in Settings → Usage shows Opus 4.8 at $15/$75 (verify against the `token_usage` event metadata or the usage-tracker test).
7. Post-deploy: monitor logs for 24 hours; confirm no `context-1m` beta is sent on 4.8 calls and no 400s from the Anthropic API.

---

## Out of Scope (deferred to follow-up plans)

- **Phase 2 cleanup**: removing `claude-opus-4-6`, `claude-opus-4-7`, `claude-opus-4-7[1m]` from `SUPPORTED_MODELS` / `TOKEN_PRICING` / `MODEL_OUTPUT_CEILINGS` once the Cosmos `session.model` distribution shows zero live conversations on those IDs (~30-day window after Phase 1 ships).
- **`effort: "xhigh"` for scheduled-task runner**: the migration guide recommends `xhigh` for high-autonomy / cron work. Wire this into `runAgentLoop` (or specifically `scheduled-task-runner.executeTask`) as a separate change.
- **`stop_details` audit logging**: surface the refusal category on `token_usage` events when `stop_reason === "refusal"`. Separate plan.
- **Tier-selector rename**: changing the component's exported names from `ContextTierSelector` / `'200k' | '1m'` to `ModelTierSelector` / `'sonnet' | 'opus'` is cosmetic and would ripple through Cosmos persistence + the chat-interface state machine. Defer.
- **Mid-conversation system messages**: Opus 4.8 accepts `role: "system"` mid-array. Neo's context-compression currently uses a `<system_notice>` envelope inside a `user` message (P2 fix). Migrating to real system messages would be cleaner but is a separate refactor.
