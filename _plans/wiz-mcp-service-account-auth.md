# Wiz MCP Service Account Authentication

## Context

Replace the static `WIZ_MCP_TOKEN` bearer with a service-account OAuth2 client-credentials flow against the operator-configured Wiz auth URL (typically `https://auth.app.wiz.io/oauth/token` for this tenant, or `https://auth.wiz.io/oauth/token` for other Wiz deployments), using `WIZ_CLIENT_ID` + `WIZ_CLIENT_SECRET` configured via the existing integrations admin UI. Default the MCP URL to Wiz's hosted endpoint (`https://mcp.app.wiz.io`) and capture `WIZ_API_URL` (e.g. `https://api.us68.app.wiz.io/graphql`) for the upcoming non-MCP path and for tenant-data-center attribution in audit events. Wiz issued the new service-account auth scheme after PR #55 landed; the old bearer secret rotates infrequently and is being phased out in favour of OAuth tokens with short TTLs.

**Wiz MCP server accepts `Authorization: Bearer` tokens — confirmed.** The reference helper at https://github.com/justinb-dfw/claude-wiz-mcp/ implements the user-interactive PKCE flow (`/oauth2/register` → `/oauth2/authorize` → `/oauth2/token` on `mcp.app.wiz.io`) and writes the resulting `access_token` to disk for the desktop MCP client to send on every request. That tells us the MCP server validates an OAuth bearer on the standard `Authorization` header, so Anthropic's API-side `authorization_token` field is compatible. The desktop helper isn't directly reusable — it's an interactive user flow that needs a browser, a localhost callback, and a refresh-token store — but it pins down the wire shape.

**Three Wiz auth surfaces exist; pick the right one:**

| Flow | Endpoints | Who uses it |
|------|-----------|-------------|
| User OAuth (PKCE + authorization_code) | `mcp.app.wiz.io/oauth2/{register,authorize,token}` | Claude Code CLI desktop client (the reference Python helper) |
| Service-account OAuth (client_credentials) | `auth.app.wiz.io/oauth/token` (this tenant) / `auth.wiz.io/oauth/token` (others) | **Neo (this plan)** |
| Service-account direct headers | `Wiz-Client-Id` / `Wiz-Client-Secret` / `Wiz-DataCenter` on each MCP request | Claude Code "service account" mode — works only because Claude Code injects the headers client-side. **Not usable from Neo** because Anthropic's API-side MCP connector doesn't forward arbitrary headers. |

**Service-account body shape — confirmed.** The published `mcp-server-wiz` npm package (consumed by the reference bash launcher at https://github.com/justinb-dfw/claude-wiz-mcp/ and documented in https://mernstackdev.com/wiz-mcp-server-complete-guide-to-cloud-security-automation/) issues the token request as:

```
POST <WIZ_AUTH_URL>
Content-Type: application/json

{
  "grant_type": "client_credentials",
  "client_id": "<WIZ_CLIENT_ID>",
  "client_secret": "<WIZ_CLIENT_SECRET>",
  "audience": "wiz-api"
}
```

Response is RFC 6749 standard: `{ access_token, expires_in, token_type }`. `client_secret` goes in the JSON body, not in HTTP Basic. The auth URL is treated as **operator-configurable** (the reference bash script reads `auth:` from `~/.wiz-token`) because the host varies across Wiz tenants — Neo follows the same shape with a `WIZ_AUTH_URL` env var, no hardcoded default. The Wiz host allowlist regex (`/^[a-z0-9][a-z0-9.-]*\.wiz\.io$/i`) gates both the MCP URL and the auth URL so an operator-supplied value can never redirect credentials to an attacker-controlled host.

---

## Key Design Decisions

- **OAuth2 client_credentials with in-memory token cache**, mirroring `web/lib/auth.ts`'s `getAzureToken`. Bearer is refreshed on cache miss or near-expiry (5-min safety buffer). Cache key is `sha256(client_id + ":" + client_secret).slice(0, 16)` so credential rotation invalidates cleanly.
- **Env var naming matches the upstream `mcp-server-wiz` package** so operators with prior Wiz tooling don't have to learn second names. The full set: `WIZ_CLIENT_ID`, `WIZ_CLIENT_SECRET`, `WIZ_AUTH_URL`, `WIZ_API_URL`, `WIZ_MCP_URL`. `WIZ_API_URL` is required for upcoming direct GraphQL calls and used for audit-event tenant tagging today (the data-center label, e.g. `us68`, is parsed from it on demand). `WIZ_MCP_URL` is optional with default `https://mcp.app.wiz.io`. `WIZ_AUTH_URL` has no default — it's tenant-variable (the article example uses `auth.wiz.io`; this tenant uses `auth.app.wiz.io`).
- **`WIZ_MCP_TOKEN` is deprecated, not deleted** — read on a fallback path with a one-time deprecation warning so an in-flight rollout has a graceful migration window.
- **Wiz host allowlist regex stays** (`/^[a-z0-9][a-z0-9.-]*\.wiz\.io$/i`) and is applied to BOTH the MCP URL and the auth URL. An operator-misconfigured `WIZ_AUTH_URL` redirects credentials just as effectively as a bad `WIZ_MCP_URL`; the guard is identical.
- **OAuth helper lives in a new file `web/lib/wiz-auth.ts`**, not bolted onto `auth.ts`. Azure and Wiz are different identity providers with different token endpoints, body shapes (Azure uses `application/x-www-form-urlencoded`, Wiz uses `application/json`), and error envelopes. Both files follow the same cache-and-refresh pattern so the code looks familiar.
- **Probe verifies OAuth, not just MCP reachability.** The current probe sends an OPTIONS to the MCP URL with the static token. The new probe runs the OAuth client_credentials exchange (catching auth failures explicitly) and *then* OPTIONS the MCP URL with the resulting bearer. An invalid `client_id`/`secret` surfaces as a 401 from the token endpoint with Wiz's structured error JSON, which the admin UI relays verbatim.
- **Data-center label is derived, not configured.** Parse the subdomain from `WIZ_API_URL` (e.g. `us68` from `api.us68.app.wiz.io`) on demand for audit-event tagging. Avoids a separate `WIZ_DATACENTER` secret that operators have to keep in sync with the API URL.
- **Backward compatibility window**: if `WIZ_CLIENT_ID` and `WIZ_CLIENT_SECRET` are both unset but `WIZ_MCP_TOKEN` is set, fall through to the old code path. Emit a one-time deprecation warn at startup (suppressed in tests). Remove the fallback after one release (~2 weeks) once operators have migrated.

---

## Files to Change

| File | Change |
|------|--------|
| `web/lib/wiz-auth.ts` | **NEW.** `getWizAccessToken()` — OAuth2 client_credentials flow against the operator-supplied `WIZ_AUTH_URL`. JSON body per the confirmed Wiz contract: `{ grant_type, client_id, client_secret, audience: "wiz-api" }`. In-memory cache keyed by sha256 of credential pair (sliced to 16 hex chars), 5-min expiry buffer, structured logging with token expiry, `AbortSignal.timeout(10_000)`, `redirect: "error"`. `clearWizTokenCache()` for credential rotation. `getWizDatacenter()` helper parses `us68` from `WIZ_API_URL` for audit tagging. |
| `web/lib/mcp-servers.ts` | Rewrite `WIZ_ENTRY.getToken()` to call `getWizAccessToken()` (Wiz OAuth) instead of `getToolSecret("WIZ_MCP_TOKEN")`. Rewrite `getUrl()` to return `getToolSecret("WIZ_MCP_URL")` OR default `https://mcp.app.wiz.io`. Add fallback to legacy `WIZ_MCP_TOKEN` when new creds absent. Apply `WIZ_ALLOWED_HOST_RE` to BOTH the MCP URL and the auth URL (route the latter through a one-shot validation when the helper is invoked). |
| `web/lib/config.ts` | Add `WIZ_CLIENT_ID`, `WIZ_CLIENT_SECRET`, `WIZ_AUTH_URL`, `WIZ_API_URL` to the `env` object and `EnvConfig` type. Keep `WIZ_MCP_URL` and `WIZ_MCP_TOKEN` for fallback. Extend `validateConfig` to warn (not throw) when `WIZ_AUTH_URL` or `WIZ_API_URL` fails the host allowlist regex. |
| `web/lib/types.ts` | Add `WIZ_CLIENT_ID`, `WIZ_CLIENT_SECRET`, `WIZ_AUTH_URL`, `WIZ_API_URL` to `EnvConfig`. |
| `web/app/api/integrations/[slug]/test/route.ts` | Replace `"wiz"` probe body: read `WIZ_CLIENT_ID`/`SECRET`/`AUTH_URL`/`API_URL` (fall back to `WIZ_MCP_TOKEN` if creds absent), exchange for a bearer via `getWizAccessToken`, then OPTIONS `WIZ_MCP_URL` with the bearer. Distinguish OAuth failures (401 from token endpoint) from MCP failures (401 from MCP URL) in the user-facing error string. Apply host allowlist to the auth URL before the exchange. |
| `web/lib/integration-registry.ts` | Update the `"wiz"` entry's `secrets` array: replace `WIZ_MCP_TOKEN` with `WIZ_CLIENT_ID` (required), `WIZ_CLIENT_SECRET` (required), `WIZ_AUTH_URL` (required, no default), `WIZ_API_URL` (required). Mark `WIZ_MCP_URL` as optional with `https://mcp.app.wiz.io` as the documented default. Update labels and descriptions to reference Wiz Service Account setup. |
| `.env.example` | Remove `WIZ_MCP_TOKEN` example. Add `WIZ_CLIENT_ID`, `WIZ_CLIENT_SECRET`, `WIZ_AUTH_URL`, `WIZ_API_URL`. Note the default URL and that `WIZ_MCP_URL` is optional. Include the tenant example (`auth.app.wiz.io` / `api.us68.app.wiz.io/graphql`) and a generic example (`auth.wiz.io`). |
| `docs/configuration.md` | Update the Wiz section: new creds, link to Wiz Service Account docs, OAuth flow diagram, migration note. |
| `web/lib/logger.ts` | Add `wizDatacenter`, `wizTokenExpiry` to `SAFE_METADATA_FIELDS` (low-cardinality, no PII). |
| `web/test/wiz-auth.test.ts` | **NEW.** Unit tests for `getWizAccessToken`: cache hit/miss, expiry refresh, OAuth-endpoint 401 surfacing, fetch timeout, auth-URL host-allowlist rejection. Mock `fetch` directly. Tests for `getWizDatacenter` parsing (`us68` from `api.us68.app.wiz.io/graphql`, undefined when URL absent or unparseable). |
| `web/test/mcp-servers.test.ts` | Update fixtures: set `WIZ_CLIENT_ID`/`SECRET`/`AUTH_URL`/`API_URL` instead of `WIZ_MCP_TOKEN`. Mock `getWizAccessToken` to return a stub token. Add a backward-compat test (legacy `WIZ_MCP_TOKEN`-only env still works, emits deprecation warn). |
| `web/test/wiz-probe.test.ts` | Update probe tests: mock token endpoint + MCP OPTIONS, assert distinct error messages for OAuth-401 vs MCP-401. Add cases for missing client_id, missing secret, malformed auth URL, malformed API URL. |
| `web/test/integration-registry.test.ts` (if exists) | Update the Wiz entry assertions to reflect the new secrets list. |
| `_specs/wiz-mcp-server-integration.md` | Append a "v2 — service-account auth" subsection summarizing the migration. Don't rewrite history. |

---

## Implementation Steps

### 1. Pre-flight (no longer blocking)

The contract is resolved — see the **Context** section for the confirmed body shape and references. Record the contract in a comment block at the top of the new `wiz-auth.ts` file so future maintainers don't have to re-derive it (cite the article URL and the reference repo's bash launcher). If Wiz updates the contract before this lands, fix it once at the helper and the rest of the plan is unaffected.

### 2. Add the OAuth helper (`web/lib/wiz-auth.ts`)

- New module with exports: `getWizAccessToken(): Promise<string>`, `clearWizTokenCache(): void`, `getWizDatacenter(): Promise<string | undefined>`.
- `getWizAccessToken`: read `WIZ_CLIENT_ID`, `WIZ_CLIENT_SECRET`, `WIZ_AUTH_URL` via `getToolSecret`. If any of the three is missing, throw `Error("Missing Wiz service account configuration. Configure WIZ_CLIENT_ID, WIZ_CLIENT_SECRET, and WIZ_AUTH_URL via /integrations or env vars.")`.
- Parse `WIZ_AUTH_URL`. Reject (throw) if protocol isn't `https:` or hostname doesn't match `WIZ_ALLOWED_HOST_RE`. Same guard as the MCP URL — credentials in transit deserve the same protection.
- In-memory `Map<string, { token: string; expiresAt: number }>` keyed by `sha256(client_id + ":" + client_secret).slice(0, 16)` so credential rotation produces a different key and the old cache entry is GC'd naturally.
- `fetch` POSTs `application/json` body to the parsed `WIZ_AUTH_URL` with `{ "grant_type": "client_credentials", "client_id": <id>, "client_secret": <secret>, "audience": "wiz-api" }`. Set `signal: AbortSignal.timeout(10_000)` and `redirect: "error"` per the codebase convention.
- On non-2xx, surface `Wiz OAuth token request failed (HTTP <status>): <body slice 0..500>`. On 2xx, parse JSON, store `{ token: access_token, expiresAt: Date.now() + expires_in*1000 - 5*60*1000 }`, and return the token.
- `logger.info` on cache miss (with `wizDatacenter`, no secrets), `logger.warn` on token-endpoint 401 (so credential rotation oversights surface in Event Hub).
- `getWizDatacenter`: read `WIZ_API_URL` via `getToolSecret`, parse the hostname, return the second label (e.g. `us68` from `api.us68.app.wiz.io`). Return `undefined` if the URL is missing, unparseable, or the hostname doesn't fit the `api.<dc>.app.wiz.io` shape (with a debug log so the audit-tagging miss is investigable but doesn't spam).

### 3. Wire the helper into the MCP registry

- In `web/lib/mcp-servers.ts`, change `WIZ_ENTRY.getToken` to:
  - If `env.MOCK_MODE` → return `undefined` (unchanged).
  - If `WIZ_CLIENT_ID` AND `WIZ_CLIENT_SECRET` both resolve via `getToolSecret` → call `getWizAccessToken()` and return the bearer.
  - Else if legacy `WIZ_MCP_TOKEN` resolves → return it AND `logger.warn` once-per-process (`emittedLegacyTokenDeprecation` boolean) with message `Wiz integration is using the deprecated WIZ_MCP_TOKEN bearer. Migrate to WIZ_CLIENT_ID + WIZ_CLIENT_SECRET (service-account OAuth). See docs/configuration.md`.
  - Else → return `undefined` (quiet degradation, matches today's behaviour).
- Change `WIZ_ENTRY.getUrl` to return `(await getToolSecret("WIZ_MCP_URL")) ?? "https://mcp.app.wiz.io"` (so unset URL is no longer a degradation case — Wiz's hosted endpoint is the default).
- Leave the host-allowlist check at the call site as-is; the default URL passes it (`mcp.app.wiz.io` ends in `.wiz.io`).

### 4. Update env + types

- `web/lib/types.ts`: add `WIZ_CLIENT_ID: string | undefined`, `WIZ_CLIENT_SECRET: string | undefined`, `WIZ_AUTH_URL: string | undefined`, `WIZ_API_URL: string | undefined` to `EnvConfig`.
- `web/lib/config.ts`: add the four to the `env` object (read from `process.env`). Add a soft-validation block under the existing `WIZ_MCP_URL` warn: if `WIZ_AUTH_URL` is set, validate `https://` + `WIZ_ALLOWED_HOST_RE` host match and warn (don't throw) on mismatch. Same for `WIZ_API_URL`. (Hard rejection happens at request-time in `wiz-auth.ts` and `mcp-servers.ts`; the boot warn just surfaces operator typos early.)

### 5. Update the admin probe (`web/app/api/integrations/[slug]/test/route.ts`)

- Rewrite the `"wiz"` probe body:
  1. Read `WIZ_CLIENT_ID`, `WIZ_CLIENT_SECRET`, `WIZ_DATACENTER` via `getToolSecret`.
  2. If any required cred missing, throw with a precise message naming which one.
  3. Call `getWizAccessToken()`. Catch errors and rethrow with `Wiz authentication failed: <original message>` so the admin UI distinguishes "auth failed" from "MCP unreachable".
  4. Resolve the MCP URL with the same default-and-allowlist logic as the runtime path.
  5. OPTIONS the MCP URL with `Authorization: Bearer <token>`, same `redirect: "error"` and `AbortSignal.timeout(10_000)` as today, same 401/403/5xx triage.
- Keep the legacy-token fallback so admins mid-migration don't get false negatives.

### 6. Update the integration registry

- In `web/lib/integration-registry.ts`, find the `"wiz"` entry. Replace the `secrets` array:
  - `WIZ_CLIENT_ID` (required, label `"Client ID"`, description names "Wiz Service Account").
  - `WIZ_CLIENT_SECRET` (required, label `"Client Secret"`, description names rotation cadence).
  - `WIZ_AUTH_URL` (required, label `"Auth URL"`, description gives both example values — `https://auth.app.wiz.io/oauth/token` and `https://auth.wiz.io/oauth/token` — and points operators at the Wiz Service Account setup page where the correct value is shown).
  - `WIZ_API_URL` (required, label `"API URL"`, description gives the example `https://api.us68.app.wiz.io/graphql` and notes that the data-center label is parsed from this for audit tagging).
  - `WIZ_MCP_URL` (optional, description states the default `https://mcp.app.wiz.io`).
- Do NOT remove `WIZ_MCP_TOKEN` from the UI yet (operators in mid-migration still need to clear it after rotating to the new creds). Mark it `required: false` and add a description noting deprecation.

### 7. Update logger allowlist

- In `web/lib/logger.ts`, append `wizDatacenter` and `wizTokenExpiry` to `SAFE_METADATA_FIELDS`. These are low-cardinality observability fields, no PII.

### 8. Tests

- **`web/test/wiz-auth.test.ts`** (new): cache hit, cache miss, near-expiry refresh, 401 from token endpoint (surface error), 5xx from token endpoint (surface error), missing client_id (throw before fetch), abort-signal timeout, cache invalidation when secret rotates (different cache key).
- **`web/test/mcp-servers.test.ts`**: update beforeEach to set `WIZ_CLIENT_ID`/`SECRET` in the `secretsState` mock. Mock `getWizAccessToken` to return `"stub-token"`. Add new test: "falls back to WIZ_MCP_TOKEN with a deprecation warn when new creds absent" — assert `warnSpy` called once with the migration message.
- **`web/test/wiz-probe.test.ts`**: mock both the token-endpoint fetch and the MCP-OPTIONS fetch. Assert distinct error messages for "token endpoint 401" vs "MCP 401". Add cases for missing client_id, missing secret, malformed datacenter (passes through but logs warn).
- **Integration smoke** (manual, not automated): on a dev branch with real `WIZ_CLIENT_ID`/`SECRET`/`DATACENTER` configured in Key Vault, run `/integrations` Test Connection on Wiz and confirm green. Then send a chat message that triggers a Wiz tool call (e.g. "show me the latest critical Wiz issues") and confirm the agent loop returns data.

### 9. Documentation

- `.env.example`: replace `WIZ_MCP_TOKEN` with the three new vars. Add a comment block explaining the OAuth flow and pointing to `docs/configuration.md`.
- `docs/configuration.md`: in the Wiz section, add a "Service Account Authentication" subsection. Diagram the OAuth flow (Neo → `auth.app.wiz.io/oauth/token` → bearer → `mcp.app.wiz.io`). Note the deprecation window for `WIZ_MCP_TOKEN`. Link to the Wiz service-account docs.
- `_specs/wiz-mcp-server-integration.md`: append a brief "v2 auth migration" subsection at the end, summarising the change and the migration window.

### 10. Migration sequencing (rollout-only, not code)

- **Pre-deploy**: operator creates a Wiz service account in the Wiz portal, captures `Client ID`, `Client Secret`, `Data Center`. Stores them in Key Vault under `wiz-client-id`, `wiz-client-secret`, `wiz-datacenter`.
- **Deploy**: this PR lands. Old `WIZ_MCP_TOKEN` still works (fallback path).
- **Cutover**: operator confirms `/integrations` Test Connection passes on Wiz with the new creds. Then deletes `wiz-mcp-token` from Key Vault. Confirms a chat-side Wiz query still succeeds.
- **Cleanup (next release)**: remove the legacy fallback in `mcp-servers.ts` and the deprecation warn. Remove `WIZ_MCP_TOKEN` from `env`/`EnvConfig`/`.env.example`/`integration-registry.ts`.

---

## Verification

1. `cd web && npm run typecheck` — must pass with zero errors.
2. `cd web && npm run lint` — must pass with zero new warnings.
3. `cd web && npm test` — all 639+ tests pass; the new `wiz-auth.test.ts` adds coverage; `mcp-servers.test.ts` and `wiz-probe.test.ts` reflect the new auth shape and the legacy fallback.
4. **Manual probe test** in a dev environment: set `WIZ_CLIENT_ID`/`WIZ_CLIENT_SECRET`/`WIZ_DATACENTER` in `.env`, leave `WIZ_MCP_TOKEN` unset, run `npm run dev`, open `/integrations`, click Test Connection on Wiz. Expect green; expect the dev console to show the OAuth POST to `auth.app.wiz.io` and the subsequent OPTIONS to `mcp.app.wiz.io`.
5. **Manual deprecation test**: clear the new creds, set only `WIZ_MCP_TOKEN`, restart the dev server. Test Connection still passes. The server logs a single deprecation warn naming the env vars to migrate.
6. **Manual fail test**: set `WIZ_CLIENT_ID` but corrupt `WIZ_CLIENT_SECRET`. Test Connection returns `Wiz authentication failed (HTTP 401): <Wiz error body>` — NOT a generic "connection failed". Confirms OAuth failures surface distinctly from MCP failures.
7. **End-to-end smoke**: in chat, ask "show me the latest critical Wiz issues" and confirm the agent calls `wiz_get_issues` and returns real data, with the `mcp_invocation` Event Hub record now showing `wizDatacenter: "us68"` in metadata (per the logger allowlist extension).
