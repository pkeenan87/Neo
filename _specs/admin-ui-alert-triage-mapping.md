# Spec for admin-ui-alert-triage-mapping

branch: claude/feature/admin-ui-alert-triage-mapping
figma_component (if used): n/a

## Summary

Today the alert-triage system maps an inbound alert source (`<product>:<alertType>`) to a skill via a hardcoded constant `TRIAGE_SKILL_MAP` in `web/lib/triage-dispatch.ts`. Adding or changing a mapping requires editing source code, opening a PR, and deploying — even though the underlying skills themselves are already managed via the admin Settings UI and persisted to Cosmos.

This feature replaces the hardcoded constant with an admin-managed lookup table backed by a new Cosmos container, plus a Settings UI surface where admins can list, create, edit, and delete mappings between alert source keys and skill IDs. Once shipped, the SOC team can introduce a new triage skill and bind it to an alert type without a code change. This is the implementation of the "versioned lookup table" already called out in `_specs/alert-triage-api.md`.

Notion source: [Admin UI for Alert Triage Mapping](https://www.notion.so/3597b36249e2801b9031fa376c76f1ca).

## Functional requirements

- A new admin-only **Triage Mappings** section in `/settings`, gated behind `userRole === "admin"` like the existing Skills tab.
- The section lists every existing mapping with: alert source key (`<product>:<alertType>`), mapped skill (name + id), last updated timestamp, and last-updated-by identity.
- A "New mapping" form lets the admin enter the alert source key as free-form text and pick the mapped skill from a dropdown of currently-registered skills (id + display name).
- Existing mappings can be edited (change which skill they point to) and deleted.
- All writes persist to a new Cosmos container, e.g. `triageMappings`, partitioned by the alert source key (or a tenant id if multi-tenant later).
- `resolveTriageSkill()` in `web/lib/triage-dispatch.ts` is rewritten to read from the Cosmos-backed mapping store (with the same hot-reload caching pattern the skill store already uses — propagation across App Service instances within ≤15 seconds).
- The hardcoded `TRIAGE_SKILL_MAP` constant and its accompanying comment block are removed.
- The fallback to `generic-alert-triage` when no mapping exists is preserved.
- A seeding step ensures the existing `DefenderXDR:DefenderEndpoint.SuspiciousProcess → defender-endpoint-triage` mapping is present after deployment so the change is non-breaking.
- `scripts/provision-cosmos-db.ps1` is updated to create the new `triageMappings` container during fresh provisioning, and the Python equivalent under `scripts/` (if one is added) follows.
- The configuration guide in `docs/configuration.md` documents the new mapping admin flow and points operators at the Settings → Triage Mappings tab as the canonical source of truth.

## Possible Edge Cases

- **Cosmos is unavailable** when a triage request arrives. The endpoint must still respond — fall back to the generic skill with a logged warning, mirroring the existing pattern in `_specs/alert-triage-api.md` for the dedup cache.
- **Mapping references a skill that no longer exists** (the skill was deleted after the mapping was created). The triage path should treat this as an unmapped alert and fall through to the generic skill, plus emit a logged warning to flag the orphan to an operator.
- **Skill deletion from the Skills UI** while one or more mappings reference it. Surface a warning in the delete-confirm modal listing the affected mappings; either block the deletion or allow it with a clear "X mappings will be orphaned" acknowledgment (decision under Open Questions).
- **Duplicate key on create**. The Cosmos primary key on the source key (or a unique-constraint pattern via the partition + id model) returns 409 and the UI shows a clear "Mapping for `<key>` already exists" error.
- **Concurrent edits** to the same mapping. Last-write-wins is acceptable for an admin-managed config table; the UI should optimistically update and toast on conflict.
- **Key format validation.** The free-form input should enforce a pattern like `<product>:<alertType>` (non-empty alphanumeric on both sides, single colon separator, no whitespace) before submit. Server-side validation re-applies the same rule.
- **Case sensitivity.** Real product names are case-sensitive (e.g., `DefenderXDR` not `defenderxdr`). Decide once and document.
- **Hot-reload lag.** Like skills, mapping changes propagate across App Service instances within the cache TTL window. Surface the same "Changes propagating across instances; may take up to 15 seconds" hint after a write.
- **Non-admin tries to access the API endpoints.** Returns 403 via `auth-helpers.resolveAuth()` + role check.
- **Audit logging.** Mapping create / update / delete events should be written to the Event Hub audit trail with caller identity, like other admin actions.

## Acceptance Criteria

- [ ] Admins can list, create, edit, and delete alert-triage mappings via a new admin-only Settings → Triage Mappings tab.
- [ ] Mappings persist to a new Cosmos container (`triageMappings`) and survive App Service restarts.
- [ ] `resolveTriageSkill()` reads mappings from the Cosmos-backed store with hot-reload propagation across instances within 15 seconds.
- [ ] The hardcoded `TRIAGE_SKILL_MAP` constant in `web/lib/triage-dispatch.ts` is removed.
- [ ] If Cosmos is unavailable during a triage request, the endpoint falls back to the generic skill and logs a warning rather than failing the request.
- [ ] The existing `DefenderXDR:DefenderEndpoint.SuspiciousProcess → defender-endpoint-triage` mapping is seeded into the new container during deployment so the rollout is non-breaking.
- [ ] Deleting a skill from the Skills UI that is referenced by one or more mappings surfaces a clear warning before deletion.
- [ ] `scripts/provision-cosmos-db.ps1` provisions the new container during fresh provisioning.
- [ ] Mapping changes emit audit events to the Event Hub trail with caller identity.
- [ ] `docs/configuration.md` documents the new admin flow and identifies Cosmos as the source of truth.
- [ ] All required CI checks pass (typecheck, lint, tests, CodeQL, gitleaks, all-checks aggregator).

## Open Questions

- Should we **lift this into the existing Skills tab** (e.g., a "Mappings" sub-section) or add a new top-level **Triage Mappings** tab in Settings? The latter seems cleaner since the audience is the same admin role and mappings are a distinct concept. a new top level tab
- Is the **alert source key editable** after creation, or only the mapped skill? Treating the key as immutable (delete + recreate) is simpler and mirrors how the Skills UI treats skill IDs. immutable.
- Are mapping keys **case-sensitive**? Real-world product names are mixed-case (`DefenderXDR`), so case-sensitive matches the wire reality, but admins fat-finger casing routinely. case sensitive
- When a referenced skill is **deleted**, do we **block deletion**, **cascade-delete the mappings**, or **orphan and warn**? The least surprising option for SOC operators is probably "block deletion until mappings are reassigned or removed", but it adds friction. block deletion until mappings are removed/reassigned
- Do we need a **"test mapping" feature** (paste a sample `source.product` + `source.alertType`, see which skill it would resolve to including the generic fallback path)? Useful, but probably out of scope for the first cut. good suggestion, lets add that too.
- Should the spec also wire mapping changes through the **prompt-injection guard's audit trail**, or is the existing skill-store audit pattern enough? existing is enough.
- Do we want a **default mapping seeded for every alert product** (Defender XDR, Sentinel, Entra ID, Purview) at provisioning time, or only the one that already exists today? just the one that exists today.

## Testing Guidelines

Create test files in `web/test/` (and `web/scripts/` if relevant) covering at least:

- **CRUD route handlers** — `GET /api/triage-mappings`, `POST`, `PUT /[id]`, `DELETE /[id]`. Mock Cosmos at the boundary; assert response shapes, status codes, and that 401 / 403 fire for unauthenticated and non-admin callers.
- **Validation** — invalid key formats (empty halves, missing colon, embedded whitespace, case-only differences) are rejected with a clear 400 error. Empty skill ID or unknown skill ID is rejected.
- **Skill resolution** — `resolveTriageSkill()` against a stub mapping store: returns the mapped skill on hit, returns the generic skill on miss, returns null only if neither the mapped skill nor the generic skill exist.
- **Cosmos failure path** — when the mapping store throws, `resolveTriageSkill()` falls back to the generic skill and logs a warning.
- **Hot-reload** — after a write, `resolveTriageSkill()` reflects the new mapping within the cache TTL window without a process restart.
- **Orphan reference** — a mapping that points at a deleted skill is treated as a miss; a warning is logged.
- **Skill-deletion guard** — attempting to delete a skill referenced by one or more mappings surfaces the warning (or block) decided in Open Questions.
- **Migration / seeding** — running the seed step on an empty container produces the existing Defender XDR mapping; running it twice is idempotent.
- **UI** — Settings → Triage Mappings tab renders the list, the create form validates the key format, the skill dropdown is populated from `/api/skills`, the cache-propagation hint appears after a write, and non-admin users do not see the tab (mirrors the existing Skills tab gating tests in `web/test/skills-section.test.tsx`).
