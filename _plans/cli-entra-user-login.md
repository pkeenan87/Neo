# CLI Entra ID Login for Regular Users

## Context

The CLI's `auth login` command currently requires both `--tenant-id` and `--client-id` flags for Entra ID login, which is impractical for regular users who don't know their org's app registration client ID. This plan adds a server-provided discovery endpoint so the CLI can auto-discover the Entra config, letting users log in with zero flags. The user's spec explicitly says to NOT preserve backward compatibility — the `--client-id` flag will be removed.

---

## Key Design Decisions

- **Server-provided discovery over hardcoded values**: A new unauthenticated `GET /api/auth/discover` endpoint on the web server returns the tenant ID and client ID from the server's existing environment variables. This centralizes config — admins configure the server once and all CLI users benefit.
- **No backward compatibility**: The `--client-id` flag is removed entirely per the spec. The `--tenant-id` flag remains as an optional override but is no longer required.
- **Resolution priority**: CLI flags > env vars > saved config > server discovery. Discovery is the last resort but the most common path for regular users.
- **Discovery result is cached**: After a successful discovery, the tenant ID and client ID are saved to `~/.neo/config.json` so subsequent logins don't need to hit the server.

---

## Files to Change

| File | Change |
|------|--------|
| `web/app/api/auth/discover/route.ts` | New file — unauthenticated GET endpoint returning `{ tenantId, clientId }` from server env vars |
| `cli/src/auth-entra.js` | Replace `resolveEntraConfig()` and `login()` to use an async resolution chain that includes server discovery; remove `clientId` from `login(options)` |
| `cli/src/index.js` | Remove `--client-id` flag from `handleAuthCommand`, update login call signature, update usage strings and error messages |
| `cli/src/config.js` | Update the "no auth configured" error message to remove `--client-id` reference |
| `docs/configuration.md` | Update CLI auth section to reflect the simplified login flow |
| `docs/user-guide.md` | Update first-time setup and CLI commands to remove `--client-id` references |

---

## Implementation Steps

### 1. Create the server discovery endpoint

- Create a new file at `web/app/api/auth/discover/route.ts`
- Export a `GET` handler that is unauthenticated (no call to `resolveAuth`)
- Read `AUTH_MICROSOFT_ENTRA_ID_ID` and extract the tenant ID from `AUTH_MICROSOFT_ENTRA_ID_ISSUER` (parse the URL to get the tenant ID segment)
- Return JSON: `{ tenantId: string, clientId: string }`
- If either value is not configured on the server, return a 503 with `{ error: "Entra ID not configured on this server" }`
- Add `Cache-Control: public, max-age=3600` header since these values change infrequently

### 2. Add discovery fetch to `auth-entra.js`

- Add a new async function `discoverEntraConfig(serverUrl)` that fetches `GET {serverUrl}/api/auth/discover`
- On success, return `{ tenantId, clientId }` from the response JSON
- On failure (network error, non-200 status), return `null` — discovery is best-effort
- Rewrite `resolveEntraConfig()` to become async and follow the resolution chain: env vars > saved config > discovery (taking `serverUrl` as a parameter)
- Rewrite the `login(options)` function to accept `serverUrl` instead of `clientId`, call the new async resolution, and remove the `clientId` option entirely
- In the error message when resolution fails, tell the user to check that their server has Entra ID configured, or to pass `--tenant-id` and set `NEO_CLIENT_ID` env var
- Continue to persist the discovered `tenantId` and `clientId` to config after successful login so future logins and token refreshes don't need discovery

### 3. Update `index.js` auth commands

- Remove the `--client-id` flag parsing from `handleAuthCommand`
- Pass the resolved server URL to `login()` instead of `clientId`. Resolve the server URL using: `parseFlag("--server") || process.env.NEO_SERVER || readConfig().serverUrl || "http://localhost:3000"`
- Update the login error message usage block to show only `--tenant-id` (remove `--client-id` reference)
- Update the `auth status` display — if Entra ID is configured, also show the saved tenant ID

### 4. Update `config.js` error messages

- In the "No authentication configured" block, change the Entra ID option from `node src/index.js auth login --tenant-id <id> --client-id <id>` to just `node src/index.js auth login`

### 5. Update documentation

- In `docs/configuration.md`: remove all references to `--client-id` as a CLI flag; update the "Entra ID Auth (CLI)" section to show the simplified flow; add a note about the discovery endpoint under the server-side Entra ID section
- In `docs/user-guide.md`: update the first-time setup instructions; simplify the CLI commands reference table; remove `--client-id` from the flags table
- In `README.md`: update the CLI Auth commands table to remove `--client-id`

### 6. Verify

- Run `node -e "import('./src/auth-entra.js')"` from the CLI directory to check for import errors
- Run `cd web && npm run build` to verify the new route compiles
- Test `node src/index.js auth status` still works
- Test `node src/index.js auth login` with the server running (should discover config and open browser)
- Test `node src/index.js auth login --tenant-id <id>` (should use discovery for client ID, flag for tenant ID)

---

## Verification

1. Start the web server with Entra ID env vars configured and run `curl http://localhost:3000/api/auth/discover` — should return `{ tenantId, clientId }`
2. Start the web server without Entra ID env vars and run `curl http://localhost:3000/api/auth/discover` — should return 503
3. With the server running, run `node src/index.js auth login` with no flags — should discover config and open browser
4. With no server running and no saved config, run `node src/index.js auth login` — should print a clear error about configuring the server or setting env vars
5. Run `cd web && npm run build` to verify the new route compiles cleanly
