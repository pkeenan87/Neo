# Teams Bot Role Mapping

## Context

The Graph-based RBAC lookup for Teams users (`resolveTeamsRole` in `teams-auth.ts`) silently falls through to "reader" for all users, including admins. The fix is to assign a fixed role at the bot endpoint level via a `TEAMS_BOT_ROLE` environment variable, defaulting to "reader" but set to "admin" for the existing bot. The `resolveTeamsRole` function and `teams-auth.ts` module are removed entirely per the user's decision. The `MICROSOFT_APP_SP_OBJECT_ID` env var is also removed since it was only used for the Graph role lookup.

---

## Key Design Decisions

- Role is configured per bot endpoint via `TEAMS_BOT_ROLE` env var, not per user — the user will handle RBAC at the Teams layer by deploying one bot per role boundary
- Default value is "reader" (safe default) — the existing deployment sets it to "admin" explicitly
- `teams-auth.ts` is deleted entirely — the Graph dependency for role resolution is removed
- `MICROSOFT_APP_SP_OBJECT_ID` is removed from config, types, and `.env.example` since it was only used by `resolveTeamsRole`
- Branch A (confirmation flow) continues to use `session.role` from the stored session, so no changes needed there

---

## Files to Change

| File | Change |
|------|--------|
| `web/lib/config.ts` | Add `TEAMS_BOT_ROLE` to the `env` object, parsed as `Role` with "reader" default |
| `web/lib/types.ts` | Add `TEAMS_BOT_ROLE` to `EnvConfig`, remove `MICROSOFT_APP_SP_OBJECT_ID` |
| `web/app/api/teams/messages/route.ts` | Replace `resolveTeamsRole(aadObjectId)` call with `env.TEAMS_BOT_ROLE`, remove the import |
| `web/lib/teams-auth.ts` | Delete this file entirely |
| `.env.example` | Add `TEAMS_BOT_ROLE=admin`, remove `MICROSOFT_APP_SP_OBJECT_ID` and its comment |
| `scripts/provision-azure.ps1` | Add `TEAMS_BOT_ROLE` to the app settings block |

---

## Implementation Steps

### 1. Add TEAMS_BOT_ROLE to types

In `web/lib/types.ts`, add `TEAMS_BOT_ROLE: Role;` to the `EnvConfig` interface (importing `Role` from `./permissions` if not already imported). Remove the `MICROSOFT_APP_SP_OBJECT_ID` property.

### 2. Add TEAMS_BOT_ROLE to config

In `web/lib/config.ts`, add `TEAMS_BOT_ROLE` to the `env` object. Read from `process.env.TEAMS_BOT_ROLE`, validate that it is either "admin" or "reader", and default to "reader" if not set or invalid.

Remove `MICROSOFT_APP_SP_OBJECT_ID` from the `env` object.

### 3. Update the Teams messages route

In `web/app/api/teams/messages/route.ts`:

- Remove the import of `resolveTeamsRole` from `@/lib/teams-auth`
- In Branch B (around line 235), replace `const role = await resolveTeamsRole(aadObjectId)` with `const role = env.TEAMS_BOT_ROLE`
- The `role` variable is then used in `sessionStore.create(role, aadObjectId)` and `scanUserInput` — no other changes needed since the type is already `Role`

### 4. Delete teams-auth.ts

Delete the file `web/lib/teams-auth.ts` entirely. It is no longer imported by any module after step 3.

### 5. Update .env.example

- Add `TEAMS_BOT_ROLE=admin` in the Teams Bot section with a comment explaining the valid values and that it defaults to "reader"
- Remove the `MICROSOFT_APP_SP_OBJECT_ID` line and its associated comment about `az ad sp show`

### 6. Update provision-azure.ps1

In `scripts/provision-azure.ps1`, add `TEAMS_BOT_ROLE="admin"` to the `az webapp config appsettings set` block (alongside `MOCK_MODE` and `INJECTION_GUARD_MODE`). Also add it to the summary template command for secret env vars.

---

## Verification

1. Run `cd web && npx tsc --noEmit` to confirm no type errors
2. Run `cd web && npm run build` to confirm the production build succeeds
3. Grep the codebase for `resolveTeamsRole` and `teams-auth` to confirm no remaining references
4. Grep for `MICROSOFT_APP_SP_OBJECT_ID` to confirm it is fully removed
5. Verify that `env.TEAMS_BOT_ROLE` resolves to "admin" when `TEAMS_BOT_ROLE=admin` is in `.env`, and to "reader" when unset
