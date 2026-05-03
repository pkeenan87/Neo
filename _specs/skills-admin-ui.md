# Spec for skills-admin-ui

branch: claude/feature/skills-admin-ui

## Summary

Add a Skills section to `/settings` that lets admin users list, view, create, update, and delete skills entirely through the UI. The HTTP API already exists (`GET/POST /api/skills`, `GET/PUT/DELETE /api/skills/[id]` — admin-gated for mutations) and is backed by Cosmos with a 15-second read-through cache. Today the only non-CLI workflow for adding a skill is "drop a markdown file in `web/skills/` then run `npm run migrate:skills:prod`" (or `curl` directly at the API). This feature replaces that with a self-service surface.

This is primarily a frontend feature. One small backend addition: closing the audit's Security-Medium gap by injection-scanning skill content at write time, since admin-authored skills currently bypass the same `scanUserInput` pipeline that user messages go through.

## Functional requirements

- Add a new "Skills" tab to the existing `/settings` page, integrated alongside Profile / Appearance / Usage / Org Context / API Keys / Admin Usage. The tab is **visible only to admin role** — reader/triage roles never see it. The visibility is a UI affordance; the server-side `admin`-role check on every mutation route is the authoritative gate.
- **List view**: shows every skill the admin can see, in a sortable table or card grid. Per row: skill id, display name, short description, required role, required-tools count, parameters count, and a last-updated timestamp. Empty state for first-time installs.
- **Detail view**: opens the full skill — metadata fields up top, full markdown content below with syntax-aware rendering. Include inline notice when a skill references a destructive tool (so the admin can confirm intent).
- **Create form**: required fields are `id` (kebab-case, validated against `validateSkillId`) and `content` (the full skill markdown, validated against `validateSkillContent`). Submission posts to `POST /api/skills`; success returns to the list with a confirmation toast.
- **Edit form**: pre-populates from the skill's current content. The `id` is immutable in the UI (it's the partition key in Cosmos). Save posts to `PUT /api/skills/[id]`.
- **Delete**: a confirmation modal that requires the admin to type the skill's `id` to confirm — same pattern as destructive workflows elsewhere in the codebase. Calls `DELETE /api/skills/[id]`.
- **Live validation feedback**: the form must surface server-side errors (`400 Invalid skill id`, `409 Skill already exists`, `400 Skill validation failed: unknown tool`, `400 Destructive tool requires admin role`) as inline messages near the offending field, not just as a toast.
- **Skill-parser preview**: as the admin types the markdown, render a sidebar showing the parsed skill (extracted name, description, required tools, required role, parameters). This catches "structurally invalid markdown" before submission — the parser is forgiving and silently produces empty fields, which the existing validators reject only at the server. The UI should run the same `parseSkillMarkdown` logic client-side via a shared module so previews stay truthful.
- **Audit logging**: every create / update / delete emits an audit event via the existing `logger.emitEvent` pipeline. Capture `skillId`, `action` (`create` | `update` | `delete`), and the actor's hashed owner id. Existing `skillId` should already be on `SAFE_METADATA_FIELDS`; verify, add if missing.
- **Server-side injection scan at write time**: every `POST` and `PUT` runs the skill content through `scanUserInput` (or the established admin-content equivalent) and refuses if the content trips block-mode patterns. Closes the open Security-Medium audit finding "Skill content rendered into the system prompt verbatim and not injection-scanned at admin write time."
- **Cache visibility**: after a successful mutation, the UI refetches the list. The 15-second Cosmos read-through cache may serve stale data from a different App Service instance for up to 15 seconds — the UI should display a small "Changes propagating across instances; may take up to 15 seconds" hint after create/update/delete.
- **Markdown rendering** in the detail view uses the existing project markdown renderer (see chat surface) with `rehype-sanitize`. No raw HTML allowed.
- **Loading / empty / error states** for the list, detail, and forms — matching the patterns established in `ApiKeysSection` and `AdminUsageSection`.
- **Keyboard navigability**: full keyboard reachability for list rows, edit/delete actions, form fields, and the confirm-delete modal. Modal traps focus and returns it on close.

## Figma Design Reference (only if referenced)

Not provided. Match the existing Settings-page visual language: see `web/components/SettingsPage/SettingsPage.module.css` and the existing `ApiKeysSection` / `AdminUsageSection` components for the canonical card / table / form patterns. Use the design tokens defined in `tailwind.config.ts`. CSS Modules with `@reference "../../app/globals.css"` per CLAUDE.md.

## Possible Edge Cases

- **Skill id collision** — server returns 409 on `POST` if id exists; UI maps to a field-scoped error on the `id` input.
- **Mid-flight invocation when a skill is deleted/updated** — verify what the agent loop does if the in-progress turn references a now-modified skill. The 15-second cache means most invocations complete on the old version; document the behavior or add a confirmation prompt acknowledging it.
- **Two admins editing the same skill simultaneously** — the API uses ETag/IfMatch (verify in `web/lib/skill-store-cosmos.ts`); the UI should surface a 412 conflict as "this skill was changed by another admin — reload and reapply."
- **Long markdown content** — `validateSkillContent` has a length cap; the form should show character count and warn before submission.
- **Destructive-tool + reader-role validation rejection** — `validateSkill` refuses; the UI must catch this in the live preview, not at save time, so the admin doesn't lose work.
- **Unknown tool in the `Required Tools` list** — same; live-preview should highlight unknown tool names against the static `TOOLS` list (which the front-end can fetch via a new lightweight `GET /api/tools/names` endpoint, or hardcode for v1 since the tool list changes rarely).
- **Reader role browsing the URL directly** (`/settings?tab=skills`) — server-side redirect or 404; never render skill content for non-admin users even if a tampered DOM makes the tab visible.
- **DEV_AUTH_BYPASS shared `dev-operator` ownerId** — every dev session shares one admin identity; audit log correlation will look identical for all dev runs. Acceptable for local; flag for ops.
- **Mobile / narrow viewport** — the form's content textarea + parser preview should stack vertically below ~960 px.
- **Skill content over the 200K Anthropic context limit** — beyond `validateSkillContent`'s cap. The parser preview should also flag oversized skills.
- **Cache invalidation across App Service instances** — already documented; confirm the existing 15-second TTL is acceptable here or whether a write should fan-out an invalidation event.
- **Injection scan flagging admin-authored content as adversarial** (false positive) — likely if a skill itself documents prompt-injection refusal patterns. The UI should expose the scanner's match count + label so the admin can rephrase.
- **Content-Type / character-encoding edge cases** — multilingual skill content, smart quotes, emoji in tool names. Confirm parser tolerance.
- **Browser-side markdown preview with `rehype-sanitize`** — must match the server-side trust model so preview can't render scripts the saved skill won't.

## Acceptance Criteria

- Admin can list, view, create, update, and delete skills entirely through the UI without ever touching `curl`, the file system, or the migration script.
- Non-admin users (`reader`, `triage`) do not see the Skills tab in the navigation, and the underlying API still rejects their direct mutation requests with 403.
- All CRUD operations succeed in local dev (file-mode skill store) and in production (Cosmos-backed).
- Server-side validators (`validateSkillId`, `validateSkillContent`, `validateSkill`) and the new injection-scan reject invalid input with structured errors that the UI surfaces inline.
- A live parser preview shows the extracted name, description, required tools, required role, and parameters as the admin types — and flags unknown tools / destructive-tool-with-non-admin-role before submission.
- Every create / update / delete emits exactly one audit event with `skillId`, `action`, and `ownerIdHash`. No raw UPN in metadata.
- The 15-second cache propagation hint surfaces after every mutation.
- Delete requires typing the skill id to confirm.
- Concurrent-edit conflict (HTTP 412) is surfaced as a "reload and retry" inline error, not a generic failure.
- A11y: ARIA tablist for the tab nav, `role="dialog"` + focus trap on the delete confirmation modal, all interactive elements have visible `:focus-visible` styles, no `hover:opacity-80`, design-token-only colors, CSS modules with `@reference` directive, decorative icons `aria-hidden`, dynamic status text uses `aria-live="polite"`.
- All existing Settings-page tabs continue to work; no regression.
- Unit / component tests cover the happy paths plus the visibility gate, validation surfaces, conflict handling, and the injection-scan rejection path.
- The audit's Security-Medium "skill content not injection-scanned at admin write time" finding is closed by this PR.

## Open Questions

- **Markdown freeform vs. guided form** — should the create/edit form be a single markdown textarea (matching the file-on-disk format the migration script already produces) or a structured form (separate fields for name, description, required-tools picker, role select, parameters list, steps body) that compiles to the canonical markdown server-side? Freeform is faster to build and matches the file format admins already use; a guided form is friendlier for non-technical admins and prevents most validation errors. **Recommendation:** ship the freeform textarea + live parser preview for v1; revisit a guided form if UX feedback warrants. Agreed.
- **Live-preview tool name validation source** — fetch `GET /api/tools/names` lightweight endpoint, or bundle the static list at build time? Bundling is faster but goes stale across deploys. fetch from endpoint.
- **Versioning / rollback** — should the UI expose version history per skill? Cosmos retains the latest version; v1 has no version history. Out of scope for this spec but worth tracking. out of scope.
- **Bulk operations** — import a folder of `.md` files, export all skills as a zip? Out of scope for v1; admins can still use the existing migration script.
- **"Test this skill" button** — invoke the skill against a sample input from the UI to verify it parses and the agent loop accepts it? Useful but adds a meaningful surface (cost, abuse vector, audit). Defer.
- **Required-tools editor: free text vs. multi-select** — even in the freeform-textarea v1, should we show an autocomplete drop-down of valid tool names when the cursor is inside the `## Required Tools` block? Stretch goal. out of scope. 
- **Mobile editing** — is the markdown editor expected to be useful on a phone, or is desktop-only acceptable for an admin surface? Desktop only.
- **Audit-event severity routing** — operational topic only, or both operational and analytics (matching `legal_hold_violation`)? Recommend: operational only — skill writes are rare and don't need analytics fan-out.
- **Skill content character cap** — confirm the existing limit in `validateSkillContent`. If unset, propose a 50KB cap (current real skills are 1–5 KB). agreed.
- **Should the tab be reachable via deep link** (e.g. `/settings/skills`)? Existing tabs use querystring (`?tab=...`). Consistent with the rest. agreed.

## Testing Guidelines

Create test files under `web/test/` for the new behavior. Mirror the existing component-test pattern (`web/test/chat-message-rendering.test.tsx`, `web/test/attachment-badge-reload.test.tsx`) for UI; mirror the route-handler pattern for any new API surface.

- **Visibility / permission gate**
  - The Skills tab does NOT render in the settings page when `identity.role` is `reader` or `triage`.
  - The Skills tab DOES render when `identity.role` is `admin`.
  - Direct `POST/PUT/DELETE /api/skills` from a `reader` or `triage` session returns 403 (this is existing behavior; pin it with a regression test).

- **Create flow**
  - Submitting a valid skill markdown calls `POST /api/skills` once and returns to the list with the new entry visible.
  - Submitting with a duplicate id surfaces the 409 error inline on the `id` field.
  - Submitting with markdown that fails `validateSkillContent` surfaces the 400 inline on the content field.
  - Submitting markdown that references an unknown tool surfaces the validator's rejection inline (does NOT silently accept).
  - The injection-scan rejection path returns a clear error and is exercised by a test that includes a known scanner-trip pattern in the content.

- **Update flow**
  - Editing an existing skill pre-populates from the GET response.
  - Submitting an unchanged form is a no-op (or at least does not corrupt the audit trail with a "create" event).
  - Two-admin concurrent-edit conflict surfaces as a 412 with a "reload" message, not as a generic save error.

- **Delete flow**
  - Confirmation modal blocks delete until the admin types the exact skill id.
  - Successful delete removes the row from the list and emits exactly one audit event.

- **Parser preview**
  - As the admin types, the preview updates to reflect parsed `name`, `description`, `requiredTools`, `requiredRole`, `parameters`.
  - Unknown tool names in the preview are flagged (red badge or similar).
  - Destructive-tool + non-admin role combination is flagged as "this skill won't load."

- **A11y**
  - Tab navigation reaches every interactive element in document order.
  - The delete-confirmation modal traps focus and returns it to the trigger on close.
  - Live status text (toast / cache-propagation hint) uses `aria-live="polite"`.

- **Audit logging**
  - Successful create / update / delete each produce exactly one `logger.emitEvent` call with `{ skillId, action, ownerIdHash }`.
  - Failed mutations do NOT emit a success-shaped audit event.
