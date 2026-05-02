# Audit Quick Wins

## Context

Implements the bundled "quick wins" from the 2026-05-02 production-readiness audit (commit `7f56650`, weighted score `68.6/100`). Six discrete, additive changes that close cited Critical/High/Medium gaps in SDLC scaffolding, law-firm readiness, and security defense-in-depth without touching architectural primitives. Larger items (SharePoint ACL trim, matter tenancy, outbound `safeFetch`+retries+circuit breakers, IaC port to Bicep, Auth.js `maxAge`, `TEAMS_BOT_ROLE` pin) are explicitly out of scope and will be specced separately.

User answers to the spec's Open Questions are now baked in: CODEOWNERS rule **does not** require review on the bundle PR itself (file added but not enforced); CodeQL uses **`security-extended`**; Dependabot **groups `@azure/*` and the `botbuilder` cluster**, everything else individual; `canUseTool` is **tightened** with a per-role read-only allowlist data structure (admin/reader keep "all"; the structure is in place for future narrowing of triage); `legal_hold_violation` events route to **both** Event Hubs; **no escape hatch** for the `MOCK_MODE` production guard; service-principal / synthetic owner ids are hashed for `metadata.user_id`; `ARCHITECTURE.md` includes a **Mermaid** request-flow diagram.

---

## Key Design Decisions

- **One PR, six themes, isolated commits.** Each theme commits independently so a problem with one doesn't block the others. Commit order: CI scaffolding → MOCK_MODE guard → UPN hashing → Anthropic attribution → executeTool re-check → legal-hold enforcement.
- **Reuse the existing `isLegalHold` helper** (`web/lib/retention.ts:55-57`) and `canUseTool` (`web/lib/permissions.ts:38-41`). Don't re-implement.
- **Block the legal-hold gate at TWO layers** — the route (`web/app/api/conversations/[id]/route.ts` DELETE) returns 423; the store (`web/lib/conversation-store-v2.ts` `deleteConversationV2`) throws a typed `LegalHoldViolationError`. The v1 store path (`web/lib/conversation-store.ts:478-488` `deleteConversationV1Internal`) gets the same gate so dual-write/dual-read modes behave consistently.
- **Blob-offload "lifecycle gate" reduces to a documented invariant.** `web/lib/tool-result-blob-store.ts` has no active blob-deletion code path today (only a 7-day Azure Storage lifecycle policy on `staging/` set externally, plus `deleteIfExists` for the staging copy after promote). The legal-hold protection already follows from blocking `deleteConversationV2` — that's where the `BlobRefDoc` rows live. Document the invariant in `tool-result-blob-store.ts` near the existing `TODO(reconciliation)` (line 44) so the future reconciliation job inherits the requirement.
- **Plumb `ownerId` through `RunAgentLoopOptions`** rather than rely on AsyncLocalStorage. Three call sites of `runAgentLoop` already have `identity.ownerId` in scope (`web/app/api/agent/route.ts:462`, `web/app/api/triage/route.ts:419`, `web/app/api/teams/messages/route.ts:602`); explicit plumbing is clearer than implicit context lookups inside the SDK call.
- **Hash synthetic owner ids identically to real ones.** Teams thread sessions use `teams-thread:<conversationId>` as `ownerId`; service-principal API keys use a synthetic id too. `hashPii(ownerId)` returns 16 hex chars regardless of input shape, which fits Anthropic's `metadata.user_id` size policy.
- **`canUseTool` tightening is data-only in this PR.** Add `allowedReadOnlyTools: Set<string> | "all"` to `RolePermissions`; keep all three roles at `"all"` for now. The structural change unblocks future per-role narrowing without changing today's behavior. `executeTool` re-checks via `canUseTool` get the throw-on-mismatch behavior for free if a future PR narrows the allowlist.
- **Defense-in-depth `executeTool` throw is a clear typed error.** Define `ToolPermissionError` so the agent loop can catch and surface "Tool not permitted for your role" without leaking schema. The loop already wraps tool errors via `wrapAndMaybeOffloadToolResult`; the typed error makes that wrapping unambiguous.
- **CI scaffolding is incremental, not "big bang."** ESLint baseline starts at `next lint` defaults plus `@typescript-eslint/no-explicit-any: error`; if existing files trip rules they are fixed in this PR (since the audit already pinned zero `any` in source). Tighter rules (e.g. `no-console` outside tests) are on the same PR but only if they introduce zero failures; otherwise deferred to a follow-up.
- **CODEOWNERS rule is staged-not-enforced on this PR.** Add `.github/CODEOWNERS` with the file paths but don't add `branch.protect`-side "required review" yet (per the user's answer to the spec). The next PR after this one is the first to be reviewer-gated.
- **Dependabot grouping favors review ergonomics.** Group `@azure/*` and the `botbuilder*` cluster (the latter dragged in 6 of the 12 moderate vulns); everything else gets its own PR.
- **`MOCK_MODE` guard uses `process.env.NODE_ENV` directly**, mirroring the existing `DEV_AUTH_BYPASS` guard at `web/lib/config.ts:308-310`. Throw on boot, no escape hatch, no env-var override.

---

## Files to Change

| File | Change |
|------|--------|
| `.github/workflows/ci.yml` | **NEW.** Triggers on PRs to `main` and pushes to `main`. Jobs: `lint-typecheck-test` (Ubuntu, Node 20, runs `npm ci`, `npm run typecheck`, `npm run lint`, `npm run test`, `npm audit --audit-level=high`); `codeql` (GitHub-hosted, `javascript-typescript`, `security-extended`); `gitleaks` (`gitleaks/gitleaks-action@v2`). |
| `.github/dependabot.yml` | **NEW.** Weekly updates for `web/` (npm), `cli/` (npm), `functions/csv-cleanup/` (npm), `/` (github-actions). Two groups: `azure-sdk` matching `@azure/*`, `bot-framework` matching `botbuilder*` + `botframework*`. |
| `.github/CODEOWNERS` | **NEW.** Lists security/architecture-sensitive paths (agent, executors, permissions, auth, ai-search-auth, conversation stores, api-key-store, secrets, logger, injection-guard) with `@pkeenan87` as owner placeholder. Per user's open-question answer, do NOT enable required-review enforcement on this PR. |
| `SECURITY.md` | **NEW.** Disclosure inbox + supported reporting channel + scope statement. |
| `ARCHITECTURE.md` | **NEW.** Promotes the audit's request-flow narrative to prose; includes a Mermaid diagram of route → agent loop → tool exec → result wrap → persist; documents v1/v2 store dispatch model, multi-instance shared-state primitives, observability pipeline. |
| `.github/PULL_REQUEST_TEMPLATE.md` | **NEW.** Sections: Summary; Test plan; Security considerations (CSRF/authn/destructive paths); Audit cite (when applicable). |
| `.gitleaksignore` | **NEW (if needed).** Reserve a path for `_specs/`/`_plans/` false positives. Empty initially. |
| `web/package.json` | Add `"test": "vitest run"`, `"typecheck": "tsc --noEmit"`, `"lint": "next lint"`. |
| `web/eslint.config.mjs` | **NEW.** Next.js 15 flat config + `@typescript-eslint/no-explicit-any: error` + `unused-imports/no-unused-vars` (with `_` prefix exception). Devdeps `eslint`, `@typescript-eslint/parser`, `@typescript-eslint/eslint-plugin`, `eslint-plugin-unused-imports`, `eslint-config-next`. |
| `web/lib/types.ts` | Add `legal_hold_violation` to `LogEventType` union (`web/lib/types.ts:155-171`). |
| `web/lib/logger.ts` | Add `legal_hold_violation` to `ANALYTICS_EVENT_TYPES` (`web/lib/logger.ts:175-181`) so it routes to the analytics Event Hub *in addition to* the operational sink (which receives every entry by default). |
| `web/lib/permissions.ts` | Add `allowedReadOnlyTools: Set<string> \| "all"` field to `RolePermissions`; default all three roles to `"all"`. Tighten `canUseTool` to: (a) reject unknown tool names not in `TOOLS`; (b) consult `allowedReadOnlyTools` for non-destructive tools. Export `ToolPermissionError`. |
| `web/lib/executors.ts` | Add `role: Role` to `ExecuteToolContext` interface (`:3417-3429`). At the top of `executeTool` (`:3842-3873`), if `context?.role` is provided and `canUseTool(context.role, toolName) === false`, throw `ToolPermissionError`. (`role` is optional for backwards compat with non-agent callers — they can omit and skip the check.) |
| `web/lib/agent.ts` | Pass `role: role` in the `ExecuteToolContext` for both `executeTool` calls (`:511`, `:803`). Add `metadata: { user_id: hashPii(ownerId) }` to the `client.messages.create` `apiParams` (`:342-348`). Plumb `ownerId` via a new optional field on `RunAgentLoopOptions`. |
| `web/lib/context-manager.ts` | Add `metadata: { user_id: hashPii(ownerId) }` to both `anthropicClient.messages.create` calls (`:346`, `:679`). Plumb `ownerId` from the agent loop via new field on the existing options/context bag. |
| `web/lib/config.ts` | In `validateConfig()` (`:284-370`), add `if (process.env.NODE_ENV === "production" && env.MOCK_MODE) throw new Error(...)` next to the existing `DEV_AUTH_BYPASS` check (`:302-304`). |
| `web/lib/conversation-store.ts` | In `deleteConversationV1Internal` (`:478-488`), read the conversation root first and throw `LegalHoldViolationError` if `isLegalHold(retentionClass)`. The route-layer check is the primary; this is defense-in-depth. |
| `web/lib/conversation-store-v2.ts` | In `deleteConversationV2` (`:660-703`), after the existing owner check, check `isLegalHold(resource.retentionClass)` and throw `LegalHoldViolationError` before the partition delete. |
| `web/lib/retention.ts` | Export `LegalHoldViolationError` class so route + both stores can throw/catch the same type. |
| `web/lib/tool-result-blob-store.ts` | Update the inline note near `TODO(reconciliation)` at `:44-47` to require legal-hold consultation; no executable change in this PR. |
| `web/app/api/conversations/[id]/route.ts` | In `DELETE` (`:38-59`), after the existing owner/admin check, consult `isLegalHold(conv.retentionClass)`; if true, emit a `legal_hold_violation` event with `{conversationId, retentionClass, ownerIdHash, attemptedAction: "delete"}` and return `423 Locked` with `{error: "Conversation is on legal hold and cannot be deleted"}`. Catch `LegalHoldViolationError` from the store layer as a defense-in-depth path that returns the same 423. |
| `web/app/api/api-keys/route.ts` | At `:90-95`, replace `createdBy: identity.name` with `createdBy: hashPii(identity.ownerId)` and add `import { hashPii } from "@/lib/logger"` if missing. |
| `web/app/api/api-keys/[id]/route.ts` | At `:29-32`, replace `revokedBy: identity.name` with `revokedBy: hashPii(identity.ownerId)` and add `import { hashPii } from "@/lib/logger"`. |
| `web/app/api/agent/route.ts` | Pass `ownerId: identity.ownerId` through `RunAgentLoopOptions` at `:506-512`. |
| `web/app/api/triage/route.ts` | Pass `ownerId: identity.ownerId` through `RunAgentLoopOptions` at `:419` (similar shape). |
| `web/app/api/teams/messages/route.ts` | Pass `ownerId: session.ownerId` (or the synthetic teams-thread id) through `RunAgentLoopOptions` at `:602`. |
| `web/test/legal-hold-deletion.test.ts` | **NEW.** Vitest. Cover: 423 + `legal_hold_violation` emission for legal-hold; 204 for other classes; `deleteConversationV2` throws `LegalHoldViolationError` directly; `deleteConversationV1Internal` same; `LogEventType` union shape pinned. |
| `web/test/execute-tool-role-recheck.test.ts` | **NEW.** Vitest. Cover: `executeTool` with `role: "reader"` and a destructive tool throws `ToolPermissionError` *without* invoking the executor; `role: "admin"` passes through; absent `role` field stays backwards-compatible (existing tests). |
| `web/test/mock-mode-production-guard.test.ts` | **NEW.** Vitest. Cover: `validateConfig` throws when `NODE_ENV=production` + `MOCK_MODE=true`; does not throw on `development`; does not throw on `production` + `MOCK_MODE=false`. |
| `web/test/api-keys-logging.test.ts` | **NEW.** Vitest. Cover: POST emits `createdBy = hashPii(ownerId)` and NO UPN/email substring; DELETE same. |
| `web/test/agent-anthropic-metadata.test.ts` | **NEW.** Vitest. Cover: agent loop's `messages.create` body contains `metadata.user_id` matching `hashPii(ownerId)`; Haiku compression call same. |

---

## Implementation Steps

### 1. CI scaffolding (config-only; commit first so subsequent commits get linted on PR)

- Create `.github/workflows/ci.yml`. Jobs:
  - **`web-checks`**: `actions/checkout@v4`, `actions/setup-node@v4` with `node-version: 20` and `cache: npm` rooted at `web/package-lock.json`. Steps: `npm ci --prefix web`; `npm run typecheck --prefix web`; `npm run lint --prefix web`; `npm run test --prefix web`; `npm audit --prefix web --audit-level=high`. The audit step must `continue-on-error: true` initially (to absorb the existing 12 moderates without blocking the PR), with a TODO comment to flip to `false` once `Dependabot` has cleared the queue.
  - **`cli-checks`**: `npm ci --prefix cli`; `npm audit --prefix cli --audit-level=high`. (No tests in `cli/` today; the root `/test/` Node-test files are out of scope here.)
  - **`codeql`**: standard `github/codeql-action/init@v3` + `analyze@v3`, `language: javascript-typescript`, `queries: security-extended`.
  - **`gitleaks`**: `gitleaks/gitleaks-action@v2` with the default config; honour `.gitleaksignore` (created empty in this PR).
- Triggers: `on: { pull_request: { branches: [main] }, push: { branches: [main] } }`.
- Permissions: `contents: read`, `security-events: write` (CodeQL), `actions: read`.
- Add `.github/dependabot.yml` v2:
  - 4 ecosystems: `npm` rooted at `/web`, `/cli`, `/functions/csv-cleanup`; plus `github-actions` rooted at `/`.
  - Schedule `weekly` for all.
  - Two groups under the `/web` ecosystem: `azure-sdk` (`@azure/*`) and `bot-framework` (`botbuilder*`, `botframework*`). Other patches are individual PRs.
  - Set `open-pull-requests-limit: 5` per ecosystem to avoid PR flood.
- Add `.github/CODEOWNERS` (no required-review enforcement at the rule level — that lives in GitHub branch-protection settings, which the user will toggle later):
  - `* @pkeenan87` (catch-all)
  - `web/lib/agent.ts @pkeenan87`
  - `web/lib/executors.ts @pkeenan87`
  - `web/lib/permissions.ts @pkeenan87`
  - `web/lib/auth-helpers.ts @pkeenan87`
  - `web/lib/auth.ts @pkeenan87`
  - `web/lib/ai-search-auth.ts @pkeenan87`
  - `web/lib/conversation-store.ts @pkeenan87`
  - `web/lib/conversation-store-v2.ts @pkeenan87`
  - `web/lib/api-key-store.ts @pkeenan87`
  - `web/lib/api-key-crypto.ts @pkeenan87`
  - `web/lib/secrets.ts @pkeenan87`
  - `web/lib/logger.ts @pkeenan87`
  - `web/lib/injection-guard.ts @pkeenan87`
  - `.github/ @pkeenan87`
- Add `SECURITY.md` at repo root: short. Sections: "Reporting a vulnerability" (an inbox or "open a private security advisory" link), "Scope" (what's covered), "Out of scope" (third-party SaaS endpoints — Sentinel/Defender/Abnormal/etc.), "Response targets" (acknowledge within 5 business days).
- Add `ARCHITECTURE.md` at repo root: 3 sections.
  1. **Request flow** with the Mermaid diagram (route → resolveAuth → injection-guard → usage-tracker reservation → multipart parse → NDJSON stream open → runAgentLoop → prepareMessages → client.messages.create → tool dispatch → wrapAndMaybeOffloadToolResult → store).
  2. **Persistence** — DispatchingSessionStore with v1 vs v2 vs dual-read vs dual-write; Cosmos partition key; blob offload at 256KB.
  3. **Multi-instance shared state** — `instance-shared-counter`, triage circuit breaker, usage-tracker reservations, all Cosmos atomic patches with ETag/IfMatch.
- Add `.github/PULL_REQUEST_TEMPLATE.md` with: Summary | Test plan | Security considerations (CSRF / authn / destructive paths) | Audit cite (link to `_specs/` or audit report when applicable).
- Add `.gitleaksignore` (empty placeholder).
- Edit `web/package.json` `scripts`: add `test`, `typecheck`, `lint` per the spec.
- Add `web/eslint.config.mjs`:
  - Flat config compatible with Next.js 15.
  - Extends `next/core-web-vitals` and `@typescript-eslint/recommended`.
  - Rules: `@typescript-eslint/no-explicit-any: "error"`; `@typescript-eslint/no-unused-vars: ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }]`. Don't add `no-console` in this PR — it's a follow-up.
  - Ignores: `dist/`, `.next/`, `node_modules/`, `web/test/**` (looser rules in tests), `_specs/**`, `_plans/**`.
- Add devDependencies to `web/package.json`: `eslint`, `@typescript-eslint/parser`, `@typescript-eslint/eslint-plugin`, `eslint-config-next` (already present transitively but pin), `eslint-plugin-unused-imports` (only if needed for the unused-vars rule).
- Run `npm install --prefix web` to update the lockfile.
- Verify locally: `npm run typecheck --prefix web && npm run lint --prefix web && npm run test --prefix web` all pass.

### 2. MOCK_MODE production guard (one conditional in validateConfig)

- In `web/lib/config.ts` `validateConfig()`, add (next to the existing `DEV_AUTH_BYPASS` check at line 302):
  - `if (process.env.NODE_ENV === "production" && env.MOCK_MODE) throw new Error("MOCK_MODE must not be enabled in production — aborting. Set MOCK_MODE=false or NODE_ENV !== 'production'.")`
- Confirm `validateConfig` is invoked at boot. Currently called by `web/app/api/health/route.ts:20-33` per request — guarantees the failure surface is the health-check endpoint at minimum. If a startup-time call site is missing, defer to the existing call cycle (the next health probe after deploy will surface the misconfiguration).
- Tests: see Step 8.

### 3. UPN hashing in api-keys logs

- `web/app/api/api-keys/route.ts:90-95`: replace `createdBy: identity.name` with `createdBy: hashPii(identity.ownerId)`. Add `import { logger, hashPii } from "@/lib/logger"` (currently only imports `logger`).
- `web/app/api/api-keys/[id]/route.ts:29-32`: replace `revokedBy: identity.name` with `revokedBy: hashPii(identity.ownerId)`. Add `hashPii` to the existing import line.
- `grep -n "identity\.name" /Users/pkeenan/Documents/Neo/web/app/api/api-keys/` to confirm no other call sites in the api-keys route surface need the same fix.

### 4. Anthropic per-user attribution

- Add `ownerId?: string` to `RunAgentLoopOptions` (`web/lib/agent.ts:100-147`).
- In `web/lib/agent.ts` at the `apiParams` construction (`:342-348`), add `metadata: options.ownerId ? { user_id: hashPii(options.ownerId) } : undefined` (Anthropic SDK accepts `metadata?: { user_id?: string }`). Default to omitted when `ownerId` is missing — this preserves backwards-compat for any existing call sites that don't yet pass it.
- The retry helper (`createWithRetry` at `:52-98`) already forwards `apiParams` unchanged; no change needed.
- For `web/lib/context-manager.ts` Haiku calls at `:346` and `:679`: the calls live below the agent loop in the call stack. Plumb `ownerId` via the existing options/context bag passed into `prepareMessages` and downstream helpers. If the context type doesn't carry it, add an optional `ownerId?: string` field. If the call site doesn't have access to the agent's `ownerId`, accept that gap and add a TODO — but first try to plumb.
- Update three `runAgentLoop` call sites to pass `ownerId`:
  - `web/app/api/agent/route.ts:506-512` — `ownerId: identity.ownerId`
  - `web/app/api/triage/route.ts:419` — `ownerId: identity.ownerId`
  - `web/app/api/teams/messages/route.ts:602` — `ownerId: session.ownerId` (which may be the synthetic `teams-thread:<id>` — that's fine; `hashPii` handles any string)
- The `runAgentLoop` self-call at `:885` (`resumeAfterConfirmation`) and any other internal forwards pass through `options` — just verify nothing strips `ownerId`.

### 5. executeTool defense-in-depth role re-check

- In `web/lib/permissions.ts`:
  - Define and export `class ToolPermissionError extends Error` with `name = "ToolPermissionError"`.
  - Tighten `canUseTool(role, toolName)` to: reject when `toolName` is not the name of any tool in `TOOLS` (return `false`); reject when destructive and role lacks `canUseDestructiveTools` (existing behavior).
  - Add `allowedReadOnlyTools: Set<string> | "all"` field to `RolePermissions`; default all three roles to `"all"`. When the allowlist is `"all"`, behavior matches today; when it's a `Set<string>`, the tool name must be in the set.
  - Update `getToolsForRole` to honor `allowedReadOnlyTools` if/when narrowed.
- In `web/lib/executors.ts`:
  - Add `role?: Role` to `ExecuteToolContext` interface (`:3417-3429`). Optional for backwards compat.
  - In `executeTool` (`:3842`), at the top, before any dispatch logic, check `if (context?.role && !canUseTool(context.role, toolName)) throw new ToolPermissionError(...)`. Import `canUseTool`, `ToolPermissionError`, and `Role` from `./permissions`.
  - Internal short-circuits (`get_full_tool_result`, `query_csv`, `emit_plan`) should be checked too — those tool names exist in `TOOLS` and `getToolsForRole` already returns them for non-admin roles, so the re-check is a no-op for the existing role config but enforces the invariant.
- In `web/lib/agent.ts`:
  - Both `executeTool` calls (`:511` and `:803`) gain `role: role` in the context object. The `role` variable is already in scope at the loop level (it's a `runAgentLoop` parameter at `:152`).
- The agent loop already has try/catch around `executeTool` that converts errors into tool_results and `wrapAndMaybeOffloadToolResult`-wraps them; `ToolPermissionError` flows through that path naturally with a clean user-facing message.

### 6. Legal-hold enforcement (spans 4 files; ship together)

- In `web/lib/retention.ts`, define and export `class LegalHoldViolationError extends Error` with `name = "LegalHoldViolationError"`. Optional field `conversationId: string`.
- In `web/lib/types.ts:155-171`, append `"legal_hold_violation"` to the `LogEventType` union.
- In `web/lib/logger.ts:175-181`, append `"legal_hold_violation"` to the `ANALYTICS_EVENT_TYPES` set so the event ships to BOTH the operational and analytics Event Hubs (operational gets every entry by default; the set above adds analytics fan-out).
- In `web/lib/conversation-store-v2.ts` `deleteConversationV2` (`:660-703`):
  - After the existing owner check (`:671-673`), check `isLegalHold(resource.retentionClass)` — if true, throw `LegalHoldViolationError`. Do NOT enumerate or delete. The legal-hold log event is emitted by the route (single source); the store-layer throw is a structural invariant, not an audit event.
- In `web/lib/conversation-store.ts` `deleteConversationV1Internal` (`:478-488`):
  - Read the root via `container.item(id, ownerId).read()` before the delete. If the root has `retentionClass` and `isLegalHold` returns true, throw `LegalHoldViolationError`. (V1 doc may or may not carry retentionClass on older rows; treat absence as not-on-hold.)
- In `web/app/api/conversations/[id]/route.ts` `DELETE` (`:38-59`):
  - After the existing owner/admin gate (`:52-54`), check `isLegalHold(conv.retentionClass)`. If true:
    - Emit `logger.emitEvent("legal_hold_violation", "Legal hold prevented conversation delete", "api/conversations", { conversationId: id, retentionClass: conv.retentionClass, ownerIdHash: hashPii(identity.ownerId), action: "delete", role: identity.role })`. The metadata must use only the logger's safe-allowlist keys; `conversationId`, `role`, `ownerIdHash`, and `action` are already on the allowlist (`web/lib/logger.ts:94-146`); add `retentionClass` if not present (it isn't — append it to the allowlist in this same step).
    - Return `NextResponse.json({ error: "Conversation is on legal hold and cannot be deleted" }, { status: 423 })`.
  - Wrap the `deleteConversation` call in `try/catch`. If `err instanceof LegalHoldViolationError`, emit the same event (covers the defense-in-depth path) and return 423.
- In `web/lib/logger.ts`, add `retentionClass` and `action` to `SAFE_METADATA_FIELDS` if missing (re-check). Both are low-cardinality, non-PII string values.
- In `web/lib/tool-result-blob-store.ts:44-47`, replace the existing `TODO(reconciliation)` note with an updated version that explicitly requires the future reconciliation job to consult the conversation root's `retentionClass` and skip orphan-blob reaping when `isLegalHold(retentionClass)` is true. No executable change in this PR.
- The blob descriptor / per-turn doc deletes that happen as part of `deleteConversationV2` are protected automatically because `deleteConversationV2` itself now refuses to run on a legal-held conversation.

### 7. Tests — add five vitest files (non-overlapping scopes)

For each test file, follow the established pattern: top-of-file `vi.hoisted` for mocks, `vi.mock` factories for `../lib/config`, `../lib/logger`, and any module that hits Cosmos / Anthropic / fetch. Mirror `web/test/ai-search-executor.test.ts` for the hoisting style.

- **`web/test/legal-hold-deletion.test.ts`**:
  - `LegalHoldViolationError` is exported from `web/lib/retention.ts` and is the same instance imported by route + stores.
  - `LogEventType` union includes `"legal_hold_violation"` (compile-time pin via `Expect<Equals<...>>` or runtime check that the type is assignable).
  - `deleteConversationV2` throws `LegalHoldViolationError` for `retentionClass: "legal-hold"`, succeeds for `"standard-7y"` / `"transient"` / `"client-matter"`. Mock the Cosmos container.
  - `deleteConversationV1Internal` same.
  - `DELETE /api/conversations/[id]` returns 423 for legal-hold and emits `legal_hold_violation` exactly once with the documented metadata (no UPN, hashed ownerId). Returns 204 for other classes (existing behaviour preserved).
  - `DELETE` catches a thrown `LegalHoldViolationError` from the store and still returns 423 (defense-in-depth path).
- **`web/test/execute-tool-role-recheck.test.ts`**:
  - `executeTool` with `role: "reader"` + `toolName: "reset_user_password"` throws `ToolPermissionError` AND does NOT invoke the executor function (verify via `vi.spyOn` on the registry).
  - `executeTool` with `role: "admin"` + same tool dispatches normally (mocks the executor, verifies it was called once).
  - `executeTool` with NO `role` field in context still works (backwards-compat).
  - `canUseTool` rejects unknown tool names.
- **`web/test/mock-mode-production-guard.test.ts`**:
  - `validateConfig` throws when `process.env.NODE_ENV = "production"` and `env.MOCK_MODE = true`. Use `vi.stubEnv` (vitest helper) and re-import the module fresh per test.
  - `validateConfig` does NOT throw on `NODE_ENV = "development"` or `MOCK_MODE = false`.
  - `validateConfig` continues to enforce the existing `DEV_AUTH_BYPASS` and `COSMOS_ENDPOINT` rules.
- **`web/test/api-keys-logging.test.ts`**:
  - POST `/api/api-keys` calls `logger.info` with `createdBy` matching `hashPii(ownerId)` AND the metadata stringified does NOT contain the UPN/email substring. Mock `createApiKey`.
  - DELETE `/api/api-keys/[id]` same shape (`revokedBy`).
  - The hashed value is 16 hex chars (matches `hashPii` output).
- **`web/test/agent-anthropic-metadata.test.ts`**:
  - Run `runAgentLoop` with `options.ownerId = "user-123"`; assert the captured `client.messages.create` call's `apiParams.metadata.user_id` equals `hashPii("user-123")`.
  - Without `options.ownerId`, `apiParams.metadata` is `undefined` (no regression for non-passing callers).
  - Synthetic teams ids (`teams-thread:abc`) hash deterministically.
  - If feasible (depends on plumbing), assert the same for `context-manager` Haiku calls.

### 8. Wiring + verification

- `cd web && npm install` to refresh the lockfile after adding ESLint deps.
- `cd web && npx tsc --noEmit` — must be clean.
- `cd web && npx vitest run` — must pass; the existing 458 + the five new test files (estimate +20–25 cases).
- `cd web && npx eslint .` — must be clean. If failures appear in source files, fix them in this PR (the audit pinned zero `any` in source, so the no-explicit-any rule should not fire). If the failures are in `node_modules/.next/` etc., add to `ignores`.
- `cd web && npm audit --audit-level=high` — should report 0 high. The existing 12 moderates remain; they're tracked by Dependabot now.
- Manual: `cd web && npm run dev`, request `/api/health`, confirm 200 (and that the new `MOCK_MODE` guard does not fire under `NODE_ENV=development`).
- Local `git log --oneline` per-commit review before pushing — six clean commits in the agreed order.

---

## Verification

1. **CI scaffolding lands and runs.** Confirm `.github/workflows/ci.yml`, `dependabot.yml`, `CODEOWNERS`, `SECURITY.md`, `ARCHITECTURE.md`, `PULL_REQUEST_TEMPLATE.md` exist; `npm run test`, `typecheck`, `lint` are defined in `web/package.json` and pass locally.
2. **TypeScript is clean.** `cd web && npx tsc --noEmit` exits 0.
3. **All vitest cases pass.** `cd web && npx vitest run` — 458 prior + ~20-25 new cases all green.
4. **ESLint is clean.** `cd web && npx eslint .` exits 0.
5. **Production-mode boot rejects MOCK_MODE.** Set `NODE_ENV=production` + `MOCK_MODE=true` in a throwaway shell, hit `/api/health`, confirm 503 with the expected error.
6. **Legal-hold gate, manual.** With dev auth bypass, create a conversation, set its `retentionClass` to `"legal-hold"` directly in Cosmos / mock store, attempt DELETE — confirm 423 and a `legal_hold_violation` console line.
7. **executeTool re-check, manual.** Force a `reader` role to attempt a destructive tool (set role via dev bypass + crafted message); confirm the agent loop surfaces a "Tool not permitted" tool-result without invoking Microsoft Graph.
8. **API-key logs are clean of UPN.** Create + revoke a key with dev bypass; grep dev-console output for any `@`-containing UPN — expect none. Hashed `createdBy`/`revokedBy` is present.
9. **Anthropic metadata is sent.** With dev bypass + `MOCK_MODE=true`, intercept the Anthropic SDK call (e.g. via the existing `vi.mock` pattern if running tests, or a one-off `console.log` patch in dev) and confirm `metadata.user_id` is set and equals `hashPii(ownerId)` for the dev user.
10. **CI passes on the bundle PR.** Push the branch and confirm GitHub Actions reports green for `lint-typecheck-test`, `codeql`, and `gitleaks`.
11. **No regression in the AI Search executor tests** — the 22 existing cases at `web/test/ai-search-executor.test.ts` still pass.
12. **Commit log is six clean commits**, in the order: CI scaffolding → MOCK_MODE guard → UPN hashing → Anthropic metadata → executeTool re-check → legal-hold enforcement.
