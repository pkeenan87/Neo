# Teams Bot Role Mapping

> Replace the broken Graph-based RBAC lookup for Teams users with a simpler bot-level role mapping, where each Teams bot endpoint is assigned a fixed role.

## Problem

The current Teams RBAC implementation in `web/lib/teams-auth.ts` attempts to resolve each user's role by querying Microsoft Graph for their Entra ID app role assignments. In practice, this does not work:

- Users with the Admin app role are being mapped to "reader" — the Graph lookup chain (`appRoleAssignments` → `servicePrincipals` → `appRoles`) silently falls through to the default
- Users who have no access to the application at all still get "reader" because the fallback is always "reader"
- The lookup requires `MICROSOFT_APP_SP_OBJECT_ID` to be configured correctly, and when it is not set, all users silently get "reader"
- The Graph API calls add latency to every new Teams session and create a dependency on Graph API availability

The user's architectural direction is to handle RBAC at the Teams layer: deploy one bot per team/role boundary and assign the role at the bot endpoint level. This eliminates the need for per-user Graph lookups entirely. For now, the single existing bot should be mapped to the "admin" role. Future bots will be added as additional messaging endpoints with their own role assignments.

## Goals

- Map the existing Teams bot messaging endpoint (`/api/teams/messages`) to the "admin" role
- Remove the broken Graph-based role resolution for the existing Teams endpoint
- Design the route structure so that additional bot endpoints with different roles can be added in the future
- Maintain the same session, injection guard, and confirmation gate behavior — only the role source changes

## Non-Goals

- Creating additional bot endpoints now (that is future work)
- Changing how RBAC works for the web API or CLI (those use API keys and Entra ID tokens)
- Removing the `teams-auth.ts` module entirely (it may be useful for future per-user audit logging)
- Changing the Bot Framework adapter configuration or Teams app manifest
- Implementing Teams group membership checks

## User Stories

1. **As a SOC analyst using Teams**, when I send a message to the Neo bot, my session is created with the "admin" role so I can use all tools including destructive actions (with confirmation gates).
2. **As a platform admin**, I can later add a second bot endpoint (e.g., `/api/teams/reader/messages`) that maps to the "reader" role for a different Teams channel/team.
3. **As a platform admin**, I can configure the role for the existing Teams bot via an environment variable so I can change it without redeploying code.

## Design Considerations

### Role Source

Instead of calling Microsoft Graph to resolve each user's role, the Teams messaging endpoint should use a fixed role configured at the bot level. This role applies to all users who interact through that specific bot endpoint.

The role should be configurable via an environment variable (e.g., `TEAMS_BOT_ROLE`) with a default value. This allows the admin to change the role mapping without code changes, and each future bot endpoint can have its own env var.

### Existing Teams Auth Module

The `teams-auth.ts` module currently exports `resolveTeamsRole()` which does the Graph lookup. The Teams route calls this to get the role for session creation. The simplest change is to stop calling `resolveTeamsRole()` in the route and instead read the role from the environment/config. The `teams-auth.ts` module can be left in place (or simplified) — it may be useful later for audit purposes (identifying which user sent a message) even when the role is fixed at the bot level.

### Future Multi-Bot Architecture

The current route structure is:
```
/api/teams/messages  →  single bot, all users
```

The future architecture will be:
```
/api/teams/messages         →  admin bot (existing)
/api/teams/reader/messages  →  reader bot (future)
```

Each endpoint would have its own Bot Framework app registration (different `MICROSOFT_APP_ID` and `MICROSOFT_APP_PASSWORD`) and its own fixed role. The current implementation should be structured so this extension is straightforward — primarily by making the role a parameter of the route rather than a global constant.

### Session Creation

Currently, `resolveTeamsRole(aadObjectId)` is called and the result is passed to `sessionStore.create(role, aadObjectId)`. After this change, the role comes from the environment instead. The `aadObjectId` is still extracted from the Teams activity and used as the session owner for audit and session ownership.

## Key Files

- `web/app/api/teams/messages/route.ts` — Replace `resolveTeamsRole()` call with environment-based role
- `web/lib/teams-auth.ts` — May simplify or leave as-is; the route will no longer call `resolveTeamsRole()`
- `web/lib/config.ts` — Add `TEAMS_BOT_ROLE` to the env config
- `.env.example` — Document the new `TEAMS_BOT_ROLE` variable

## Open Questions

1. Should the default value for `TEAMS_BOT_ROLE` be "admin" (matching the immediate need) or "reader" (safer default)? The user wants admin for now, but a safer default prevents accidental privilege escalation if someone deploys without configuring it. The default role should be reader but the existing bot should get the admin role.
2. Should `resolveTeamsRole()` still be called for audit logging purposes (to record the user's Entra ID role in logs alongside the bot-level role), or should it be removed entirely to eliminate the Graph dependency? remove it.
