# CLI Remote Server Authentication

## Context

The CLI currently embeds the full agent loop, tool schemas, tool executors, and Azure credentials locally. This plan converts it into a thin HTTP client that streams from the Next.js server's `/api/agent` endpoints. Authentication to the server uses either an API key (bearer token) or Entra ID via the OAuth 2.0 authorization code + PKCE flow (browser redirect — device flow is disabled by conditional access policy), implemented with direct HTTP calls to the Microsoft identity platform with no third-party auth library. No new app registration is needed — the existing Entra ID app registration is extended with a public client redirect URI. A local encrypted config file at `~/.neo/config.json` stores credentials and server settings so the user is not prompted on every run.

---

## Key Design Decisions

- **Authorization code + PKCE, not device flow** — Conditional access blocks device flow. The CLI opens the system browser to the Entra ID authorization URL and starts a local redirect server on port `4000` (`http://localhost:4000/callback`) to receive the auth code. This is the same interactive login pattern used by the official `az` CLI.
- **Extend existing app registration, no new registration** — Rather than creating a separate CLI app registration, the existing Entra ID app registration gains a "Mobile and desktop applications" (public client) redirect URI of `http://localhost:4000/callback`. Public client flows do not require a client secret, so no secret needs to be stored or managed.
- **No third-party auth library — direct HTTP calls only** — PKCE code verifier and challenge are generated using Node.js built-in `crypto`. The authorization redirect, token exchange, and silent token refresh all use Node.js built-in `fetch` against the Microsoft identity platform endpoints (`https://login.microsoftonline.com/<tenantId>/oauth2/v2.0/authorize` and `/token`). The local redirect listener uses Node.js built-in `http`. This mirrors the approach used by lightweight CLI tools that avoid library dependencies for auth.
- **`tenantId` and `clientId` are non-secret config values** — They are stored in the config file unencrypted. Only the access token and refresh token require encryption.
- **Encrypted config file at `~/.neo/config.json`** — Sensitive fields (API key, access token, refresh token) are encrypted at rest using AES-256-GCM. The encryption key is derived from a machine-specific fingerprint (OS username + machine hostname) using `crypto.scryptSync` — stored nowhere on disk, the same machine can always decrypt its own config but the file is not portable.
- **`clear` resets local session ID only** — The `clear` REPL command sets the in-memory `sessionId` to `null`; it does not call `DELETE /api/agent/sessions`. The server session expires via its own 30-minute TTL.
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
| `cli/package.json` | Remove `@anthropic-ai/sdk`; add `open` for browser launch; no auth library needed |
| `cli/src/server-client.js` | New file — HTTP client for `/api/agent` and `/api/agent/confirm`; NDJSON stream reader; auth header injection |
| `cli/src/auth-entra.js` | New file — authorization code + PKCE flow; local redirect HTTP server; token exchange; silent refresh via MSAL Node; integration with config-store |
| `cli/src/config-store.js` | New file — read/write `~/.neo/config.json`; AES-256-GCM encryption/decryption of sensitive fields; `chmod 600` on write |

---

## Implementation Steps

### 1. Configure the existing Entra ID app registration (one-time prerequisite)

- In the Azure portal, open the existing Neo app registration.
- Under **Authentication → Add a platform**, choose **Mobile and desktop applications**.
- Add `http://localhost:4000/callback` as a redirect URI.
- Ensure **Allow public client flows** is set to **Yes** (this enables the authorization code + PKCE flow without a client secret for this redirect URI).
- No new app registration, no client secret. The existing `clientId` and `tenantId` are the only values the CLI needs (both non-secret and safe to store in the config file unencrypted).

### 2. Create `cli/src/config-store.js`

- Define the config file path as `~/.neo/config.json` (using `os.homedir()`).
- On first access, if the file does not exist, return empty defaults: `{ serverUrl: "http://localhost:3000", authMethod: null }`.
- Implement `readConfig()` — read and parse the file; decrypt sensitive fields (`apiKey`, `entraId.accessToken`, `entraId.refreshToken`) using AES-256-GCM before returning.
- Implement `writeConfig(config)` — encrypt sensitive fields, write to disk, set file permissions to `0o600`.
- Derive the encryption key from `crypto.scryptSync(os.userInfo().username + os.hostname(), "neo-cli-v1", 32)`. This is machine-specific and requires no stored key file.
- Create the `~/.neo/` directory if it does not exist before writing.

### 3. Create `cli/src/auth-entra.js`

All OAuth operations use Node.js built-ins only (`crypto`, `http`, `fetch`). Read `tenantId` and `clientId` from config-store or `NEO_TENANT_ID` / `NEO_CLIENT_ID` env vars. The base URLs are `https://login.microsoftonline.com/<tenantId>/oauth2/v2.0/authorize` and `.../token`.

- Implement `login()`:
  - Generate a PKCE code verifier: 32 random bytes from `crypto.randomBytes`, base64url-encoded.
  - Derive the code challenge: SHA-256 hash of the verifier, base64url-encoded, using `crypto.createHash`.
  - Generate a `state` nonce with `crypto.randomBytes` to prevent CSRF on the callback.
  - Start a Node.js `http.createServer` on port `4000`. The server waits for one `GET /callback` request, extracts `code` and `state` from the query string, validates `state` matches, sends a plain-text "Login successful — you can close this tab." response, and closes itself.
  - Construct the authorization URL with parameters: `client_id`, `response_type=code`, `redirect_uri=http://localhost:4000/callback`, `scope=openid profile offline_access`, `code_challenge`, `code_challenge_method=S256`, `state`.
  - Attempt to open the URL in the default browser using the `open` package. Always print the URL to the terminal as a fallback.
  - Await the callback server's `code` promise (with a 5-minute timeout; if exceeded, close the server and throw an error telling the user to retry).
  - Exchange the code: POST to the token endpoint with `grant_type=authorization_code`, `client_id`, `code`, `redirect_uri`, `code_verifier` using `fetch` with `Content-Type: application/x-www-form-urlencoded`.
  - Parse the token response; extract `access_token`, `refresh_token`, `expires_in`, and the `preferred_username` / `name` claim from the decoded ID token (base64url-decode the JWT middle segment, no signature verification needed for display purposes).
  - Store access token, refresh token, expiry timestamp (`Date.now() + expires_in * 1000`), and display name in config-store (access and refresh tokens encrypted).
  - Print a success message including the logged-in username.
- Implement `logout()`:
  - Clear all `entraId` fields from config-store using `writeConfig`.
  - Print a confirmation message.
- Implement `getAccessToken()`:
  - Read cached token state from config-store.
  - If the access token expiry minus 5 minutes is still in the future, return the cached access token immediately.
  - If a refresh token is present, POST to the token endpoint with `grant_type=refresh_token`, `client_id`, `refresh_token` using `fetch`.
  - On success, parse the new tokens, update config-store, and return the new access token.
  - On failure (refresh token expired, revoked, or endpoint error), throw an error instructing the user to run `node src/index.js auth login` again.
- Implement `status()` — read config-store and return `{ loggedIn: boolean, expiresAt: Date | null, username: string | null }` based on whether a cached access token exists and whether it is still valid.

### 4. Create `cli/src/server-client.js`

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

### 5. Rewrite `cli/src/agent.js`

- Import `streamMessage` and `streamConfirm` from `server-client.js`.
- Implement `runAgentLoop(message, sessionId, callbacks, authHeader, serverUrl)`:
  - Call `streamMessage` and return its resolved result (`confirmation_required` or `response`), passing the updated `sessionId` back to the caller.
- Implement `confirmTool(sessionId, tool, confirmed, callbacks, authHeader, serverUrl)`:
  - Call `streamConfirm` with `tool.id` and `confirmed`.
  - Return its resolved result the same way.
- Remove all Anthropic SDK imports, tool schema references, and executor calls.

### 6. Update `cli/src/config.js`

- Remove all server-side env vars (`ANTHROPIC_API_KEY`, `AZURE_*`, `SENTINEL_*`, `MOCK_MODE`).
- Remove `SYSTEM_PROMPT` — this lives on the server.
- Implement `resolveServerConfig()`:
  - Load config-store values for `serverUrl` and `authMethod`.
  - Apply env var overrides: `NEO_SERVER` overrides `serverUrl`; `NEO_API_KEY` forces `authMethod` to `"api-key"` and bypasses config-store key.
  - Apply CLI flag overrides: `--server <url>` and `--api-key <key>` (parse from `process.argv`).
  - If `authMethod` is `"api-key"`: return `{ serverUrl, authHeader: "Bearer <key>" }`.
  - If `authMethod` is `"entra-id"`: call `getAccessToken()` from `auth-entra.js`; return `{ serverUrl, authHeader: "Bearer <token>" }`.
  - If neither is configured, print an error describing how to set up auth and call `process.exit(1)`.

### 7. Update `cli/src/index.js`

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

### 8. Delete obsolete files

- Delete `cli/src/tools.js`.
- Delete `cli/src/executors.js`.
- Delete `cli/src/auth.js`.

### 9. Update `cli/package.json`

- Remove `@anthropic-ai/sdk` from dependencies.
- Add `open` for cross-platform browser launch.
- Keep `chalk` and `dotenv`.
- Update the `description` field to reflect the client role.
- No auth library required — all OAuth logic uses Node.js built-ins.

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
