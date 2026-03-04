# CLI Session Token Refresh

## Context

The CLI resolves its auth header once at startup via `resolveServerConfig()` in `cli/src/config.js` and passes the resulting static `authHeader` string through `main()` → `runAgentLoop()` → `streamMessage()` / `streamConfirm()`. Entra ID tokens expire after 60–90 minutes, so long REPL sessions fail with 401 errors mid-investigation. This plan replaces the static string with a getter function that resolves a fresh token before each API call, and adds a background refresh interval to keep the token warm proactively.

---

## Key Design Decisions

- **Getter function over mutable shared state**: Replace the static `authHeader` string with an `authHeaderFn` function (`() => Promise<string>`) passed through the call chain. For API key auth, this returns a constant. For Entra ID, it calls `getAccessToken()` which already handles refresh-on-demand. This avoids mutable shared state and ensures each API call uses a valid token.
- **Background proactive refresh in addition to on-demand**: Start a `setInterval` in `main()` for Entra ID sessions that calls `getAccessToken()` every 10 minutes. This keeps the token warm so on-demand calls don't block on a refresh. The interval is conservative — `getAccessToken()` already short-circuits if the token is still fresh.
- **Cleanup on exit**: Clear the interval when the REPL exits (`exit` command or process signal) so the Node.js process doesn't hang.
- **Silent success, visible failure**: Background refresh logs nothing on success (or debug-only). On failure, it prints a warning so the analyst knows their session may expire.

---

## Files to Change

| File | Change |
|------|--------|
| `cli/src/config.js` | `resolveServerConfig()` returns `authHeaderFn: () => Promise<string>` instead of `authHeader: string` |
| `cli/src/agent.js` | `runAgentLoop()` and `confirmTool()` accept `authHeaderFn` (function) instead of `authHeader` (string), await it before passing to `server-client.js` |
| `cli/src/server-client.js` | `streamMessage()` and `streamConfirm()` accept `authHeaderFn` (function) instead of `authHeader` (string), await it to get the header value before each `fetch()` |
| `cli/src/index.js` | Destructure `authHeaderFn` instead of `authHeader` from `resolveServerConfig()`. Start a background refresh interval for Entra ID sessions. Clear the interval on REPL exit. |

---

## Implementation Steps

### 1. Update `resolveServerConfig()` in `cli/src/config.js`

- Change the return type from `{ serverUrl, authHeader }` to `{ serverUrl, authHeaderFn, authMethod }`
- For the API key paths (flag, env var, config store), return an `authHeaderFn` that is a sync-returning async function: `async () => "Bearer <key>"` — the key never changes so this is a trivial wrapper
- For the Entra ID path, return an `authHeaderFn` that calls `getAccessToken()` on each invocation and returns `"Bearer <token>"`. Remove the `try/catch` + `process.exit(1)` — instead, do an initial `getAccessToken()` call at startup to verify the token is valid (fail fast), then return the getter. If the initial call fails, exit as before
- Return `authMethod` as a string (`"api-key"` or `"entra-id"`) so `index.js` knows whether to start the background refresh interval

### 2. Update `streamMessage()` and `streamConfirm()` in `cli/src/server-client.js`

- Change the `authHeader` parameter to `authHeaderFn` in both functions
- Before the `fetch()` call in each function, await `authHeaderFn()` to get the current header value
- Use the resolved string in the `Authorization` header as before
- No other changes — error handling, stream processing, etc. remain the same

### 3. Update `runAgentLoop()` and `confirmTool()` in `cli/src/agent.js`

- Change the `authHeader` parameter to `authHeaderFn` in both functions
- Pass `authHeaderFn` through to `streamMessage()` and `streamConfirm()` respectively
- These are pure pass-through changes — the agent module just forwards the function

### 4. Update `main()` in `cli/src/index.js`

- Destructure `authHeaderFn` and `authMethod` instead of `authHeader` from `resolveServerConfig()`
- Pass `authHeaderFn` (instead of `authHeader`) to `runAgentLoop()` and `confirmTool()` calls
- After `resolveServerConfig()` and before the REPL loop, if `authMethod` is `"entra-id"`, start a background refresh interval:
  - Use `setInterval()` with a 10-minute period (600,000 ms)
  - The callback calls `getAccessToken()` (which internally checks freshness and refreshes if needed)
  - On success: log nothing (or `[debug]` message if `DEBUG` is set)
  - On failure: print a `chalk.yellow` warning like `"⚠ Token refresh failed — session may expire soon. Run 'auth login' to re-authenticate."`
  - Store the interval ID in a variable
- Clear the interval on REPL exit:
  - In the `exit` command handler (before `rl.close()`), call `clearInterval(refreshInterval)`
  - Add a `process.on("SIGINT", ...)` handler that clears the interval before exiting
  - Use `ref()`/`unref()` on the interval so it doesn't prevent natural process exit — call `.unref()` on the return value of `setInterval()`

---

## Verification

1. Start the CLI with Entra ID auth, verify login succeeds and the REPL opens normally
2. Run `auth status` — confirm the token shows a valid expiry time
3. Set `DEBUG=1` and wait past the 10-minute refresh interval — confirm a debug log shows the refresh fired (or was skipped because the token is still fresh)
4. Manually set `expiresAt` in `~/.neo/config.json` to a value in the past, then send a message in the REPL — confirm the on-demand refresh fires and the API call succeeds
5. Type `exit` in the REPL — confirm the process exits cleanly without hanging
6. API key auth should work exactly as before — no functional changes
7. `cd cli && npm start` still starts correctly with no new warnings or errors
