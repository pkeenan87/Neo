# Spec for audit-quick-wins

branch: claude/feature/audit-quick-wins

## Summary

Bundle the highest-score-impact, lowest-risk fixes from the 2026-05-02 production-readiness audit (commit `7f56650`, weighted score `68.6/100`). Six discrete, additive changes that close cited gaps in SDLC scaffolding, law-firm readiness, and security defense-in-depth without touching any architectural primitives. Estimated lift: ~+7 weighted points (target ~75/100), at roughly three days of focused work.

This is a deliberate "quick wins" PR — it picks only items that are (a) explicitly recommended in the audit, (b) closeable with config or small code surface, and (c) carry no behavior-change risk for existing users. Larger structural items (SharePoint ACL trim, matter/client tenancy, outbound `safeFetch` + retries + circuit breakers, IaC port to Bicep, Auth.js `maxAge` change, `TEAMS_BOT_ROLE` pin to reader) are explicitly out of scope and will each be specced separately.

Audit reports retained at `/tmp/audit-{security,quality-architecture,sdlc,law-firm}.md` for cross-reference.

## Functional requirements

### 1. CI scaffolding (closes SDLC Critical findings)
- Add `.github/workflows/ci.yml` triggered on pull requests to `main` and on push to `main`. Steps: install (npm ci) → `tsc --noEmit` → `npx vitest run` → `next lint` → `npm audit --audit-level=high` → CodeQL JS/TS analyzer → gitleaks. Block merge on red.
- Add `.github/dependabot.yml` configured for weekly npm updates against `web/`, `cli/`, and `functions/csv-cleanup/`, plus weekly GitHub Actions updates.
- Add `.github/CODEOWNERS` requiring review of `web/lib/agent.ts`, `web/lib/executors.ts`, `web/lib/permissions.ts`, `web/lib/auth-helpers.ts`, `web/lib/auth.ts`, `web/lib/ai-search-auth.ts`, `web/lib/conversation-store-v2.ts`, `web/lib/api-key-store.ts`, `web/lib/secrets.ts`, `web/lib/logger.ts`, `web/lib/injection-guard.ts` from the security/architecture owner.
- Add `SECURITY.md` describing the disclosure inbox and supported reporting channel.
- Add `ARCHITECTURE.md` capturing the request-flow narrative the audit produced (route → agent loop → tool exec → result wrap → persist), v1/v2 store dispatch model, multi-instance shared-state primitives, and observability pipeline. Promote the existing inline comment narrative to prose.
- Add `.github/PULL_REQUEST_TEMPLATE.md` with sections for summary, test plan, security considerations, and audit-cite when applicable.
- Add `npm` scripts to `web/package.json`: `test` (`vitest run`), `typecheck` (`tsc --noEmit`), `lint` (`next lint`).
- Add a baseline ESLint config (`web/eslint.config.mjs` or equivalent for Next.js 15) with `@typescript-eslint`, the Next.js plugin, and rules that fail on `any`, on `console.log` outside test files, and on unused variables that are not `_`-prefixed.

### 2. Legal-hold enforcement (closes Law Firm Critical C3)
- `DELETE /api/conversations/[id]` (`web/app/api/conversations/[id]/route.ts`) must check the conversation's `retentionClass` before calling the store. If `retentionClass === "legal-hold"`, return HTTP `423 Locked` with a structured error body and emit a `legal_hold_violation` audit event including the actor identity, the target conversation id, and the attempted action.
- The same gate must be re-checked inside `deleteConversationV2` (`web/lib/conversation-store-v2.ts`) so the store is defense-in-depth even if a future caller bypasses the route layer.
- The blob-offload lifecycle (`web/lib/tool-result-blob-store.ts`) must not delete or expire blobs referenced by a conversation root that is on legal-hold. The reconciliation TODO at `web/lib/tool-result-blob-store.ts:44` must respect the same gate.
- Add `legal_hold_violation` to the `LogEventType` union in `web/lib/types.ts` and to the analytics event-type allowlist in `web/lib/logger.ts` if appropriate.

### 3. UPN hashing in api-keys route logs (closes Security Medium)
- `web/app/api/api-keys/route.ts:90-95` (the POST handler that creates a key) and `web/app/api/api-keys/[id]/route.ts:31` (the DELETE handler that revokes a key) currently log `createdBy: identity.name` and `revokedBy: identity.name`, which leak UPN/email. Replace with `hashPii(identity.ownerId)` per the logger's documented PII contract (`web/lib/logger.ts:100-103`).
- Audit the rest of the API-key route surface to confirm no other unhashed UPN fields are emitted.

### 4. Anthropic per-user attribution (closes Law Firm High H2)
- Every call to `client.messages.create` in `web/lib/agent.ts` (the main agent loop, the resumption path, and the Haiku compression call in `web/lib/context-manager.ts` if applicable) must include `metadata: { user_id: hashPii(ownerId) }` so Anthropic-side trust-and-safety enforcement can be user-scoped.
- The `ownerId` available in the agent loop's identity envelope (via `setLogContext` / `getLogContext`) is the source of truth. If the Haiku compression call sits below the identity context, plumb the user id through explicitly rather than skipping the field.

### 5. executeTool defense-in-depth role re-check (closes Security High)
- `executeTool` (`web/lib/executors.ts:3842-3873`) must re-check `canUseTool(role, toolName)` at the top of the function and throw a clear error if the role lacks permission. Today the only barrier between a model-emitted destructive `tool_use` and a real Microsoft Graph call is the `DESTRUCTIVE_TOOLS` confirmation gate; the audit recommends defense-in-depth.
- Thread `role` through `ExecuteToolContext` (`web/lib/executors.ts:3417`) so the role is available at dispatch time. All call sites of `executeTool` must pass it.
- Define `canUseTool(role, toolName)` in `web/lib/permissions.ts` if it does not already exist; export from the same module as `getToolsForRole`.

### 6. MOCK_MODE production guard (closes Security Medium)
- `validateConfig()` in `web/lib/config.ts` must throw if `process.env.NODE_ENV === "production" && env.MOCK_MODE`. The boot guard already exists for `DEV_AUTH_BYPASS`; this is the parallel control for the mock executor surface, which would otherwise silently swallow tool calls and re-activate the API-key file fallback.
- Failure mode is fail-fast at server start, not at first tool call.

## Figma Design Reference (only if referenced)

Not applicable — this is backend, configuration, and CI/governance work with no UI surface.

## Possible Edge Cases

- **CI runs against PR forks** — token-bearing steps (CodeQL, npm audit private feeds if any) must degrade gracefully when secrets are unavailable. Pin to first-party-PR-only when a job needs a secret.
- **gitleaks false positives** in the `_specs/`/`_plans/` directories where credential-shaped strings appear in worked examples. Maintain a `.gitleaksignore` if necessary; never disable scanning wholesale.
- **Dependabot churn vs. exact-pinned dependencies** — the project pins exactly (no `^`), so every patch update produces a PR. Configure Dependabot grouping (e.g. by ecosystem, with `groups: { azure: ["@azure/*"] }`) so the PR queue stays manageable.
- **`legal_hold_violation` audit event collision** — confirm no existing event type uses the same identifier; add a test pinning the event-type union shape.
- **Blob-offload reconciliation interplay with legal-hold** — orphan-blob cleanup must consult Cosmos to confirm no conversation root marks the SHA as legal-held before deleting. Naive reconciliation that only checks recent blob refs would falsely orphan held blobs.
- **`hashPii(identity.ownerId)` vs `hashPii(identity.name)`** — `ownerId` is the AAD object id and is the correct stable identifier for hashing. Confirm before swapping.
- **Anthropic `metadata.user_id` length** — Anthropic limits this field; truncate the hash to a safe length (it is already 16 chars per `hashPii`).
- **`canUseTool` mismatch behavior** — should the executor throw a typed error the agent loop can format for the user, or should it 500? Decide on a typed error that the agent surfaces as "Tool not permitted for your role" without leaking schema info.
- **`MOCK_MODE` production guard during smoke tests** — confirm the guard does not break ops smoke procedures that intentionally run against a staging environment with `MOCK_MODE=true`. Staging should either set `NODE_ENV !== "production"` or use a dedicated staging mode flag.
- **CODEOWNERS bootstrap** — until a second reviewer exists, the OWNERS-required-review rule will block the bundle PR itself. Stage CODEOWNERS to take effect in a follow-up PR, or open the bundle as the inaugural reviewed PR with a designated reviewer.
- **ESLint baseline noise** — turning on rules that fail on `any` may produce immediate failures on existing strict-mode-violating files. Either run `eslint --fix` on the introduction PR (only if changes are mechanical and reviewable) or scope the new rules to changed files via a CI-only path.

## Acceptance Criteria

### CI scaffolding
- [ ] `.github/workflows/ci.yml` runs on every PR and on push to `main`; passes on the bundle PR itself.
- [ ] CI includes typecheck, vitest, ESLint, `npm audit --audit-level=high`, CodeQL, gitleaks; merge is blocked on red.
- [ ] `.github/dependabot.yml` covers `web/`, `cli/`, `functions/csv-cleanup/`, and `github-actions`.
- [ ] `.github/CODEOWNERS` exists and lists the security/architecture owner for the agreed paths.
- [ ] `SECURITY.md` and `ARCHITECTURE.md` exist at the repo root.
- [ ] `.github/PULL_REQUEST_TEMPLATE.md` exists.
- [ ] `web/package.json` defines `test`, `typecheck`, `lint`; each runs cleanly locally.
- [ ] ESLint baseline config exists; `npm run lint` passes on all files committed by this PR.

### Legal-hold enforcement
- [ ] `DELETE /api/conversations/[id]` returns `423` and emits `legal_hold_violation` when `retentionClass === "legal-hold"`.
- [ ] `deleteConversationV2` enforces the same gate at the store layer.
- [ ] Blob-offload reconciliation respects legal-hold and does not GC blobs referenced by a held conversation.
- [ ] `legal_hold_violation` is a recognized `LogEventType`.

### UPN hashing
- [ ] `web/app/api/api-keys/route.ts` and `web/app/api/api-keys/[id]/route.ts` emit only `hashPii(ownerId)` for actor attribution; no UPN/email in metadata.
- [ ] No other api-key-related route logs an unhashed UPN.

### Anthropic attribution
- [ ] Every `client.messages.create` in `web/lib/agent.ts` and `web/lib/context-manager.ts` (Haiku call) carries `metadata: { user_id: hashPii(ownerId) }`.

### executeTool role re-check
- [ ] `ExecuteToolContext` carries `role`.
- [ ] `executeTool` calls `canUseTool(role, toolName)` and throws on mismatch.
- [ ] `canUseTool` is exported from `web/lib/permissions.ts`.
- [ ] All call sites of `executeTool` pass `role`.

### MOCK_MODE production guard
- [ ] `validateConfig` throws on boot when `NODE_ENV === "production"` and `MOCK_MODE` is true.

### Overall
- [ ] `npx tsc --noEmit` is clean.
- [ ] `npx vitest run` passes; new tests added for legal-hold gate, role re-check, MOCK_MODE guard, UPN hashing in api-keys logs.
- [ ] No regression in the AI Search executor tests (22 cases) or other existing 458 tests.
- [ ] Audit reports referenced in commit body or PR description; weighted-score lift estimated and recorded.

## Open Questions

- **CODEOWNERS bootstrap path** — the rule will require a non-author reviewer immediately after merge. Should we hold the rule in a follow-up PR until at least one external reviewer is designated, or merge it now and accept that the next PR after this one is the first reviewed one? hold that rule.
- **CodeQL config** — default queries only, or also enable the `security-extended` and `security-and-quality` query suites? Recommended starting point: `security-extended`. Confirm. confirmed.
- **Dependabot grouping strategy** — group by ecosystem (`@azure/*`, `@anthropic-ai/*`, `next + react`, etc.) to reduce noise, or accept one PR per dependency for finer-grained review? Recommended: group `@azure/*` and the `botbuilder` cluster; everything else individual. agreed.
- **`canUseTool` semantics for read-only tools** — should it default-allow any read-only tool for any role, or maintain a per-role read-only allowlist as well? Today only destructive tools have role-gated visibility; preserve that or tighten? tighten.
- **`legal_hold_violation` event severity routing** — does it belong on the operational Event Hub, the analytics Event Hub, or both? Recommended: both (operational for ops alerting, analytics for trend reporting). both.
- **MOCK_MODE production guard escape hatch** — if a future scenario requires running production-like infra in mock mode (e.g. live-fire DR drill), do we need a documented escape variable, or do we accept that this is intentional friction? accept.
- **Anthropic `metadata.user_id` for service-principal callers** — when a Teams thread or a service-principal API key invokes the agent, the `ownerId` is synthetic. Hash the synthetic id (so it is at least stable per service principal), or pass an empty/omitted metadata in those cases? Recommended: hash the synthetic id; document the convention. hash.
- **ARCHITECTURE.md scope** — narrative-only, or include a Mermaid diagram of the request flow? Mermaid renders inline on GitHub and adds review value at low cost. mermaid.

## Testing Guidelines

Create test file(s) under `web/test/` for the new behavior. Mirror the structure of existing executor tests (vitest + `vi.hoisted` mocks). Cover at minimum:

- **Legal-hold enforcement**
  - DELETE on a `legal-hold` conversation returns 423 and emits `legal_hold_violation` exactly once.
  - DELETE on a `standard-7y` / `transient` / `client-matter` conversation succeeds (no regression).
  - `deleteConversationV2` rejects a legal-held conversation even when called directly (defense-in-depth).
  - Blob-offload reconciliation skips blobs referenced by a legal-held root.

- **executeTool role re-check**
  - `executeTool` with `role: "reader"` and a destructive `toolName` throws (without invoking the executor function).
  - `executeTool` with `role: "admin"` and the same destructive tool dispatches normally.
  - Adding the role check does not regress the existing 458-test suite.

- **MOCK_MODE production guard**
  - `validateConfig` throws when `NODE_ENV === "production" && MOCK_MODE === true`.
  - `validateConfig` does not throw when `NODE_ENV === "development"` or when `MOCK_MODE === false`.

- **UPN hashing in api-keys logs**
  - POST `/api/api-keys` log entry contains `hashPii(ownerId)` and does NOT contain the UPN/email string.
  - DELETE `/api/api-keys/[id]` log entry same.

- **Anthropic `metadata.user_id`**
  - The agent loop's `client.messages.create` call body includes `metadata.user_id` matching `hashPii(ownerId)` from the identity envelope.
  - Haiku compression call carries the same field if reachable.

- **CI bring-up**
  - The new ESLint config does not produce errors on the existing tree (or, if it does, the offending changes are made in this PR and reviewable).
  - `npm run typecheck` and `npm run lint` pass locally and in CI on the bundle PR.
