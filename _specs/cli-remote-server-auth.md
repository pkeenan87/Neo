# CLI Remote Server Authentication

> Modify the existing CLI tool to act as a remote client for the Next.js web server rather than calling the Anthropic and Azure APIs directly. The CLI authenticates with the server using either an API key (bearer token) or Entra ID (OAuth device authorization flow) and communicates with the server over HTTP, consuming NDJSON-streamed responses.

## Problem

The current CLI embeds the full agent loop, tool executors, Azure credentials, and the Anthropic API key locally. Now that the Next.js server provides a secured, authenticated API layer, the CLI should delegate all agent execution to the server. This removes the need for each CLI user to hold their own Azure credentials and API keys, centralises rate limiting and access control, and ensures the same permission model (Reader/Admin) applies to both CLI and web clients.

## Goals

- Replace the embedded agent loop with HTTP calls to the Next.js server's `/api/agent`, `/api/agent/confirm`, and `/api/agent/sessions` endpoints
- Support two authentication methods: **API key** (bearer token) and **Entra ID** (OAuth 2.0 device authorization flow)
- Make the server URL configurable, defaulting to `http://localhost:3000`
- Preserve the existing REPL experience — the same banner, prompts, tool display, confirmation gate, and `clear`/`exit` commands
- Store authentication credentials and server URL in a local config file so the user does not re-authenticate on every run

## Non-Goals

- Running the agent loop or tool executors locally (these move entirely to the server)
- Supporting auth methods beyond API key and Entra ID device flow
- Building a full auth UI or web-based login for the CLI
- Changing the server-side implementation (this spec is CLI-only)
- Multi-server or load-balanced client configurations

## User Stories

1. **As a CLI user with an API key**, I can run the CLI and have my key sent automatically as a bearer token on every request without being prompted each time.
2. **As a CLI user with an Entra ID account**, I can run `neo auth login` to initiate the device authorization flow, open the given URL in my browser, complete sign-in, and have my token cached locally for subsequent runs.
3. **As any authenticated CLI user**, I see the same REPL experience — thinking indicator, tool call display, confirmation prompts for destructive tools, and final responses — driven by the server's NDJSON stream.
4. **As a CLI user**, I can set the server URL via a flag, environment variable, or config file so I can point the CLI at a staging or production server without code changes.
5. **As a CLI user**, typing `clear` resets the session on the server and starts a new conversation.
6. **As an unauthenticated CLI user**, I receive a clear error message telling me to run `neo auth login` or set an API key before the agent can be used.

## Proposed Architecture

### Authentication

**API Key**
- Stored in the local config file or the `NEO_API_KEY` environment variable
- Sent as an `Authorization: Bearer <key>` header on every request
- No token refresh needed — keys are long-lived

**Entra ID (Device Authorization Flow)**
- The CLI initiates the OAuth 2.0 device authorization flow against the Entra ID tenant configured in the local config file or `NEO_TENANT_ID` / `NEO_CLIENT_ID` env vars
- The user is shown a device code and URL, opens the URL in a browser, completes sign-in, and the CLI polls for the token
- The resulting access token (and refresh token) are cached in the local config file
- On subsequent runs, the cached token is used; if expired, the refresh token is used to obtain a new access token silently
- If the refresh token is also expired, the user is prompted to run `neo auth login` again

### Configuration

A local config file (e.g., `~/.neo/config.json`) stores:
- `serverUrl` — defaults to `http://localhost:3000`
- `authMethod` — `"api-key"` or `"entra-id"`
- `apiKey` — stored only when `authMethod` is `"api-key"`
- `entraId.tenantId`, `entraId.clientId` — Entra ID app registration details
- `entraId.accessToken`, `entraId.refreshToken`, `entraId.expiresAt` — cached token state

Environment variables (`NEO_SERVER`, `NEO_API_KEY`, `NEO_TENANT_ID`, `NEO_CLIENT_ID`) override the config file.
CLI flags (`--server`, `--api-key`) override both.

### REPL and Session Management

- The REPL loop is preserved — same readline interface, banner, prompts, and display helpers
- Each conversation holds a `sessionId` returned by the server on the first `/api/agent` call
- The session ID is included in every subsequent request in the same conversation
- `clear` sends a `DELETE /api/agent/sessions` request to terminate the server session, then resets the local `sessionId`
- `exit` terminates the CLI without explicitly deleting the server session (the server TTL cleans it up)

### NDJSON Stream Handling

The CLI consumes the server's NDJSON stream and maps events to existing display functions:

| Server event | CLI action |
|---|---|
| `session` | Store the `sessionId` for the conversation |
| `thinking` | Show the existing thinking indicator |
| `tool_call` | Call the existing `printToolCall()` display function |
| `confirmation_required` | Invoke the existing confirmation prompt, then POST to `/api/agent/confirm` |
| `response` | Call the existing `printResponse()` display function |
| `error` | Print the error and, if a `code` field is present, give a contextual hint |

### CLI Commands

The existing entry point (`npm start` / `node src/index.js`) remains the primary REPL. A lightweight sub-command layer is added for auth management:

- `neo auth login` — initiate the Entra ID device flow or prompt for an API key and save to config
- `neo auth logout` — clear cached credentials from the config file
- `neo auth status` — show the current auth method, server URL, and token validity

### Dependency Changes

- Remove: `@anthropic-ai/sdk`, Azure auth imports from `config.js` and `auth.js`
- Add: an HTTP client for NDJSON streaming (Node.js built-in `fetch` with `ReadableStream` is sufficient)
- Optionally add: `@azure/identity` or a lightweight MSAL package for the device auth flow token lifecycle (if not handled via direct HTTP calls to the token endpoint)

## Open Questions

- Should the Entra ID client ID for the device flow be a dedicated CLI app registration in Entra ID, separate from the web app registration? A dedicated CLI registration is standard practice and allows the device flow grant type to be enabled without affecting the web app.
- Should the config file be encrypted at rest, or is filesystem permissions (chmod 600) sufficient for the token cache?
- Should `clear` delete the server session immediately, or just reset the local session ID (letting the server TTL expire it)?

## Success Criteria

- [ ] `npm start` in `cli/` starts the REPL and connects to the configured server URL
- [ ] API key auth: bearer token is sent on every request and a `401` from the server shows a clear "check your API key" message
- [ ] Entra ID auth: `neo auth login` completes the device flow and caches the token; subsequent runs use the cached token without prompting
- [ ] The server URL is configurable via config file, `NEO_SERVER` env var, or `--server` flag
- [ ] The REPL experience (banner, prompts, tool display, confirmation gate, responses) is unchanged from the user's perspective
- [ ] `clear` resets the conversation and starts a new server session
- [ ] The CLI no longer contains any Anthropic API key, Azure credential, or tool executor code
