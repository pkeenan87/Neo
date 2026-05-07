# Admin UI for Alert Triage Mapping

## Context

This plan implements the spec at `_specs/admin-ui-alert-triage-mapping.md`. Today the alert source key (`<product>:<alertType>`) → skill ID lookup lives in a hardcoded constant `TRIAGE_SKILL_MAP` at `web/lib/triage-dispatch.ts:10-12`, which means adding a triage skill requires a code change + PR + deploy. The work moves the lookup into a new Cosmos container with a 15-second read-through cache (mirroring the existing `skill-store` dual-source pattern), exposes it through admin-only CRUD route handlers, surfaces it as a new top-level **Triage Mappings** Settings tab with a "test mapping" preview, and blocks skill deletion while a mapping still references the skill. The existing `DefenderXDR:DefenderEndpoint.SuspiciousProcess → defender-endpoint-triage` entry is seeded into Cosmos so the rollout is non-breaking.

---

## Key Design Decisions

- **Mirror `skill-store.ts` exactly.** The triage-mapping store gets the same dual-source dispatch (`useCosmos()` gate), 15-second read-through cache, atomic `create` (Cosmos 409 → "already exists" Error), idempotent delete, and `__invalidateForTest()` hook. Same shape = same review surface, same operational mental model, same multi-instance propagation guarantee.
- **Cosmos document shape**: `{ id, skillId, updatedAt, updatedBy }`. `id` is the source key itself (`<product>:<alertType>` — case-sensitive, matches wire format). Partition key `/id` to match the existing `skills` container.
- **Mock-mode default = the existing hardcoded entry.** When `useCosmos()` returns false (dev / `MOCK_MODE !== "false"` / no `COSMOS_ENDPOINT`), the store returns an in-memory `Map` seeded with `DefenderXDR:DefenderEndpoint.SuspiciousProcess → defender-endpoint-triage`. Dev workflow stays zero-config; production runs from Cosmos.
- **Seed via a new migration script**, not lazy-on-first-read, to avoid a race during cold start. Reuses the existing `web/scripts/` + `npm run build:migrate` pattern that already produces `web/dist/migrate.mjs`. New script: `seed-triage-mappings.mjs`. Operators run it once after `provision-cosmos-db.ps1` adds the new container.
- **New top-level Settings tab "Triage Mappings"**, not a sub-section of Skills. Matches the user's answer in the spec. Tab gated by `userRole === "admin"` exactly like the Skills tab.
- **Source key is immutable** after create. Edit changes only the mapped `skillId`. Mirrors how skills treat their own id.
- **Block skill deletion** (HTTP 409) while one or more mappings reference it. The existing `DELETE /api/skills/[id]` handler grows a precondition check that queries the mapping store; the SkillDeleteConfirmModal surfaces the conflict response with a list of blocking mapping keys so the operator knows which mappings to reassign first.
- **"Test mapping" preview** lives on the Settings tab and calls a new `POST /api/triage-mappings/test` endpoint that runs `resolveTriageSkill(source)` against the live store and returns `{ skillId, source: "mapped" | "generic" | "none" }`. No side effects.
- **Triage hot-path stays no-fail.** `resolveTriageSkill()` catches errors out of the mapping store, logs a warning via the existing `logger`, and continues to the generic-skill fallback. Mirrors the failure pattern called out in `_specs/alert-triage-api.md` for the dedup cache.
- **Audit logging** reuses the existing `logger.emitEvent("triage_mapping_modified", ...)` shape, parallel to `skill_modified`. No special prompt-injection wiring per the spec's open-question answer.

---

## Files to Change

| File | Change |
|------|--------|
| `web/lib/triage-mapping-store-cosmos.ts` | **New.** Cosmos persistence layer: `listMappings`, `getMapping`, `createMapping`, `updateMapping`, `deleteMapping`, `__setContainerForTest`. Mirrors `skill-store-cosmos.ts`. Handles the Cosmos 409 → "already exists" mapping. |
| `web/lib/triage-mapping-store.ts` | **New.** Public async API + dual-source dispatch + 15s read-through cache. Functions: `getAllMappings`, `getMapping(key)`, `createMapping(key, skillId, identity)`, `updateMapping(key, skillId, identity)`, `deleteMapping(key)`, `getMappingsForSkill(skillId)` (for the deletion guard), `__invalidateCacheForTest`. Mock-mode default seeds the existing Defender entry. |
| `web/lib/triage-dispatch.ts` | Remove the hardcoded `TRIAGE_SKILL_MAP` constant. Rewrite `resolveTriageSkill()` to call `getMapping(key)` from the new store; on store error, log warning and fall through to generic. Keep `GENERIC_SKILL_ID` export. Keep `checkCallerAllowlist` untouched. |
| `web/lib/types.ts` | Add `TriageMapping` interface (id/key, skillId, updatedAt, updatedBy) and `TriageMappingMeta` for list responses. |
| `web/app/api/triage-mappings/route.ts` | **New.** `GET` (list, admin-only), `POST` (create, admin-only). Mirrors `app/api/skills/route.ts` patterns: `resolveAuth` → role check → JSON parse → validate → store call → audit-log emit. |
| `web/app/api/triage-mappings/[key]/route.ts` | **New.** `GET` single, `PUT` (update mapped skill only), `DELETE`. URL-decodes the `[key]` param so `:` round-trips cleanly. |
| `web/app/api/triage-mappings/test/route.ts` | **New.** `POST { product, alertType }` → calls `resolveTriageSkill` and returns `{ skillId, source: "mapped" | "generic" | "none" }`. Admin-only. No side effects. |
| `web/app/api/skills/[id]/route.ts` | `DELETE` handler grows a precondition: call `getMappingsForSkill(id)`; if non-empty, return 409 with `{ error, blockingMappings: [keys] }`. |
| `web/components/SettingsPage/TriageMappingsSection.tsx` | **New.** List + create form + edit + delete + test-preview panel. Built on the same building blocks as `SkillsSection.tsx` (toolbar, cache hint, table layout, ActionButton + saveButton patterns). |
| `web/components/SettingsPage/TriageMappingsSection.module.css` | **New.** Reuses the `SkillsSection.module.css` rules where possible via `composes` or just paralleling the class names. Honour the 1280px wide-content modifier already wired in `SettingsPage.module.css` (Skills tab). |
| `web/components/SettingsPage/SettingsPage.tsx` | Add `'triage-mappings'` to the `Tab` union, render the new section, keep the wide-content modifier extended to this tab. |
| `web/components/SettingsPage/SettingsPage.module.css` | Extend the `.contentWide` selector trigger logic so the new tab also opts in. (No CSS rule change — only the React conditional in SettingsPage.tsx.) |
| `web/components/SettingsPage/SkillDeleteConfirmModal.tsx` | Surface the new 409 response: when the API returns `blockingMappings`, render a list of keys and disable confirm until the operator dismisses. |
| `web/scripts/seed-triage-mappings.ts` | **New.** Seeds the existing Defender entry into the new container if it isn't already present. Idempotent; safe to re-run. Bundled via `npm run build:migrate` into `web/dist/seed-triage-mappings.mjs`. |
| `web/package.json` | Add a `build:seed-triage-mappings` script and wire the new file into the existing `build:migrate` esbuild config. |
| `scripts/provision-cosmos-db.ps1` | Add a new `$TriageMappingsContainerName = "triage-mappings"` parameter and an idempotent `az cosmosdb sql container create` block with `--partition-key-path /id`. |
| `scripts/deploy-azure.ps1` and `scripts/deploy-azure.py` | Stage `dist/seed-triage-mappings.mjs` into the deploy artifact alongside the existing `dist/migrate.mjs`. Operators SSH in and run `node dist/seed-triage-mappings.mjs` once on the App Service. |
| `docs/configuration.md` | Add a "Triage skill mappings" section: where the data lives, how to add/edit/delete via Settings → Triage Mappings, the "test mapping" preview, the seed step, and the deletion-guard behaviour. |
| `web/test/triage-mapping-store.test.ts` | **New.** Unit tests for the store (CRUD, cache TTL, dual-source dispatch, mock-mode default). |
| `web/test/triage-dispatch.test.ts` | Existing. Update to mock the new store instead of the hardcoded constant; add Cosmos-failure-fallback test. |
| `web/test/triage-mappings-route.test.ts` | **New.** Route handler tests: list/create/update/delete + 401/403/409 paths. |
| `web/test/triage-mappings-test-route.test.ts` | **New.** Verifies the preview endpoint returns `{ source: "mapped" }`, `"generic"`, `"none"` correctly. |
| `web/test/skills-section.test.tsx` | Add a case for the deletion-guard 409 path: when DELETE returns blockingMappings, modal shows them and confirm is disabled. |
| `web/test/triage-mappings-section.test.tsx` | **New.** UI tests for the list, create form validation (key shape + non-empty), dropdown population, hot-reload hint after a write, admin-only tab visibility. |

---

## Implementation Steps

### 1. Add the type and the Cosmos persistence layer

- Add `TriageMapping` and `TriageMappingMeta` to `web/lib/types.ts`. Fields: `id` (the `<product>:<alertType>` key), `skillId`, `updatedAt` (ISO string), `updatedBy` (hashed ownerId). The wire DTO `TriageMappingMeta` matches but omits internal-only fields if any are added later.
- Create `web/lib/triage-mapping-store-cosmos.ts`. Database name reused: `neo-db`; container: `triage-mappings`; partition key `/id`. Implement: `listMappings`, `getMappingFromCosmos`, `upsertMappingInCosmos`, `createMappingInCosmos` (with the 409 → `already exists` translation), `deleteMappingFromCosmos` (idempotent on 404), `__setContainerForTest`. Lazy-init the `Container` exactly like `skill-store-cosmos.ts`. All functions guard on `getContainer()` returning null.

### 2. Add the public store with the cache and dual-source dispatch

- Create `web/lib/triage-mapping-store.ts`. Reproduce the cache structure from `skill-store.ts`: `COSMOS_CACHE_TTL_MS = 15_000`, `cosmosCache` object holding a `Map<string, TriageMapping>` plus `loadedAt`, `refreshCosmosCache`, `getCosmosCache`, `invalidateCosmosCache`.
- The mock-mode in-memory default is a `Map` seeded with `DefenderXDR:DefenderEndpoint.SuspiciousProcess → defender-endpoint-triage`, populated lazily on first read.
- Public functions:
  - `getAllMappings(): Promise<TriageMapping[]>` — full list for the admin UI.
  - `getMapping(key): Promise<TriageMapping | undefined>` — single lookup, used by the dispatch hot path.
  - `createMapping(key, skillId, identity)` — validates the key shape, validates that `skillId` resolves via `getSkill(skillId)`, calls `createMappingInCosmos` in Cosmos mode, mutates the in-memory map in mock mode, invalidates the cache, returns the new mapping.
  - `updateMapping(key, skillId, identity)` — same pre-checks; rejects if the mapping doesn't already exist (use a pre-read like `updateSkill` does).
  - `deleteMapping(key)` — idempotent on missing.
  - `getMappingsForSkill(skillId): Promise<TriageMapping[]>` — used by the skill-deletion guard. Backed by the cache for cheap repeated calls.
  - `__invalidateCacheForTest()`.
- Validation helpers (also exported for the route handlers): `validateMappingKey(key)` returns null/error string. Shape: non-empty alphanumeric + dot/underscore on each side of a single `:`, no whitespace, length <= 256. Case-sensitive.

### 3. Rewrite `resolveTriageSkill`

- In `web/lib/triage-dispatch.ts`, delete the hardcoded `TRIAGE_SKILL_MAP` constant and its comment block.
- New body: build the key string, call `getMapping(key)` inside a try/catch. On thrown error or store unavailability, log a `logger.warn` with the key and error message, then fall through to the generic skill. Cache hit returns the mapped skill if `getSkill(mappedId)` resolves; if the mapped skill no longer exists (orphan), log a warning with `{ key, mappedSkillId: mappedId }` and continue to generic.
- Keep `GENERIC_SKILL_ID` and `checkCallerAllowlist` exports unchanged.

### 4. Add the route handlers

- Create `web/app/api/triage-mappings/route.ts`:
  - `GET` — `resolveAuth` → admin check (matches Skills' `getSkillsForRole` gate, but since this is admin-only, return 403 for non-admin) → list and respond `{ mappings: [...] }`.
  - `POST` — admin-only. Body `{ key, skillId }`. Validate key shape, validate `skillId` exists, call `createMapping`. Translate the store's "already exists" error to 409. Emit `triage_mapping_modified` audit event with `{ key, skillId, action: "create", ownerIdHash, role }`. Return `{ mapping }` with status 201.
- Create `web/app/api/triage-mappings/[key]/route.ts`:
  - `GET` — admin-only. URL-decode `params.key`. Returns 404 if missing.
  - `PUT` — admin-only. Body `{ skillId }`. Validate `skillId` exists. Calls `updateMapping`. Emits audit event with action `update`.
  - `DELETE` — admin-only. Calls `deleteMapping`. Emits audit event with action `delete`. Idempotent (200 on missing).
- Create `web/app/api/triage-mappings/test/route.ts`:
  - `POST` — admin-only. Body `{ product, alertType }`. Builds a partial `TriageSource`-shaped object, calls `resolveTriageSkill`. Returns `{ skillId, source: "mapped" | "generic" | "none" }`. Always 200; never throws.

### 5. Wire the skill-deletion guard

- In `web/app/api/skills/[id]/route.ts`, the `DELETE` handler runs before the existing delete: call `getMappingsForSkill(id)` from the new store. If the array is non-empty, return `{ error: "Skill is referenced by triage mappings — reassign or remove them first.", blockingMappings: mappings.map(m => m.id) }` with HTTP 409.
- Emit a structured `logger.warn` so deletion attempts blocked by the guard show in the audit trail.

### 6. Build the Settings UI

- In `web/components/SettingsPage/SettingsPage.tsx`, extend the `Tab` union with `'triage-mappings'`, add it to the admin tab list (placed between `'skills'` and `'admin-usage'`), and add the section render-switch. The wide-content modifier (`styles.contentWide`) gets applied for both `'skills'` and `'triage-mappings'`.
- Create `web/components/SettingsPage/TriageMappingsSection.tsx`. Component layout:
  - Header `<h2>` "Triage Mappings" + descriptive paragraph + `+ New mapping` button.
  - Cache-hint banner using the existing 15s pattern from SkillsSection.
  - Table: columns Source key (mono font), Skill (name + id), Last updated, Actions (Edit, Delete).
  - Inline create form opens above the table when "New mapping" is clicked: text input for the key (with live validation against `validateMappingKey`), a dropdown of skills fetched via `GET /api/skills` (id + name shown).
  - Edit-in-place: clicking Edit on a row reveals the same dropdown for that row, plus Save/Cancel buttons. Key is read-only.
  - Delete uses the existing `SkillDeleteConfirmModal` pattern — copy the file as `MappingDeleteConfirmModal.tsx` or generalize it; the simplest path is a parallel `MappingDeleteConfirmModal` so the skills modal stays focused.
  - Test panel below the table: two text inputs (Product, Alert Type), a Resolve button, and a result line showing `Resolves to: <skill-id>` plus a tag noting `(mapped)`, `(generic fallback)`, or `(no skill)`.
- Module CSS lives in `TriageMappingsSection.module.css`. Where the rules are identical to SkillsSection (table layout, action buttons, role badges, cache hint), copy the rules so the components stay independently editable.

### 7. Skill-delete modal handles the 409

- In `web/components/SettingsPage/SkillDeleteConfirmModal.tsx`, the existing `onDelete` flow currently treats any non-200 as a generic error. Extend the response handler to detect `status === 409 && body.blockingMappings`: render the list of blocking mapping keys (mono font) and a clear instruction to remove or reassign them first in the Triage Mappings tab. Disable the Delete button while this state is active.

### 8. Provisioning + seeding + deploy

- Update `scripts/provision-cosmos-db.ps1`: add `$TriageMappingsContainerName = "triage-mappings"` parameter, follow the existing idempotent pattern (try `az cosmosdb sql container show`, create if missing) with `--partition-key-path /id` and no TTL.
- Create `web/scripts/seed-triage-mappings.ts`. On startup it: builds the Cosmos client via `ManagedIdentityCredential` + `COSMOS_ENDPOINT` (mirroring `skill-store-cosmos.ts`), checks for the `DefenderXDR:DefenderEndpoint.SuspiciousProcess` document, creates it pointing at `defender-endpoint-triage` if absent. Idempotent.
- Add a `build:seed-triage-mappings` script to `web/package.json`. Wire its esbuild output into the same bundling step that produces `web/dist/migrate.mjs`. Final artifact: `web/dist/seed-triage-mappings.mjs`.
- Update both deploy scripts (`scripts/deploy-azure.ps1` and `scripts/deploy-azure.py`) to copy `web/dist/seed-triage-mappings.mjs` into the staging dir alongside `dist/migrate.mjs`.
- `docs/configuration.md`: add a new "Triage skill mappings" subsection covering the admin UI, the seed step (`node dist/seed-triage-mappings.mjs` from the App Service SSH session), the case-sensitivity rule, the deletion guard, and the test-mapping preview.

### 9. Tests

- `web/test/triage-mapping-store.test.ts`: unit-test create/update/delete/get/list/getMappingsForSkill with a fake Cosmos container injected via `__setContainerForTest`. Cover: 409 on create-collision, 404 on update-missing, idempotent delete, cache TTL freshness, mock-mode default contains the Defender entry.
- `web/test/triage-dispatch.test.ts`: refactor existing tests to mock the new store. Add: cache miss returns generic; store throws → returns generic + warning logged; mapped skill orphaned (skillId mapped but `getSkill` returns undefined) → returns generic + warning.
- `web/test/triage-mappings-route.test.ts`: GET/POST/PUT/DELETE happy paths; 401 (no auth), 403 (reader role), 400 (bad key shape, missing skillId, unknown skillId), 409 (duplicate create). Verify audit-log events fire via a logger spy.
- `web/test/triage-mappings-test-route.test.ts`: build sample TriageSource shapes and assert the three outcomes (mapped / generic fallback / none).
- `web/test/skills-section.test.tsx`: add a test that DELETE skill returns 409 with `blockingMappings`, modal shows the keys, confirm is disabled.
- `web/test/triage-mappings-section.test.tsx`: render with admin role; assert tab visibility (visible for admin, hidden for reader), table renders mappings from the mocked GET, create-form key validation surfaces inline errors, skill dropdown populates from `/api/skills`, the test-mapping panel returns the expected `source` tag for known + unknown inputs.

### 10. Configuration + docs polish

- Update CLAUDE.md "Adding a new tool" guidance is unchanged, but add a new section "Adding a new triage mapping" with a one-liner pointing operators at Settings → Triage Mappings.
- Note in `docs/configuration.md` that the case-sensitive `<product>:<alertType>` keys must match the wire format the triage source emits.

---

## Verification

1. `cd web && npm run typecheck` — clean (no `any`, all new exports typed).
2. `cd web && npm run lint` — clean. The pre-existing `ApiKeysSection.tsx` warning is unrelated and may persist.
3. `cd web && npm run test` — all suites pass, including the new triage-mapping tests.
4. `cd web && npm run dev`, then in a browser as an admin: open `/settings`, switch to Triage Mappings, confirm the seeded Defender entry renders, create a new mapping (e.g. `Sentinel:HighSeverity`), edit it, delete it, run the test-mapping preview against both a mapped and an unmapped pair.
5. As a reader role: confirm the Triage Mappings tab is not visible and that direct GET/POST/PUT/DELETE on `/api/triage-mappings` returns 401/403.
6. With `MOCK_MODE=false` and `COSMOS_ENDPOINT` set against a dev Cosmos account: run `node web/dist/seed-triage-mappings.mjs`, confirm the Defender entry appears in the container; rerun the script and confirm it is idempotent.
7. Attempt to delete `defender-endpoint-triage` from the Skills UI while the mapping references it — confirm the 409 surfaces in the modal with the blocking mapping listed and that Delete stays disabled until the mapping is removed first.
8. Fault-injection: temporarily make `getMapping` throw inside `triage-dispatch.ts` — issue a triage request and confirm the endpoint still returns the generic-skill response and writes a warning to the structured log.
9. Cross-instance hot-reload: in a multi-instance environment (or by running two dev servers pointing at the same Cosmos account), create a mapping on instance A, confirm instance B picks it up within ≤15 seconds without a restart.
10. CI: required checks (`All checks passed`, `CodeQL (security-extended)`, `Secret scan (gitleaks)`) all green on the PR before merge.
