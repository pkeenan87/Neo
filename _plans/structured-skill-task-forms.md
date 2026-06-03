# Structured Skill And Scheduled Task Forms

## Context

Today admins author Skills in `SkillEditor.tsx` via a raw Markdown textarea pre-filled
from `DEFAULT_TEMPLATE`, and they create Scheduled Tasks in `ScheduledTasksSection.tsx`
by pasting raw JSON that the client `JSON.parse`s before POSTing. Both flows are
unfriendly to non-engineers, easy to break (one stray brace and the parse fails), and
they bypass per-field validation messaging. This plan replaces both textareas with
structured forms that build the same wire payloads under the hood, so the API
contracts and storage shapes stay untouched. The work is split into three independently
shippable phases (Skills → Scheduled Tasks → shared `KeyValueList` extraction) so each
can land, ship, and be reverted on its own.

---

## Key Design Decisions

- **No API contract change.** The skill editor will serialize its fields back to the
  canonical Markdown shape on the client and POST/PUT the same `{ id, content }` body
  the routes already accept. This keeps the server-side prompt-injection scan
  (`scanUserInput` in `web/app/api/skills/route.ts` and `[id]/route.ts`),
  `validateSkillContent`, and Cosmos storage path untouched, and means zero risk to
  the wire format. The scheduled-task form builds the existing
  `CreateScheduledTaskInput` / `UpdateScheduledTaskInput` JSON object directly — no
  text-to-JSON conversion at all.
- **Round-trip via parsed fields, not via Markdown.** For edit mode, the skill form
  hydrates directly from the parsed `Skill` object returned by
  `GET /api/skills/[id]` (which is what the endpoint already returns). The form
  never holds the raw Markdown; it serializes on submit. This sidesteps a
  parser-↔-serializer fidelity contract for the in-memory representation, but the
  unit tests must still pin down parser→serializer→parser round-trip equivalence so
  externally authored skills (migration script, hand-edited Cosmos rows) survive an
  edit-and-resave.
- **Steps section stays free-form.** The `## Steps` section currently supports
  multi-step prose with `### N. Step Name` subheadings. Imposing a per-step
  structured editor would lose that flexibility, so Steps remain a single textarea
  in the structured form.
- **Tools come from a single catalog.** The "Required Tools" multiselect (Skill) and
  the "Allowed Tools" multiselect (Scheduled Task) both read from `TOOLS` in
  `web/lib/tools.ts`. The set `TOOL_NAMES` already exported from `skill-parser.ts`
  is the source of truth for valid names.
- **Reuse server validators on the client.** `web/lib/scheduled-task-validators.ts`
  exports `validateTaskName`, `validateScheduleShape`, `validateTaskShape`,
  `validateRoutingShape`, `validateAuthShape`, `validateCircuitBreakerThreshold`.
  The form imports and calls these before submit so the rules can't drift between
  client and server. The validators are already pure functions over `unknown`.
- **Keep a JSON escape hatch for Scheduled Tasks.** Power users may want to paste
  full JSON for edge configurations (uncommon routing destinations, future fields).
  A toggle on the task editor switches between the structured form and a JSON view
  that round-trips the in-memory object via `JSON.stringify` / `JSON.parse` without
  losing user input.
- **Routing toolName options come from `ROUTING_ALLOWED_TOOLS`.** Today this is
  `{ send_teams_message, send_email }`. When `routing.destination === "tool"` the
  toolName select is enabled and limited to that set. For other destinations the
  toolName control is disabled/hidden. This matches `validateRoutingShape` exactly.
- **Phased rollout for revert safety.** Phase 1 (Skills) and Phase 2 (Scheduled
  Tasks) are wired independently — each can be reverted by reverting its phase's
  PR. Phase 3 extracts a shared `KeyValueList` only after both forms have a working
  inline implementation, so the extraction is a pure refactor and the visual
  behavior is already validated.

---

## Files to Change

| File | Change |
|------|--------|
| `web/lib/skill-parser.ts` | Add `serializeSkillMarkdown(skill: Skill): string` that produces the canonical Markdown layout the parser expects (`# Skill: <name>`, `## Description`, `## Required Tools`, `## Required Role`, `## Parameters`, `## Steps`). Preserve list-item formatting (`- tool_name`) and trailing newline. Keep the file browser-safe — no Node imports. |
| `web/lib/skill-parser.ts` | Export `DEFAULT_SKILL` constant (a `Skill` object holding the same defaults as the current `DEFAULT_TEMPLATE` markdown) so the form has a typed starting state and the migration script / tests share one source of truth. |
| `web/components/SettingsPage/SkillEditor.tsx` | Replace the markdown `<textarea>` and `reconstructMarkdownFromSkill` helper with discrete inputs: text `Name`; textarea `Description`; tool multiselect `Required Tools` (options from `TOOLS`); select `Required Role` (`reader` | `admin`); dynamic list `Parameters` (string entries); textarea `Steps` (free-form Markdown sub-tree). Hydrate from `data.skill` in edit mode. On submit, call new `serializeSkillMarkdown` then POST/PUT `{ id, content }` as today. Keep the byte-counter UI; compute against the serialized output. Keep live `validateSkillId` and `validateSkillContent` calls. |
| `web/components/SettingsPage/SkillsSection.module.css` | Add styles for the new form controls (multiselect chips, parameter rows, role select). All new classes use `@apply` against design tokens; file already has `@reference` directive at top. |
| `web/components/SettingsPage/ScheduledTaskEditor.tsx` *(new)* | New client component holding the structured task form. Renders fields grouped by section (Identity, Schedule, Task, Routing, Advanced/Auth). Props: `{ mode: 'create' } | { mode: 'edit', task: ScheduledTask }` plus `onCancel` / `onSaved`. Returns the structured payload via `onSaved`; the parent owns the network call. Includes the JSON-view toggle. |
| `web/components/SettingsPage/ScheduledTaskEditor.module.css` *(new)* | CSS module for the editor. Starts with `@reference "../../app/globals.css"`. Uses `surface-raised`, `border-default`, brand and accent tokens. |
| `web/components/SettingsPage/ScheduledTasksSection.tsx` | Replace inline `createJson` textarea and the `JSON.parse(createJson)` block with `<ScheduledTaskEditor mode="create" />`. Keep the local `DEFAULT_NEW_TASK` constant but convert it from a JSON string to a typed `CreateScheduledTaskInput` object that the new editor consumes. Drop the `createError` state path that catches `JSON.parse` failures; surface validator errors from the editor instead. |
| `web/components/SettingsPage/ScheduledTasksSection.module.css` | Remove the `.jsonField` style once it's no longer referenced (kept only if the JSON-view toggle ends up reusing it). |
| `web/components/KeyValueList/KeyValueList.tsx` *(new, Phase 3)* | Generic typed component for editing `{ key: string; value: string }[]` rows. Used by Scheduled Task `variables` and could be reused by Skill `parameters` if those expand beyond bare strings. Props: `{ entries, onChange, keyLabel?, valueLabel?, addLabel? }`. |
| `web/components/KeyValueList/KeyValueList.module.css` *(new, Phase 3)* | CSS module with `@reference` at top. |
| `web/components/KeyValueList/index.ts` *(new, Phase 3)* | Barrel export. |
| `web/components/index.ts` | Add `export * from './KeyValueList'` (Phase 3). |
| `web/test/skill-parser-serialize.test.ts` *(new)* | Round-trip tests: parse → serialize → parse must produce an equal `Skill` object. Cases: the new `DEFAULT_SKILL`; a multi-step Steps section with `### N.` subheadings; an admin-role skill; a skill with zero parameters and zero required tools. |
| `web/test/skill-editor-form.test.ts` *(new)* | Component tests for the new SkillEditor form: required-field validation, byte-counter updates as fields change, role select switches between reader/admin, tool multiselect adds/removes from `requiredTools`, save calls fetch with the serialized markdown. |
| `web/test/scheduled-task-editor.test.tsx` *(new)* | Component tests for ScheduledTaskEditor: required-field validation via the existing `validateTaskName`/`validateScheduleShape`/etc., routing-destination switch shows/hides `toolName`, `KeyValueList` integration for variables, JSON-view toggle preserves state when switching back, submit posts the structured payload. |
| `web/test/skills-section.test.tsx` | Update existing tests to drive the form fields instead of the markdown textarea. Same coverage scope. |
| `web/test/skills-route-mutations.test.ts` | No behavior change expected, but re-run to confirm the wire shape is unchanged. Add one explicit test that POSTs serialized output and reads it back via `parseSkillMarkdown` to lock in the contract. |

---

## Implementation Steps

### 1. Add `serializeSkillMarkdown` + round-trip tests (Phase 1, foundation)

- Add `serializeSkillMarkdown(skill: Skill): string` to `web/lib/skill-parser.ts`.
  Produce sections in the same order `parseSkillMarkdown` reads:
  `# Skill: <name>`, blank line, `## Description`, blank line, body, blank line,
  `## Required Tools`, list of `- tool_name` lines (or `- (none)` placeholder
  rejected — render an empty section when empty), `## Required Role`, role on its
  own line, `## Parameters`, list (same empty handling), `## Steps`, body verbatim.
  End the document with a single trailing newline.
- Add `DEFAULT_SKILL: Skill` constant with the same fields as today's
  `DEFAULT_TEMPLATE`.
- Create `web/test/skill-parser-serialize.test.ts` and write the round-trip cases
  listed in the file table. Each test parses, serializes, parses again, and
  deep-equals the two parsed objects.
- Run `cd web && npm run test -- skill-parser` and confirm green.

### 2. Rewrite `SkillEditor.tsx` to drive structured fields (Phase 1)

- Remove the `content`-as-markdown state and `reconstructMarkdownFromSkill` helper.
  Introduce per-field state: `name`, `description`, `requiredTools`,
  `requiredRole`, `parameters`, `instructions` (free-form Markdown for Steps).
- In create mode, seed state from `DEFAULT_SKILL`.
- In edit mode, fetch `GET /api/skills/[id]`, read `data.skill` (already the parsed
  `Skill` shape), and populate the state. Drop the `rawMarkdown` fallback path.
- Render the form: ID input (unchanged), Name input, Description textarea, Required
  Tools multiselect (sourced from `TOOLS`, chip-style add/remove), Required Role
  select (`reader` | `admin`), Parameters dynamic list (text inputs with add/remove
  buttons), Steps textarea (multiline, monospace).
- Recompute `byteLength = skillContentByteLength(serializeSkillMarkdown(state))`
  via `useMemo`; reuse the existing over/near-cap UI.
- On submit: build a `Skill` from state, call `serializeSkillMarkdown`, then POST
  `{ id, content }` or PUT `{ content }` exactly as today.
- Confirm `aria-required`, `aria-invalid`, `aria-describedby` are set on all
  required fields. Error messages live under each field with `role="alert"` (the
  ID error already does this — match the pattern).
- Run `cd web && npm run typecheck && npm run lint && npm run test -- skill`.

### 3. Wire the form into `SkillsSection.tsx` and update fixtures (Phase 1)

- `SkillsSection.tsx` should not need to change — it renders `<SkillEditor />`
  with `mode` and callbacks. Verify the component still mounts cleanly.
- Update `web/test/skills-section.test.tsx` to drive the new form fields instead
  of typing into a single textarea. Keep the same assertions on the final POST
  body (still `{ id, content }`).
- Manually verify in `npm run dev`: create a new skill, edit an existing skill,
  observe the saved Markdown in Cosmos (via the skill-store admin tool or
  `gh api`) matches the canonical layout.

### 4. Build `ScheduledTaskEditor.tsx` (Phase 2)

- Create `web/components/SettingsPage/ScheduledTaskEditor.tsx` with props
  `{ mode: 'create' } | { mode: 'edit'; task: ScheduledTask; expectedEtag: string }`
  plus `onCancel`, `onSaved`. Internal state mirrors `CreateScheduledTaskInput`.
- Group fields:
  - **Identity:** `name` (text, required, max 200 per `TASK_NAME_MAX`),
    `description` (textarea), `enabled` (checkbox), `dryRun` (checkbox),
    `circuitBreakerThreshold` (number, default per `DEFAULT_CIRCUIT_BREAKER_THRESHOLD`).
  - **Schedule:** `cronExpression` (text with placeholder `0 8 * * 1`),
    `timezone` (text with autocomplete-style placeholder `America/New_York`).
  - **Task:** `promptTemplate` (textarea, supports `{{var}}` interpolation,
    surface a small hint), `variables` (inline `KeyValueList`-style rows, but
    implement inline first; Phase 3 extracts the shared component),
    `allowedTools` (multiselect from `TOOLS`),
    `maxDurationSeconds` (number, max per `MAX_DURATION_SECONDS_CAP`).
  - **Routing:** `destination` (select: `teams-channel`, `cosmos-log`, `email`,
    `tool`), conditional `toolName` select limited to `ROUTING_ALLOWED_TOOLS`
    when destination is `tool`, conditional `teamsTeamId`/`teamsChannelId`
    when `teams-channel`, conditional `emailTo` when `email`,
    `fallbackDestination` (same enum, optional).
  - **Auth (collapsible, advanced):** `scopedPermissions` (string list),
    `keyVaultSecretRefs` (string list). Default collapsed in create mode.
- Provide a JSON-view toggle button. When toggled on, render a `<textarea>` with
  `JSON.stringify(state, null, 2)`. On toggle back, `JSON.parse` and merge into
  state (surface any parse error inline). Persist edits made in JSON view when
  the user toggles back to form view; persist form edits when toggling to JSON.
- Before submit, call each relevant validator from
  `web/lib/scheduled-task-validators.ts` (`validateTaskName`,
  `validateScheduleShape`, `validateTaskShape`, `validateRoutingShape`,
  `validateAuthShape`, `validateCircuitBreakerThreshold`) and surface any
  non-null string as the relevant field's error.
- Style with `ScheduledTaskEditor.module.css` (with `@reference`), tokens only,
  3-class inline rule enforced.

### 5. Integrate the editor into `ScheduledTasksSection.tsx` (Phase 2)

- Replace the `createJson` state and the `<textarea>` in the create modal with
  `<ScheduledTaskEditor mode="create" onCancel={...} onSaved={...} />`.
- Move the POST call inside `onSaved` (parent owns the network call; editor
  hands back a `CreateScheduledTaskInput`). Or have the editor own the
  POST/PUT itself — pick one consistent with `SkillEditor` (which owns its
  fetch). Recommended: editor owns the fetch, parent only reacts via
  `onSaved`.
- Convert `DEFAULT_NEW_TASK` from a stringified JSON to a typed
  `CreateScheduledTaskInput` so the editor can hydrate from it.
- Remove the `createError` `JSON.parse`-handling branch and the related
  user-facing string ("Invalid JSON: …").
- Optional but recommended: add an "Edit task" entry point (button next to each
  task row) that opens `<ScheduledTaskEditor mode="edit" task={...}
  expectedEtag={task._etag} />` and PATCHes the task. **See Open Question 1**
  before committing to this — confirm with the user first.
- Update `web/test/scheduled-task-editor.test.tsx` with the cases listed in the
  file table.

### 6. Extract `KeyValueList` (Phase 3, refactor)

- Create `web/components/KeyValueList/` with `KeyValueList.tsx`, `.module.css`,
  and `index.ts`. Props: `entries: Array<{ key: string; value: string }>`,
  `onChange(entries)`, `keyLabel?`, `valueLabel?`, `addLabel?`, `className?`.
- Replace the inline `variables` editor in `ScheduledTaskEditor` with
  `<KeyValueList />`.
- Add `export * from './KeyValueList'` to `web/components/index.ts`.
- Add a small unit test exercising add/remove/edit behavior.
- Visual regression check: `npm run dev`, open the scheduled-task editor,
  confirm variables still render and submit the same payload.

### 7. Final polish

- Run `/ui-standards-refactor` (or follow `.claude/skills/ui-standards-refactor/`
  manually) on each new component file to enforce the 3-class rule, hover
  tokens, and design-system compliance.
- Confirm no new arbitrary hex values were introduced (`grep -rE '#[0-9a-fA-F]{3,6}'
  web/components/SettingsPage/ScheduledTaskEditor.*` should only match tokens or
  comments).

---

## Verification

1. `cd web && npm run typecheck` — zero errors.
2. `cd web && npm run lint` — zero new errors (the one pre-existing
   `ApiKeysSection.tsx` exhaustive-deps warning is unrelated).
3. `cd web && npm run test` — all 78 test files green, including the new
   `skill-parser-serialize.test.ts`, `skill-editor-form.test.ts`,
   `scheduled-task-editor.test.tsx`. Confirm round-trip suite catches
   intentionally broken serializer output by temporarily corrupting one
   section header and watching the round-trip test fail.
4. Manual: `npm run dev`, sign in as admin, in Settings → Skills:
   (a) create a new skill via the form, save, reload, edit it, verify all
   fields round-trip; (b) edit an existing skill that was authored before this
   change, verify Steps content renders unchanged after a re-save.
5. Manual: Settings → Scheduled Tasks: (a) create a task with two variables and
   two allowed tools, save, verify it appears in the list with the right shape
   (via the existing detail view or `GET /api/scheduled-tasks/<id>`); (b)
   trigger an obvious validation error (empty name, invalid cron) and confirm
   the per-field error message renders.
6. Manual: toggle the JSON view on the scheduled-task editor, change a value
   in JSON, toggle back, confirm the form reflects the change; vice versa.
7. Confirm `npm run dev` console shows no React key warnings from the new
   dynamic lists (`parameters`, `allowedTools`, `variables`).
8. After Phase 3 lands, repeat (5a) — `KeyValueList` should be a transparent
   refactor with no behavioral change.

---

## Open Questions

1. **Scheduled-task edit mode in scope?** The PATCH endpoint at
   `web/app/api/scheduled-tasks/[id]/route.ts` already supports partial updates
   gated on `expectedEtag`. Adding an "Edit task" button is mostly a UI wire-up
   and is the natural payoff of having a structured editor. Confirm before
   building it.
2. **"Raw Markdown" escape hatch on the Skill editor?** Symmetry argument with
   the scheduled-task JSON toggle says yes; "less surface area = fewer bugs"
   says no. The Steps textarea already handles the free-form 90% case.
   Recommendation: ship Phase 1 without it, add later only if requested.
3. **Phase ordering.** Default is Skills → Tasks → KeyValueList extraction.
   If the team wants the bigger win (Tasks) first, the order can flip — the
   only dependency is that `KeyValueList` extraction (Phase 3) must come
   after Phase 2 since that's where the first consumer lives.
4. **Variable typing.** `ScheduledTaskTask.variables` is
   `Record<string, string | number | boolean>`. The simplest form treats every
   value as a string and lets the server coerce, but that loses typed numbers
   for templates like `{{lookbackDays}}` where the agent might compare
   numerically. Decide whether to add a per-row type select (string/number/bool)
   or keep it string-only and document the coercion behavior.
