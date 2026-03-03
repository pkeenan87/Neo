# API and UI Authentication

## Context

The Next.js API (`web/`) currently has no authentication — any HTTP client can invoke the agent and execute tools. This plan adds Auth.js v5 (next-auth@beta) with two providers: Microsoft Entra ID (OAuth/OIDC) and API Key (via Credentials provider). A unified role system (Admin / Reader) governs tool access for both auth methods, managed in a single permissions file. Reader sessions omit destructive tools from the Claude schema entirely so the model never attempts them.

---

## Key Design Decisions

- **Auth.js v5 (next-auth@beta)** — The standard Next.js auth library. JWT strategy (no database). Entra ID is a built-in provider; API keys go through the Credentials provider so both flows produce the same session shape.
- **API keys stored in a JSON config file** — `web/api-keys.json` holds an array of `{ key, role, label }` entries. Gitignored. Easy to read and edit for v1; will migrate to Azure Key Vault later.
- **Single permissions file** — `web/lib/permissions.ts` is the source of truth for roles, tool access rules, and rate limits. Both Entra ID and API key sessions resolve to the same `Role` type, so all downstream checks are provider-agnostic.
- **Destructive tools omitted for Readers** — Rather than blocking execution after Claude requests a destructive tool, Reader sessions pass a filtered `TOOLS` array to the Claude API call that excludes destructive tools entirely. This prevents Claude from even knowing about tools the user cannot use.
- **Role-based rate limits** — `web/lib/permissions.ts` exports rate limit config per role. Admin gets double the Reader limit. The session store reads from this config instead of its current hardcoded constant.
- **API key auth via Authorization header** — API consumers send `Authorization: Bearer <key>`. The Credentials provider's `authorize` function looks up the key in the JSON file and returns a user object with the mapped role. Browser-based Entra ID users go through the standard OAuth flow.
- **Next.js 16 compatibility** — Auth.js v5 route handlers work fine on Next.js 16. The `signIn` server action has a known issue on Next.js 16, but we only need the HTTP handlers for v1 (no server action sign-in). Middleware file is `middleware.ts` (Next.js 16 still supports this name alongside the new `proxy.ts`).

---

## Files to Change

| File | Change |
|------|--------|
| `web/package.json` | Add `next-auth@beta` dependency |
| `.env` | Add `AUTH_SECRET`, `AUTH_MICROSOFT_ENTRA_ID_ID`, `AUTH_MICROSOFT_ENTRA_ID_SECRET`, `AUTH_MICROSOFT_ENTRA_ID_ISSUER` variables |
| `web/auth.ts` | New. Auth.js config: Entra ID provider, Credentials provider (for API keys), JWT callbacks that embed role into token/session |
| `web/api-keys.json` | New. JSON array of API key entries with role and label. Gitignored. |
| `web/lib/permissions.ts` | New. Role type, `canUseTool()`, `getToolsForRole()`, rate limit config per role |
| `web/lib/rate-limits.ts` | New. Rate limit configuration per role, exported as a simple config object |
| `web/lib/types.ts` | Add `Role` type, extend `Session` interface with `role` field, add `AuthenticatedSession` type |
| `web/lib/agent.ts` | Modify `runAgentLoop()` to accept a `role` parameter and pass role-filtered tools to the Claude API call |
| `web/lib/session-store.ts` | Modify to read rate limits from permissions config instead of hardcoded constant. Add `role` to session creation. |
| `web/app/api/auth/[...nextauth]/route.ts` | New. Export GET and POST handlers from auth.ts |
| `web/app/api/agent/route.ts` | Add auth check: call `auth()` to get session, return 401 if unauthenticated, pass role to agent loop |
| `web/app/api/agent/confirm/route.ts` | Add auth check, verify caller's role permits the pending destructive tool |
| `web/app/api/agent/sessions/route.ts` | Add auth check |
| `web/middleware.ts` | New. Protect `/api/agent/*` routes. Allow `/api/auth/*` through. |
| `.gitignore` | Add `api-keys.json` |

---

## Implementation Steps

### 1. Install next-auth

- Run `npm install next-auth@beta` inside `web/`
- Verify it installs without peer dependency conflicts against Next.js 16

### 2. Add environment variables

- Add to `.env`: `AUTH_SECRET` (generate a random 32-char string), `AUTH_MICROSOFT_ENTRA_ID_ID`, `AUTH_MICROSOFT_ENTRA_ID_SECRET`, `AUTH_MICROSOFT_ENTRA_ID_ISSUER` (format: `https://login.microsoftonline.com/{tenant-id}/v2.0`)
- Leave Entra ID values blank with comments for now (can test with API keys first)

### 3. Create the API keys config file

- Create `web/api-keys.json` with the shape: `{ "keys": [{ "key": "<random-string>", "role": "admin", "label": "Dev Admin Key" }, { "key": "<random-string>", "role": "reader", "label": "Dev Reader Key" }] }`
- Add `api-keys.json` to the root `.gitignore`
- Create `web/api-keys.example.json` with the same shape but placeholder values, checked into git

### 4. Create permissions file (`web/lib/permissions.ts`)

- Define and export `Role` type as `"admin" | "reader"`
- Define a `ROLE_PERMISSIONS` config object that maps each role to its capabilities:
  - `admin`: `{ canUseDestructiveTools: true }`
  - `reader`: `{ canUseDestructiveTools: false }`
- Export `canUseTool(role: Role, toolName: string): boolean` — returns `true` if the tool is not in `DESTRUCTIVE_TOOLS`, or if the role is admin
- Export `getToolsForRole(role: Role): Tool[]` — returns the full `TOOLS` array for admin, or `TOOLS` filtered to exclude `DESTRUCTIVE_TOOLS` entries for reader
- Export `RATE_LIMITS` config: `{ admin: { messagesPerSession: 200 }, reader: { messagesPerSession: 100 } }`

### 5. Update types (`web/lib/types.ts`)

- Add `Role` re-export from permissions (or define it here and import in permissions — decide on canonical location)
- Add `role: Role` to the `Session` interface
- Add an `AuthenticatedSession` interface that wraps the Auth.js session with `role` and `provider` fields
- Extend `AgentCallbacks` or `runAgentLoop` signature — no callback change needed, just add `role` param

### 6. Create Auth.js config (`web/auth.ts`)

- Import `NextAuth` from `next-auth`
- Import `MicrosoftEntraID` from `next-auth/providers/microsoft-entra-id`
- Import `Credentials` from `next-auth/providers/credentials`
- Configure Entra ID provider with env vars: `AUTH_MICROSOFT_ENTRA_ID_ID`, `AUTH_MICROSOFT_ENTRA_ID_SECRET`, `AUTH_MICROSOFT_ENTRA_ID_ISSUER`
- Configure Credentials provider:
  - Single credential field: `apiKey` of type `text`
  - `authorize` function: read `web/api-keys.json`, find matching key, return `{ id: label, name: label, role }` or `null`
- Add `callbacks.jwt`: on initial sign-in, extract role from either:
  - Entra ID: read `roles` claim from the `account.id_token` (Entra ID app roles come as a `roles` array in the token), map to internal `Role` type. Default to `"reader"` if no recognized role claim.
  - Credentials: read `role` from the user object returned by `authorize`
  - Persist `role` and `provider` on the JWT token
- Add `callbacks.session`: copy `role` and `provider` from token to session object
- Add `session: { strategy: "jwt" }`
- Export `{ handlers, auth, signIn, signOut }`

### 7. Create Auth.js route handler

- Create `web/app/api/auth/[...nextauth]/route.ts`
- Export `{ GET, POST }` from `@/auth` (the `handlers` export from auth.ts)

### 8. Create middleware (`web/middleware.ts`)

- Export `auth` as default middleware from `@/auth`
- Configure `matcher` to cover `/api/agent/:path*` routes
- Exclude `/api/auth/:path*` from protection (Auth.js needs these public)

### 9. Update agent loop (`web/lib/agent.ts`)

- Add a `role` parameter to `runAgentLoop(messages, callbacks, role)`
- Import `getToolsForRole` from permissions
- Replace the hardcoded `tools: TOOLS` in the Claude API call with `tools: getToolsForRole(role)`
- The destructive tool confirmation gate (`DESTRUCTIVE_TOOLS.has(name)`) remains unchanged — for Admin users, destructive tools are in the schema and hit the confirmation gate as before; for Reader users, they never appear in the schema
- Update `resumeAfterConfirmation` to also accept `role` and pass it through to `runAgentLoop`

### 10. Update session store (`web/lib/session-store.ts`)

- Import `RATE_LIMITS` from permissions
- Import `Role` type
- Add `role: Role` to the `Session` interface usage
- Update `create()` to accept a `role` parameter and store it on the session
- Update `isRateLimited()` to check `session.messageCount >= RATE_LIMITS[session.role].messagesPerSession` instead of the hardcoded `MESSAGE_LIMIT`
- Remove the hardcoded `MESSAGE_LIMIT = 100` constant

### 11. Update API routes

**`web/app/api/agent/route.ts`:**
- Import `auth` from `@/auth`
- At the top of the POST handler, call `const authSession = await auth()`
- If no session, return 401 with `{ error: "Unauthorized" }`
- Extract `role` from `authSession.user.role`
- Pass `role` to `sessionStore.create(role)` when creating a new session
- Pass `role` (from the agent session, not the auth session) to `runAgentLoop()`

**`web/app/api/agent/confirm/route.ts`:**
- Import `auth` from `@/auth`
- Add auth check at the top — return 401 if unauthenticated
- Before clearing the pending confirmation, verify the caller's role permits the pending tool using `canUseTool(role, pendingTool.name)` — return 403 if not (safety net, should not happen if tools were filtered correctly)
- Pass `role` through to `resumeAfterConfirmation()`

**`web/app/api/agent/sessions/route.ts`:**
- Import `auth` from `@/auth`
- Add auth check to both GET and DELETE — return 401 if unauthenticated

### 12. Update stream helper (`web/lib/stream.ts`)

- `writeAgentResult` currently doesn't need role awareness — the filtering happens upstream in the agent loop. No changes needed unless the confirmation_required event should include role info.

### 13. Update `.env` and config

- Add new env vars to `web/lib/config.ts` `EnvConfig` interface: `AUTH_SECRET`, `AUTH_MICROSOFT_ENTRA_ID_ID`, `AUTH_MICROSOFT_ENTRA_ID_SECRET`, `AUTH_MICROSOFT_ENTRA_ID_ISSUER`
- Update `validateConfig()` to warn if `AUTH_SECRET` is missing (Auth.js requires it in production)

---

## Verification

1. **Build check** — `cd web && npm run build` compiles with zero TypeScript errors
2. **Unauthenticated rejection** — `curl -X POST http://localhost:3000/api/agent -H "Content-Type: application/json" -d '{"message":"test"}'` returns 401
3. **API key auth (Admin)** — `curl -X POST http://localhost:3000/api/agent -H "Content-Type: application/json" -H "Authorization: Bearer <admin-key>" -d '{"message":"Show me high severity incidents"}'` returns NDJSON stream with session, thinking, tool_call, and response events
4. **API key auth (Reader)** — Same curl with a reader key. Destructive tools should not appear in Claude's responses since they are not in the schema. If the user asks to reset a password, Claude should explain it cannot perform that action.
5. **Reader rate limit** — Send 101 messages with a reader key to the same session — 101st returns 429
6. **Admin rate limit** — Send 201 messages with an admin key — 201st returns 429 (double the reader limit)
7. **Confirm endpoint auth** — `curl -X POST http://localhost:3000/api/agent/confirm` without auth returns 401
8. **Sessions endpoint auth** — `curl http://localhost:3000/api/agent/sessions` without auth returns 401
9. **CLI unaffected** — `cd cli && npm start` still works as before (no auth on CLI)
