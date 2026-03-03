# CLI Remote Server Authentication

## Context

The CLI currently embeds the full agent loop, tool schemas, tool executors, and Azure credentials locally. This plan converts it into a thin HTTP client that streams from the Next.js server's `/api/agent` endpoints. Authentication to the server uses either an API key (bearer token) or Entra ID via the OAuth 2.0 authorization code + PKCE flow (browser redirect — device flow is disabled by conditional access policy). A local encrypted config file at `~/.neo/config.json` stores credentials and server settings so the user is not prompted on every run.

---

## Key Design Decisions

- **Authorization code + PKCE, not device flow** — Conditional access blocks device flow. The CLI opens the system browser to the Entra ID authorization URL and starts a local redirect server on a fixed port (e.g. `http://localhost:4000/callback`) to receive the auth code. The Entra ID CLI app registration must include this redirect URI.
- **Dedicated CLI Entra ID app registration** — The CLI uses its own app registration (separate from the web app). This allows the authorization code + PKCE grant to be enabled in isolation and scopes to be configured independently.
- **Encrypted config file at `~/.neo/config.json`** — Sensitive fields (API key, access token, refresh token) are encrypted at rest using AES-256-GCM. The encryption key is derived from a machine-specific fingerprint (OS username + machine hostname) stored nowhere on disk — the same machine can always decrypt its own config, but the file is not portable.
- **`clear` resets local session ID only** — The `clear` REPL command sets the in-memory `sessionId` to `null`; it does not call `DELETE /api/agent/sessions`. The server session expires via its own 30-minute TTL.
- **`@azure/msal-node` for token lifecycle** — MSAL Node handles PKCE, token exchange, silent refresh via cached refresh tokens, and expiry management. This avoids implementing token refresh logic manually.
- **`open` package for browser launch** — Cross-platform browser launch (`open` npm package) is used rather than platform-specific shell commands.
- **Server client is a new standalone module** — All HTTP communication with the server (streaming NDJSON, auth header injection, session ID tracking) lives in `cli/src/server-client.js`. The REPL layer (`index.js`) only calls into this module and the auth modules.
- **Files `tools.js`, `executors.js`, and the old `auth.js` are deleted** — All three are server-side concerns. Keeping them would cause confusion about where execution happens.

---

## Files to Change

| File | Change |
|------|--------|
| `cli/src/index.js` | Replace agent loop imports with server-client imports; add sub-command parsing (`auth login`, `auth logout`, `auth status`); update `clear` to reset local session ID only; remove `DESTRUCTIVE_TOOLS` import; replace `validateConfig()` call with `resolveServerConfig()` |
| `cli/src/config.js` | Replace all server-side env vars with client-side vars (`NEO_SERVER`, `NEO_API_KEY`); replace `validateConfig()` with `resolveServerConfig()` that loads config-store, applies env var overrides, and returns `{ serverUrl, authHeader }` |
| `cli/src/agent.js` | Fully rewrite: replaces embedded Anthropic loop with `runAgentLoop(message, sessionId, callbacks, authHeader)` and `confirmTool(sessionId, tool, confirmed, callbacks, authHeader)` — both delegate to `server-client.js` and process the NDJSON stream |
| `cli/src/auth.js` | Delete — replaced by `auth-entra.js`; Azure client_credentials auth is no longer needed in the CLI |
| `cli/src/tools.js` | Delete — tool schemas live on the server |
| `cli/src/executors.js` | Delete — tool execution is server-side |
| `cli/package.json` | Remove `@anthropic-ai/sdk`; add `@azure/msal-node` and `open` |
| `cli/src/server-client.js` | New file — HTTP client for `/api/agent` and `/api/agent/confirm`; NDJSON stream reader; auth header injection |
| `cli/src/auth-entra.js` | New file — authorization code + PKCE flow; local redirect HTTP server; token exchange; silent refresh via MSAL Node; integration with config-store |
| `cli/src/config-store.js` | New file — read/write `~/.neo/config.json`; AES-256-GCM encryption/decryption of sensitive fields; `chmod 600` on write |

---

## Implementation Steps

### 1. Create `cli/src/config-store.js`

- Define the config file path as `~/.neo/config.json` (using `os.homedir()`).
- On first access, if the file does not exist, return empty defaults: `{ serverUrl: "http://localhost:3000", authMethod: null }`.
- Implement `readConfig()` — read and parse the file; decrypt sensitive fields (`apiKey`, `entraId.accessToken`, `entraId.refreshToken`) using AES-256-GCM before returning.
- Implement `writeConfig(config)` — encrypt sensitive fields, write to disk, set file permissions to `0o600`.
- Derive the encryption key from `crypto.scryptSync(os.userInfo().username + os.hostname(), "neo-cli-v1", 32)`. This is machine-specific and requires no stored key file.
- Create the `~/.neo/` directory if it does not exist before writing.

### 2. Create `cli/src/auth-entra.js`

- On module load, initialise an MSAL `PublicClientApplication` using the CLI app registration's `clientId` and `tenantId` (read from config-store or `NEO_TENANT_ID` / `NEO_CLIENT_ID` env vars).
- Implement `login()`:
  - Generate a PKCE code verifier and code challenge.
  - Start a local HTTP server on port `4000` to listen for the redirect to `http://localhost:4000/callback`.
  - Construct the Entra ID authorization URL with the code challenge, `response_type=code`, and the required scopes (at minimum `openid profile offline_access` plus any scopes the server requires).
  - Open the browser to the authorization URL using the `open` package. Print the URL to the terminal as a fallback in case the browser does not open.
  - Wait for the redirect callback; extract the authorization code from the query string.
  - Shut down the local HTTP server.
  - Exchange the code for tokens via MSAL's `acquireTokenByCode`.
  - Store the resulting access token, refresh token, expiry timestamp, and account details in config-store (encrypted).
  - Print a success message to the terminal.
- Implement `logout()`:
  - Clear `entraId` fields from config-store.
  - Print a confirmation message.
- Implement `getAccessToken()`:
  - Read cached token from config-store.
  - If the access token is valid (expiry - 5 minutes > now), return it.
  - If expired but a refresh token exists, call MSAL's `acquireTokenSilent` with the cached account.
  - Store the refreshed tokens back to config-store.
  - If silent refresh fails (refresh token expired or revoked), throw an error instructing the user to run `neo auth login` again.
- Implement `status()` — return an object with `{ loggedIn: boolean, expiresAt, username }` based on config-store state.

### 3. Create `cli/src/server-client.js`

- Implement `streamMessage(serverUrl, authHeader, sessionId, message, callbacks)`:
  - POST to `<serverUrl>/api/agent` with body `{ message, sessionId }` and the auth header.
  - On `401`, throw a descriptive error telling the user to check their credentials.
  - On `429`, throw a rate limit error.
  - On other non-2xx, throw with the response body text.
  - Read the response body as a `ReadableStream` and process it line by line.
  - For each complete line, parse as JSON and dispatch to callbacks:
    - `session` event → return/store the `sessionId`
    - `thinking` event → call `callbacks.onThinking()`
    - `tool_call` event → call `callbacks.onToolCall(tool, input)`
    - `confirmation_required` event → resolve the stream with `{ type: "confirmation_required", tool, sessionId }`
    - `response` event → resolve the stream with `{ type: "response", text, sessionId }`
    - `error` event → throw with the `message` field (include `code` in the error if present)
- Implement `streamConfirm(serverUrl, authHeader, sessionId, toolId, confirmed, callbacks)`:
  - POST to `<serverUrl>/api/agent/confirm` with body `{ sessionId, toolId, confirmed }` and auth header.
  - Process the NDJSON stream using the same dispatcher as `streamMessage`.

### 4. Rewrite `cli/src/agent.js`

- Import `streamMessage` and `streamConfirm` from `server-client.js`.
- Implement `runAgentLoop(message, sessionId, callbacks, authHeader, serverUrl)`:
  - Call `streamMessage` and return its resolved result (`confirmation_required` or `response`), passing the updated `sessionId` back to the caller.
- Implement `confirmTool(sessionId, tool, confirmed, callbacks, authHeader, serverUrl)`:
  - Call `streamConfirm` with `tool.id` and `confirmed`.
  - Return its resolved result the same way.
- Remove all Anthropic SDK imports, tool schema references, and executor calls.

### 5. Update `cli/src/config.js`

- Remove all server-side env vars (`ANTHROPIC_API_KEY`, `AZURE_*`, `SENTINEL_*`, `MOCK_MODE`).
- Remove `SYSTEM_PROMPT` — this lives on the server.
- Implement `resolveServerConfig()`:
  - Load config-store values for `serverUrl` and `authMethod`.
  - Apply env var overrides: `NEO_SERVER` overrides `serverUrl`; `NEO_API_KEY` forces `authMethod` to `"api-key"` and bypasses config-store key.
  - Apply CLI flag overrides: `--server <url>` and `--api-key <key>` (parse from `process.argv`).
  - If `authMethod` is `"api-key"`: return `{ serverUrl, authHeader: "Bearer <key>" }`.
  - If `authMethod` is `"entra-id"`: call `getAccessToken()` from `auth-entra.js`; return `{ serverUrl, authHeader: "Bearer <token>" }`.
  - If neither is configured, print an error describing how to set up auth and call `process.exit(1)`.

### 6. Update `cli/src/index.js`

- Add sub-command parsing at the top of `main()` before starting the REPL:
  - If `process.argv[2] === "auth"`:
    - `login` → call `login()` from `auth-entra.js`, then exit.
    - `logout` → call `logout()` from `auth-entra.js`, then exit.
    - `status` → print server URL, auth method, and token expiry, then exit.
- Replace `validateConfig()` call with `resolveServerConfig()` and store `{ serverUrl, authHeader }`.
- Pass `serverUrl` and `authHeader` into `runAgentLoop` and `confirmTool` calls.
- Track `sessionId` as a local variable in the REPL loop; update it from the returned value of `runAgentLoop` and `confirmTool`.
- Change the `clear` command to reset `sessionId = null` (no server call).
- Remove import of `DESTRUCTIVE_TOOLS` from `tools.js` (the `⚠️` prefix display in `printToolCall` can remain — check tool name against a hardcoded local set or remove the distinction entirely since the server enforces it).
- Update the confirmation prompt: pass `tool.id` as `toolId` to `confirmTool` (the server requires it for tool ID verification).
- Update error handling: surface the `code` field from stream error events in addition to the message.

### 7. Delete obsolete files

- Delete `cli/src/tools.js`.
- Delete `cli/src/executors.js`.
- Delete `cli/src/auth.js`.

### 8. Update `cli/package.json`

- Remove `@anthropic-ai/sdk` from dependencies.
- Add `@azure/msal-node` for OAuth token lifecycle management.
- Add `open` for cross-platform browser launch.
- Keep `chalk` and `dotenv`.
- Update the `description` field to reflect the client role.

---

## Verification

1. **Config store**: Run `node -e "import('./src/config-store.js').then(m => m.writeConfig({ serverUrl: 'http://localhost:3000', authMethod: 'api-key', apiKey: 'test-key' })).then(() => m.readConfig()).then(console.log)"` from `cli/` — confirm sensitive fields round-trip correctly.
2. **API key auth**: Set `NEO_API_KEY=<valid-key>` in environment; run `npm start`; send a test message — confirm the REPL works and the server returns a response.
3. **Auth sub-commands**: Run `node src/index.js auth status` — confirm it prints current config. Run `node src/index.js auth logout` — confirm it clears the config. (Full Entra ID login requires a configured app registration.)
4. **NDJSON stream**: Confirm thinking indicator, tool call display, and final response all render correctly for a real investigative query.
5. **Confirmation gate**: Trigger a destructive tool (in mock mode on the server); confirm the CLI shows the confirmation prompt; confirm `yes` and `no` both work correctly and the server receives the right `confirmed` value.
6. **clear command**: Send a message to establish a session; type `clear`; send another message — confirm a new session is created (different `sessionId` in the `session` event).
7. **401 handling**: Use an invalid API key; confirm the CLI prints a clear "check your credentials" message and does not crash.
8. **Build check**: `cd cli && npm install && npm start` — confirm startup with no import errors.
