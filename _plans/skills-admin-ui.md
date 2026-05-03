# Skills Admin UI

## Context

Add a Skills section to `/settings` that lets admins list, view, create, edit, and delete skills entirely through the UI. The HTTP API already exists (`web/app/api/skills/route.ts`, `web/app/api/skills/[id]/route.ts`) with admin-only mutation gates; this work is mostly frontend wiring on top of it. Two small backend additions ride along: server-side injection-scan on skill content at write time (closes an open Security-Medium audit finding) and a structured `skill_modified` audit event so admin writes leave a trail comparable to other destructive actions. Last-write-wins on concurrent admin edits is accepted for v1 — the existing `upsertSkillInCosmos` does not use ETag/IfMatch and a small admin population doesn't justify adding it now; track as a follow-up.

---

## Key Design Decisions

- **Slot the new tab into the existing admin-only tab list** in `web/components/SettingsPage/SettingsPage.tsx:31-33`. Position: between "Organization" and "Usage Limits" — admins managing model-side prompts (org context + skills) are the same users.
- **Freeform markdown textarea + live parser preview**, not a guided structured form. Matches the file-on-disk format admins already use for skill PRs and the migration script. Parser preview catches the validation traps before submission so admins don't hit a server 400 with no warning.
- **Extract the skill parser + validators into a browser-safe module** at `web/lib/skill-parser.ts`. The current `web/lib/skill-store.ts` imports `fs`, `path`, and the Cosmos store — none of which can ship to the browser. The parser, the validators, and the static `TOOL_NAMES` / `DESTRUCTIVE_TOOLS` sets are pure data + pure functions and can be bundled. `skill-store.ts` re-exports them so existing callers (route handlers, migration script) keep working unchanged.
- **Reuse the existing `MarkdownRenderer` component** (`web/components/MarkdownRenderer/MarkdownRenderer.tsx`) for the skill detail view — already has `rehype-sanitize` and matches the chat surface's rendering rules.
- **Reuse the existing Toast pattern** (`web/context/ToastContext`, `useToast`) for success / error notifications — same as `ApiKeysSection`.
- **Reuse the `ApiKeysSection` UX patterns** for inline confirmation, row-level actions, and modal focus management. Specifically the type-the-id-to-confirm pattern is established by the API-key revoke modal.
- **Structured audit event `skill_modified`**, operational topic only (not analytics) per the spec's open-question answer. Metadata: `skillId`, `action` (`create` | `update` | `delete`), `ownerIdHash`. No raw skill content in the log.
- **Server-side injection scan on POST + PUT** uses the existing `scanUserInput` helper (`web/lib/injection-guard.ts:149`). Posture matches the rest of the codebase: scan in monitor mode (log + flag, do not block) so a skill that legitimately discusses prompt-injection refusal patterns isn't rejected as adversarial. Block only if the project-wide `INJECTION_GUARD_MODE=block` is set AND the match count exceeds the existing block threshold.
- **15-second cache propagation hint** as a static toast / inline notice after every mutation, not a polling refresh — the existing 15s read-through cache (`web/lib/skill-store.ts:51`) means the new state is visible to all instances within one window. The hint is informational, not actionable.
- **No new `/api/tools/names` endpoint**; bundle the static tool-name list into the client via the new browser-safe parser module. Tool list changes ship with the deploy anyway.
- **Concurrent-edit conflict handling deferred.** `upsertSkillInCosmos` (`web/lib/skill-store-cosmos.ts:111`) is a plain Cosmos `upsert` with no IfMatch. Last-write-wins. Track as a follow-up; flag in the spec's "Possible Edge Cases" as known.
- **Tab visibility is UI affordance only.** The server-side `admin`-role check on the mutation routes is the authoritative gate. A reader/triage user crafting a direct API call still gets 403 from the existing route guards.
- **No new "test this skill" button, no version history, no bulk import.** All deferred.

---

## Files to Change

| File | Change |
|------|--------|
| `web/lib/skill-parser.ts` | **NEW.** Browser-safe extraction of `parseSkillMarkdown`, `validateSkillId`, `validateSkillContent`, `validateSkill`, plus the `TOOL_NAMES` / `DESTRUCTIVE_TOOLS` sets. Pure functions, no Node imports. |
| `web/lib/skill-store.ts` | Re-export the parser + validators from `./skill-parser` so all current callers (route handlers, migration script, agent loop) keep importing from the same place. Internal helpers (`extractSection`, `extractName`, regex constants, byte cap) move with the parser. |
| `web/lib/types.ts` | Add `"skill_modified"` to the `LogEventType` union (`:155-171`). |
| `web/lib/logger.ts` | Add `"skillId"` and `"action"` to `SAFE_METADATA_FIELDS` if not already present (`action` already added in the legal-hold branch; verify and skip if so). Do NOT add `skill_modified` to `ANALYTICS_EVENT_TYPES` — operational topic only per the spec. |
| `web/app/api/skills/route.ts` | (a) `POST`: run `scanUserInput(body.content, { sessionId: "skill-write", userId: identity.ownerId, role: identity.role })` before persisting; log warnings on flag, only block if guard mode is `"block"` and matches ≥ block-threshold. (b) Emit `logger.emitEvent("skill_modified", "Skill created", "api/skills", { skillId, action: "create", ownerIdHash: hashPii(identity.ownerId) })` on success. |
| `web/app/api/skills/[id]/route.ts` | Same scan + emit on `PUT` (`action: "update"`) and `DELETE` (`action: "delete"`). DELETE doesn't have a body to scan; only emit. |
| `web/components/SettingsPage/SettingsPage.tsx` | Add `'skills'` to the `Tab` type union (line 14) and a `{ value: 'skills', label: 'Skills' }` entry into the admin tab list (line 31–33), positioned after `'org-context'`. Render `<SkillsSection />` when `activeTab === 'skills'`. |
| `web/components/SettingsPage/SkillsSection.tsx` | **NEW.** Top-level admin UI: list of skills, "New skill" button, opens the editor or detail view. Manages selected-skill state, fetch/refetch list, toast emission. Mirrors the structure and styling of `ApiKeysSection`. |
| `web/components/SettingsPage/SkillsSection.module.css` | **NEW.** CSS module per the project's `@reference "../../app/globals.css"` rule. Cards / table layout matching `SettingsPage.module.css` patterns. |
| `web/components/SettingsPage/SkillEditor.tsx` | **NEW.** Two-column layout: markdown textarea on the left, live parsed-skill preview on the right (name, description, required tools with unknown-tool flagging, required role, parameters, character count). Submits to `POST /api/skills` (create) or `PUT /api/skills/[id]` (edit). Surfaces server errors inline next to the offending field. Stack vertically below 960 px. |
| `web/components/SettingsPage/SkillEditor.module.css` | **NEW.** |
| `web/components/SettingsPage/SkillDeleteConfirmModal.tsx` | **NEW.** Type-the-id-to-confirm modal. Focus trap, ESC to dismiss, focus return on close. Calls `DELETE /api/skills/[id]`. |
| `web/components/SettingsPage/SkillDetailView.tsx` | **NEW.** Read-only view for an existing skill: metadata fields up top, skill markdown rendered via the existing `MarkdownRenderer`. Edit and Delete buttons up top. |
| `web/components/SettingsPage/index.ts` | Add the four new component barrel exports (`SkillsSection`, `SkillEditor`, `SkillDeleteConfirmModal`, `SkillDetailView`). |
| `web/test/skills-section.test.tsx` | **NEW.** Component tests with `@testing-library/react`: tab visibility by role, list rendering, create form validation, parser preview correctness, delete confirmation flow. |
| `web/test/skills-route-mutations.test.ts` | **NEW.** Route-handler tests for `POST /api/skills` and `PUT/DELETE /api/skills/[id]`: admin-role gate, ID/content validators, injection-scan logging, `skill_modified` emit shape, audit metadata cleanliness (no raw UPN). |

---

## Implementation Steps

### 1. Extract the parser + validators into a browser-safe module

- Create `web/lib/skill-parser.ts`. Move the following from `web/lib/skill-store.ts` (currently lines 40–192 of the latter):
  - `VALID_ID`, `MAX_ID_LENGTH`, `MAX_CONTENT_BYTES`, `TOOL_NAMES` constants.
  - `extractSection`, `extractName`, `parseSkillMarkdown`.
  - `validateSkill`, `validateSkillId`, `validateSkillContent`.
- The new module must NOT import `fs`, `path`, or the Cosmos store. It does import `TOOLS` and `DESTRUCTIVE_TOOLS` from `./tools` — those are pure data and already browser-safe.
- The new module imports `logger` for the existing `logger.warn` calls inside `validateSkill`. That's still server-only; the React preview must NOT call `validateSkill` (which logs) — the preview should run a parallel "pure" check that returns the same boolean + a structured failure reason. Add a sibling `inspectSkill(skill: Skill): { ok: boolean; issues: string[] }` that returns issues without logging — used by the client.
- Re-export every moved symbol from `web/lib/skill-store.ts` so route handlers, the migration script, and the agent loop (`web/lib/agent.ts:200` via `getSystemPrompt`) keep their existing imports untouched.

### 2. Add the `skill_modified` event type

- In `web/lib/types.ts`, append `"skill_modified"` to the `LogEventType` union.
- In `web/lib/logger.ts`, leave `ANALYTICS_EVENT_TYPES` untouched (operational topic only).
- Verify `"skillId"` and `"action"` are on `SAFE_METADATA_FIELDS`. `"action"` was added in the legal-hold branch; `"skillId"` is currently absent — add it.

### 3. Add the injection scan + audit emit to the skill mutation routes

- `web/app/api/skills/route.ts`:
  - In `POST`, after the `getSkill(body.id)` collision check passes, before `createSkill`, call `scanUserInput(body.content, { sessionId: "skill-write", userId: identity.ownerId, role: identity.role })`. The function logs and returns a `ScanResult`. If `result.flagged && shouldBlock(result)` (the existing helpers in `injection-guard.ts`), return 400 with a clear error. Otherwise proceed.
  - On the successful return, before the `NextResponse.json`, emit `logger.emitEvent("skill_modified", "Skill created", "api/skills", { skillId: skill.id, action: "create", ownerIdHash: hashPii(identity.ownerId) })`.
- `web/app/api/skills/[id]/route.ts`:
  - In `PUT`, mirror the scan + emit (`action: "update"`).
  - In `DELETE`, no body so no scan; emit `logger.emitEvent("skill_modified", "Skill deleted", "api/skills", { skillId: id, action: "delete", ownerIdHash: hashPii(identity.ownerId) })` on success.
- Replace the existing `console.error` calls at the bottom of each handler with `logger.error("Skill mutation failed", "api/skills", { skillId, action, errorMessage: err instanceof Error ? err.message : String(err) })`. (CLAUDE.md prefers `logger` over raw console; the new ESLint rule scoped to `app/components` forbids `console.log`. The existing `console.error` in routes won't trip it but is inconsistent.)

### 4. Wire the new tab into the SettingsPage

- In `web/components/SettingsPage/SettingsPage.tsx`:
  - Extend the `Tab` type to include `'skills'`.
  - In the admin-only tab spread, add `{ value: 'skills' as Tab, label: 'Skills' }` between `'org-context'` and `'admin-usage'`.
  - In the `<main>` panel switch, add `{activeTab === 'skills' && <SkillsSection />}`.
- The role check is already done at the page level via `userRole`, so no extra guard needed at the panel.

### 5. Build the SkillsSection container

- New file `web/components/SettingsPage/SkillsSection.tsx`. Pattern after `ApiKeysSection`:
  - State: `skills: SkillMeta[]`, `loading`, `view: 'list' | 'create' | 'detail' | 'edit'`, `selectedId: string | null`.
  - Fetch list on mount via `GET /api/skills`. The existing endpoint returns role-filtered metadata; for an admin caller this is every skill.
  - List row: id, name, description (truncated), `requiredRole`, `requiredTools.length`, `parameters.length`. Buttons: View, Edit, Delete.
  - Empty state: "No skills yet — click 'New skill' to add one."
  - "New skill" button switches to `view: 'create'`.
  - Toast on every successful mutation; refetch list on return.
  - Render `<SkillEditor>` for create + edit, `<SkillDetailView>` for view, `<SkillDeleteConfirmModal>` for delete.

### 6. Build the SkillEditor

- New file `web/components/SettingsPage/SkillEditor.tsx`. Two-column layout (stack vertically below 960 px via CSS Module).
  - **Left column:**
    - `id` text input (only shown in create mode; read-only in edit mode), with inline validation against `validateSkillId`.
    - `content` textarea, monospace, 30+ rows, with character/byte counter (against `MAX_CONTENT_BYTES = 32000`).
    - Save button (disabled while submitting or while `id`/`content` are invalid).
    - Cancel button (returns to list).
  - **Right column (live preview):**
    - Run the imported `parseSkillMarkdown` + `inspectSkill` on the current `content` value (debounced ~150 ms).
    - Display: parsed `name`, `description`, `requiredRole`, `requiredTools` (each with a green check or red ✗ depending on whether it's in `TOOL_NAMES`), `parameters`.
    - Display any `inspectSkill` issues as a warning list ("Required Tool 'foo_bar' is not registered", "Skill uses destructive tool but role is 'reader'", etc.).
  - Submit calls `POST /api/skills` (create) or `PUT /api/skills/[id]` (edit). On non-2xx response, parse the error JSON; surface it inline near the most relevant field if possible (id error → near id input; content error → above the textarea).
  - On success, show success toast, call the section's refetch + navigate-back callback.
- Form is uncontrolled markdown — no client-side rewriting, no auto-format. The admin controls every byte saved.

### 7. Build the SkillDetailView

- New file `web/components/SettingsPage/SkillDetailView.tsx`.
- Fetch via `GET /api/skills/[id]`.
- Header row: `id`, `name`, `requiredRole` badge, "Edit" + "Delete" buttons.
- Metadata table: `requiredTools` (with destructive-tool warning badge if any), `parameters`.
- Body: render `rawMarkdown` via `<MarkdownRenderer content={content} />`. The `GET /api/skills/[id]` route currently returns `{ skill }` — confirm it includes the raw markdown and add a `content` field if it doesn't (cross-check `web/lib/skill-store-cosmos.ts:175 getRawMarkdownFromCosmos` — already exists; if the route doesn't surface it, extend it to do so).

### 8. Build the SkillDeleteConfirmModal

- New file `web/components/SettingsPage/SkillDeleteConfirmModal.tsx`. Mirror the API-key revoke modal from `ApiKeysSection`:
  - `role="dialog"`, `aria-modal="true"`, `aria-labelledby` pointing at the title.
  - Focus trap on open, focus return to the trigger button on close.
  - ESC dismisses; click outside dismisses.
  - "Type the skill id to confirm" input — Delete button disabled until the typed text exactly matches the skill's id.
  - On confirm, call `DELETE /api/skills/[id]`. On success, toast + close + parent refetches.

### 9. Wire up the barrel export

- `web/components/SettingsPage/index.ts`: add four new exports for the new components.

### 10. Component tests

- New file `web/test/skills-section.test.tsx`:
  - Render `<SkillsSection />` with `userRole="admin"` and assert it issues `GET /api/skills`.
  - Render `<SettingsPage>` with `userRole="reader"` and assert no "Skills" tab exists.
  - Editor: type valid markdown, assert the parser preview shows the parsed name + tools + role.
  - Editor: type markdown that references an unknown tool, assert the unknown-tool red ✗ badge appears.
  - Editor: type a destructive-tool list with `requiredRole: reader`, assert the inline warning surfaces.
  - Editor: submit with an invalid id (uppercase letters), assert the inline `validateSkillId` error appears WITHOUT calling `POST /api/skills`.
  - Delete modal: confirm button is disabled until the typed id matches; on click, calls `DELETE /api/skills/[id]` once.
  - Mock `useToast` to verify success/error toast emission.

### 11. Route-handler tests

- New file `web/test/skills-route-mutations.test.ts`. Vitest, mirror the api-keys-logging test's style (`vi.hoisted` mocks, `vi.importActual` where needed).
- Mock `../lib/skill-store` so the test controls return values without hitting Cosmos.
- Mock `../lib/injection-guard` so the test can simulate `flagged: true` and `flagged: false` paths.
- Mock `../lib/auth-helpers` to inject `admin` / `reader` identities.
- Cover:
  - Reader role gets 403 on `POST /api/skills`, `PUT /api/skills/[id]`, `DELETE /api/skills/[id]`.
  - Admin POST with valid input emits exactly one `logger.emitEvent` with `eventType: "skill_modified"`, `action: "create"`, `skillId: <id>`, `ownerIdHash` matching `hashPii(ownerId)`. Metadata stringified does NOT contain the actor's UPN.
  - Admin POST with content that trips the injection scanner in `monitor` mode logs a warning and proceeds. In `block` mode (mocked guard mode) returns 400.
  - Admin PUT same: emit, action: "update".
  - Admin DELETE same: emit, action: "delete".
  - `validateSkillId` rejection still surfaces 400 before any side effect.
  - `validateSkillContent` rejection still surfaces 400.

### 12. Verify

- Run the full check matrix:
  - `cd web && npm run typecheck` — clean.
  - `cd web && npm run test` — all existing 490 cases plus the new ones pass.
  - `cd web && npm run lint` — clean (one pre-existing exhaustive-deps warning is fine).
  - `cd web && npm run build` — clean Next build.
- Manual smoke (dev mode, file-mode skill store):
  - Log in as the `dev-operator` admin.
  - Navigate to `/settings`, click "Skills".
  - Create a new skill with one of the existing files (e.g. `tor-login-investigation`) as the seed.
  - Verify the parser preview matches the existing in-Cosmos value.
  - Edit the skill, change the description, save, refresh — verify the change.
  - Delete the skill, confirm it's gone from the list and from disk.
  - Switch role to `reader` (via DEV_AUTH_BYPASS or a separate dev session) — verify the Skills tab is not visible and direct `curl` to the mutation routes returns 403.

---

## Verification

1. **Typecheck clean:** `cd web && npx tsc --noEmit` exits 0 with no new errors.
2. **All tests pass:** `cd web && npx vitest run` reports `490+ passed` (existing + new). The two new test files specifically must show their cases passing — note count in the run summary.
3. **Lint clean:** `cd web && npm run lint` exits 0 (pre-existing exhaustive-deps warning is the only allowed item).
4. **Production build:** `cd web && npm run build` exits 0; the Skills route doesn't introduce a new entry that doubles bundle size egregiously (sanity check).
5. **Tab visibility, manual:**
   - Admin session: Skills tab visible.
   - Reader session: Skills tab not visible.
   - Triage session: Skills tab not visible.
6. **Permission gate, automated:** the new `skills-route-mutations.test.ts` pins the 403 returns for non-admin roles.
7. **Audit trail, manual:**
   - Create a skill in dev mode.
   - Inspect the dev console — exactly one `skill_modified` log entry with `action: "create"`, `skillId: <id>`, `ownerIdHash` (16 hex chars), no UPN.
   - Edit + delete: same shape with `action: "update"` and `"delete"`.
8. **Injection scan, manual:**
   - Submit a skill whose content includes a known scanner pattern (e.g. "ignore previous instructions"). Verify the dev console emits the `injection-guard` warn entry. In default `monitor` mode the skill still saves.
9. **Cache propagation hint, manual:** after every successful create / update / delete, verify the "Changes propagating across instances; may take up to 15 seconds" notice renders briefly.
10. **Concurrent-edit behavior, manual:** open the same skill in two browser tabs, save with different content from each. Last-write-wins is acceptable for v1; document the expectation in the section's empty-state hint or near the Save button.
11. **A11y, manual:** keyboard-navigate the entire flow (Tab into Skills, into the list, open Edit, traverse fields, into the Delete modal, ESC). Visible `:focus-visible` on every interactive element. Live-region toast emits via `aria-live="polite"`.
12. **No regression on the AI Search executor tests, the legal-hold tests, the role re-check tests, or any existing component tests.**
