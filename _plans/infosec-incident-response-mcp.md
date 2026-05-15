# Information Security Incident Response Logic App Integration

## Context

Implementation plan for the spec at `_specs/infosec-incident-response-mcp.md`. Wire the Logic App's six MCP-published tools (`block-domain`, `block-email`, `block-globalprotect`, `block-hash`, `block-ipaddress`, `request-sslbypass`) into Neo as **local Neo tools** that proxy through a new Neo-side Streamable HTTP MCP client. Anthropic's `mcp_servers` connector is intentionally not used — every tool is destructive and must hit Neo's existing `DESTRUCTIVE_TOOLS` confirmation gate, which only fires for locally-dispatched tools.

This plan is the second time we're shipping an MCP integration after PR #59's Wiz disable, so the surface is well-trodden: Entra ID OAuth (`getAzureToken` shape), per-credential cache key (`sha256(...)`), literal-`Set` SSRF allowlists (CodeQL `js/request-forgery`-compatible), `SAFE_METADATA_FIELDS` extension, and a two-stage probe pattern are all reused. The new piece is `web/lib/mcp-client.ts` — a Streamable HTTP MCP client that handles the `initialize` → `notifications/initialized` → `tools/call` handshake, `Mcp-Session-Id` management, 401-retry-with-reinit, and Azure API Management correlation-header capture.

---

## Key Design Decisions

- **Class-based MCP client, memoised per URL.** `web/lib/mcp-client.ts` exports a `McpClient` class plus a `getMcpClient(url, authStrategy)` registry that returns a per-URL singleton. The class caches the `Promise<{ accessToken, sessionId }>` from the handshake so concurrent first-turn calls serialise on one initialise round-trip. Future Wiz re-enable (path #3 from PR #59) registers a second URL with `authStrategy: "customHeaders"` — no refactor.
- **`authStrategy` is a discriminated union**, not a string. `{ type: "bearer"; tokenFactory: () => Promise<string> }` for Infosec; `{ type: "customHeaders"; headerFactory: () => Promise<Record<string,string>> }` for future Wiz. Factories not raw values, so the client can re-resolve credentials on 401 retry without the caller needing to know.
- **`getEntraTokenAs` is the new generic in `auth.ts`** (approach (b) from the spec). Existing `getAzureToken` keeps its `AZURE_CLIENT_ID/SECRET` defaults; `getEntraTokenAs(clientId, clientSecret, resource)` is the new parameterised sibling. Cache keyed by `sha256(clientId + ":" + clientSecret + ":" + resource).slice(0, 16)` so credential rotation invalidates cleanly per-resource. `getInfosecAccessToken()` in a thin new `web/lib/infosec-auth.ts` wraps this with the Infosec-specific env reads.
- **`responder` is server-populated, never on the model-facing tool schema.** The executor injects it from `getLogContext()?.userName` after the model dispatches. If no `userName` is in scope (background callers like the triage endpoint), the executor refuses — destructive actions without an accountable human don't fire. The spec's open question on a service-principal default is resolved with refuse-by-default.
- **`notes` doubles as Neo's audit-justification field** for the five `block-*` tools. No separate `justification` arg. For `request-sslbypass` (no `notes` equivalent), Neo accepts an optional client-side `notes` field that's captured in the audit event only, not forwarded to the Logic App.
- **Six executors live alongside existing Sentinel/Defender executors in `executors.ts`.** Single-file convention matches the rest of the codebase. Per-tool input validation (IP shape, hash length, email shape, hostname-ish for domains) runs at the executor before the MCP call.
- **SSRF guard: literal `Set` on `INFOSEC_LOGIC_APP_MCP_URL`**, mirroring the Wiz `WIZ_MCP_PROBE_ALLOWLIST` pattern from PR #58 — CodeQL `js/request-forgery` accepts `Set.has()` against literal strings as a sanitiser. Initial allowlist: just the production Logic App URL. Adding new environments requires a code change.
- **Probe error messages distinguish three failure modes**: (1) missing credentials (specific to which field), (2) token endpoint rejected creds (Entra ID 401/403 → "Authentication failed"), (3) MCP server unreachable or rejected handshake. Same pattern PRs #57/#58 settled into for Wiz.

---

## Files to Change

| File | Change |
|------|--------|
| `web/lib/types.ts` | Add `AGENT_CLIENT_ID`, `AGENT_CLIENT_SECRET`, `INFOSEC_LOGIC_APP_API_ID`, `INFOSEC_LOGIC_APP_MCP_URL` to `EnvConfig`. |
| `web/lib/config.ts` | Add the four to the `env` object. Extend `validateConfig` to soft-warn (not throw) on malformed `INFOSEC_LOGIC_APP_MCP_URL` (non-https, host not in allowlist). |
| `web/lib/auth.ts` | Add `getEntraTokenAs(clientId, clientSecret, resource): Promise<string>` and `clearEntraTokenCacheFor(clientId, clientSecret, resource): void`. Cache keyed by `sha256(clientId + ":" + clientSecret + ":" + resource).slice(0, 16)`. Existing `getAzureToken` keeps its current shape and behaviour. |
| `web/lib/infosec-auth.ts` | **NEW.** `getInfosecAccessToken(): Promise<string>` reads `AGENT_CLIENT_ID` / `AGENT_CLIENT_SECRET` / `INFOSEC_LOGIC_APP_API_ID` via `getToolSecret`, constructs `api://<id>/.default` as the resource, calls `getEntraTokenAs`. `clearInfosecTokenCache()` exported for credential rotation. Throws with specific field name on missing creds. |
| `web/lib/mcp-client.ts` | **NEW.** Streamable HTTP MCP client. Exports `McpClient` class, `getMcpClient(url, authStrategy)` memoised factory, `INFOSEC_LOGIC_APP_URL_ALLOWLIST` literal Set. Implements `initialize` → `notifications/initialized` → `tools/call` with `Mcp-Session-Id` propagation, 401-retry-with-reinit (max once), 10s `AbortSignal.timeout`, `redirect: "error"`. Handles both `application/json` and `text/event-stream` response modes. |
| `web/lib/tools.ts` | Add six tool schemas (`block_domain`, `block_email`, `block_globalprotect`, `block_hash`, `block_ipaddress`, `request_sslbypass`) with Neo-written `description` strings (from the spec's "suggested copy") and Neo-defined `required` arrays. `responder` is intentionally not on the schema. Add all six to `DESTRUCTIVE_TOOLS`. |
| `web/lib/executors.ts` | Add six executor functions, one per tool. Each: input-validates (IP/hash/email/hostname shape), pulls `responder` from `getLogContext()?.userName` and refuses if absent, calls `getMcpClient(INFOSEC_LOGIC_APP_MCP_URL, { type: "bearer", tokenFactory: getInfosecAccessToken })` once, invokes `.callTool(kebabName, payload)`. Mock-mode branch returns the per-tool synthetic fixture. Register all six in the `executors` map at the bottom. |
| `web/lib/permissions.ts` | Extend the `admin` role's tool allowlist with the six new tool names. `reader` and `triage` get NONE. |
| `web/lib/integration-registry.ts` | Add a new `infosec-incident-response` entry with the six tools listed under `capabilities` (kebab-case to match what the Logic App publishes), and four required secrets under `secrets`. |
| `web/lib/logger.ts` | Add `responder`, `apiManagementRequestId`, `apiManagementMiddlewareRequestId`, `workflowRunId`, `mcpSessionId` to `SAFE_METADATA_FIELDS`. |
| `web/app/api/integrations/[slug]/test/route.ts` | Add an `"infosec-incident-response"` probe entry. Two stages: (1) `getInfosecAccessToken()` — surfaces Entra-side failures with the specific error; (2) call `mcpClient.callTool("__probe__", {})` OR just access `mcpClient.ensureSession()` to force the handshake without invoking a tool. Distinct error message per stage. Re-uses the existing `PROBE_TIMEOUT_MS` constant. |
| `web/test/mcp-client.test.ts` | **NEW.** Unit tests for the MCP client. |
| `web/test/infosec-auth.test.ts` | **NEW.** Unit tests for `getInfosecAccessToken` and `getEntraTokenAs`. |
| `web/test/infosec-executors.test.ts` | **NEW.** Per-tool executor tests (mock + live paths, input validation, `responder` injection, error wrapping). |
| `web/test/infosec-confirmation-flow.test.ts` | **NEW.** End-to-end confirmation flow: model emits `block_ipaddress` → gate fires → confirm → executor dispatches → `tool_execution` audit event carries the right metadata. Plus the cancellation path. |
| `web/test/infosec-probe.test.ts` | **NEW.** Probe tests: 403 for non-admin, missing-creds error per field, Entra failure surfacing, MCP failure surfacing. |
| `docs/configuration.md` | Add a new "Information Security Incident Response (Logic App MCP)" section after the Wiz section. Document the four env vars, the auth flow, the per-tool destructive note, and the audit-correlation behaviour. |
| `_specs/infosec-incident-response-mcp.md` | No changes — the spec is the source of truth this plan executes against. |

`.env.example` updates are **NOT** in this plan — the dev environment's sandbox blocks `.env*` reads (see PR #57 history). Operator should add the four new vars manually following the table in `docs/configuration.md`. Flag at PR-open time.

---

## Implementation Steps

### 1. Env vars + types

- `web/lib/types.ts`: add four optional string fields to `EnvConfig` with a multi-line comment block referencing the spec and the audit-correlation rationale.
- `web/lib/config.ts`: add the four to the `env` object (read from `process.env`). Under the existing Wiz validation block, add a parallel soft-validation for `INFOSEC_LOGIC_APP_MCP_URL`: parse as URL, warn (`console.warn`, not throw) if it's not https or if its hostname isn't in the literal allowlist defined in `mcp-client.ts`. Reuse the redact-the-raw-value pattern from PR #58 — never print the URL on parse failure since operators can accidentally paste credential-bearing URLs.

### 2. Auth helpers

- In `web/lib/auth.ts`, factor out a private helper `mintEntraToken(tokenUrl, body, cacheKey)` that does the actual `fetch` + cache-write. The existing `getAzureToken` and the new `getEntraTokenAs` both delegate to it. Cache stays as one `Map<string, TokenCacheEntry>` in the file's scope; the cache-key shape changes per-caller.
  - `getAzureToken(resource)` → `mintEntraToken(tokenUrl, { client_id: AZURE_CLIENT_ID, client_secret: AZURE_CLIENT_SECRET, grant_type, scope: resource + "/.default" }, "azure:" + resource)` — preserves the existing key shape.
  - `getEntraTokenAs(clientId, clientSecret, resource)` → `mintEntraToken(tokenUrl, { client_id: clientId, client_secret: clientSecret, grant_type, scope: resource + "/.default" }, sha256(clientId + ":" + clientSecret + ":" + resource).slice(0, 16))` — per-credential, per-resource keying.
- `clearTokenCache` already exists — extend its docstring to note it clears entries for every caller; add `clearEntraTokenCacheFor(clientId, clientSecret, resource)` for targeted eviction (used on credential rotation in the admin UI).
- **New file `web/lib/infosec-auth.ts`**: copy-and-adapt the Wiz `wiz-auth.ts` shape. Top-of-file comment block describes the contract verified via Postman 2026-05-15. Exports:
  - `getInfosecAccessToken(): Promise<string>` — reads three secrets via `getToolSecret`, throws specific errors on each missing one, calls `getEntraTokenAs(clientId, clientSecret, "api://" + audienceId)`.
  - `clearInfosecTokenCache(): void` — for credential rotation; delegates to `clearEntraTokenCacheFor`.
- **No URL allowlist needed in the auth helper** — the Entra ID token endpoint is `https://login.microsoftonline.com/<tenant>/oauth2/v2.0/token`, hardcoded inside `auth.ts`. CodeQL is happy with that.

### 3. MCP client (`web/lib/mcp-client.ts`)

- Define the `authStrategy` discriminated union and `McpToolResult` type at the top.
  ```
  type AuthStrategy =
    | { type: "bearer"; tokenFactory: () => Promise<string> }
    | { type: "customHeaders"; headerFactory: () => Promise<Record<string, string>> };
  ```
- Export `INFOSEC_LOGIC_APP_URL_ALLOWLIST = new Set<string>(["https://logic-infosecautomation-prod-001-b0b2eje4fehphtf2.eastus2-01.azurewebsites.net/api/mcpservers/InfosecIncidentResponse/mcp"])` — literal Set so CodeQL recognises the sanitiser.
- Class `McpClient`:
  - Constructor takes `{ url, authStrategy, clientInfo, protocolVersion?, fetchTimeoutMs? }`. Validates `url` against the allowlist immediately; throws if not in.
  - Private state: `session: Promise<{ accessToken?: string; headers?: Record<string,string>; sessionId: string }> | null` (one cached promise so concurrent callers serialise).
  - `private async handshake()`: resolves auth (calls factory), POSTs `initialize` with the protocol version (`"2025-06-18"`), captures `Mcp-Session-Id` from response headers, POSTs `notifications/initialized` (expects 202 or 200 with empty body — any other 2xx is also acceptable; non-2xx throws). Returns the resolved session object.
  - `public async callTool(toolName, args)`: ensure-session, POST `tools/call` with `{ name: toolName, arguments: args }`, attach `Mcp-Session-Id`, parse response. On non-2xx 401: invalidate the cached session promise, retry once (re-handshake re-mints token, re-initialises). On second 401, throw. On 200, parse JSON-RPC response, return `{ content, isError, correlationHeaders }` where `correlationHeaders` captures `x-ms-middleware-request-id`, `x-ms-request-id`, `Workflow-Run-Id` (case-insensitive lookup), and `x-ms-workflow-run-id` from the response headers.
  - Streaming response handling: if `Content-Type` includes `text/event-stream`, consume the SSE stream and use the last `data:` JSON payload as the result. Synchronous JSON path uses `await res.json()` as usual. The Logic App is synchronous (verified 2026-05-15) so the streaming path is defensive but tested.
- Factory function `getMcpClient(url, authStrategy)` keeps an internal `Map<string, McpClient>` keyed by `url`. Returns a memoised instance. Tests can call `__resetMcpClientCache()` (test-only export) to wipe between cases.
- File-top comment block: cite the spec, cite the Postman verification date, document the handshake order and the 401-retry contract.

### 4. Tool schemas (`web/lib/tools.ts`)

- Add six entries to the `TOOLS` array. Use the descriptions from the spec's "Tool catalogue (v1)" section verbatim (operator-friendly wording already approved). Set `required` per tool:
  - Block tools: `required: ["ioc", "notes"]` — the model must provide both. `responder` is NOT in the schema.
  - `request_sslbypass`: `required: ["reportedDomain"]` — `submitDate` is optional (defaults to now in the executor). `responder` is NOT in the schema.
- Add all six tool names to `DESTRUCTIVE_TOOLS`. Use the snake_case Neo names. The existing destructive list already has `reset_user_password`, `isolate_machine`, `unisolate_machine`, `block_indicator`, etc. — six more is a small list change.
- Inline-document the catalogue mapping: for each Neo tool, a comment line citing the Logic App kebab-case name and the field-name mapping (e.g. `// → block-domain; model-supplied: ioc, notes; server-injected: responder`).

### 5. Executors (`web/lib/executors.ts`)

- Add six executor functions: `blockDomain`, `blockEmail`, `blockGlobalprotect`, `blockHash`, `blockIpaddress`, `requestSslbypass`. Mock-mode branch returns a synthetic fixture per the spec. Live-mode branch:
  1. Look up `responder` from `getLogContext()?.userName`. If absent, throw `Error("Destructive Infosec tool '<name>' requires an authenticated user identity; no responder available in log context.")` — the agent loop surfaces this as a tool-error, never executes.
  2. Per-tool input validation (defined inline; reuse from a small `infosec-validation.ts` if cleaner — implementer's call):
     - `block_ipaddress`: `/^(?:[0-9]{1,3}\.){3}[0-9]{1,3}$/` OR a permissive IPv6 regex OR (preferred) `new URL("https://[" + ioc + "]")` for IPv6 parse — implementer picks. Reject malformed.
     - `block_hash`: optional `hash_type` arg (`"md5" | "sha1" | "sha256"`); if absent, infer from length (32 = md5, 40 = sha1, 64 = sha256). Reject if `/^[a-fA-F0-9]+$/` doesn't match.
     - `block_email`: reject if no `@` or no `.` after `@`. Don't try to fully validate per RFC — the Logic App will reject malformed emails downstream.
     - `block_domain`: reject if contains `://`, whitespace, or doesn't match `/^[a-z0-9.-]+\.[a-z]{2,}$/i`. Permissive on purpose.
     - `block_globalprotect`: no shape validation — accepts any non-empty string.
     - `request_sslbypass`: validate `reportedDomain` same as `block_domain`; validate `submitDate` parses as a `Date` if provided, default to `new Date().toISOString()` if absent.
  3. Resolve the client: `const client = getMcpClient(env.INFOSEC_LOGIC_APP_MCP_URL!, { type: "bearer", tokenFactory: getInfosecAccessToken });`
  4. Build payload: for block tools, `{ responder, ioc: input.ioc, notes: input.notes }`. For `request_sslbypass`, `{ responder, submitDate: input.submitDate ?? new Date().toISOString(), reportedDomain: input.reportedDomain }`.
  5. Call `await client.callTool(kebabName, payload)`. Wrap result in the standard `{ status, runId, correlationHeaders, content }` shape so the agent loop's existing audit pipeline sees consistent fields.
  6. Wrap-and-offload via `wrapAndMaybeOffloadToolResult` (existing helper). The injection-guard runs over the Logic App's response content same as every other tool.
- Add the six executors to the `executors` map at the bottom of the file using their snake_case keys.
- Update `getToolIntegration` in `integration-registry.ts` (if it has a lookup table) so the six tool names map to `infosec-incident-response` — needed for the existing `toolCategory` audit field.

### 6. Permissions (`web/lib/permissions.ts`)

- Find the existing `ROLE_TOOL_ALLOWLIST` (or equivalent — check the current shape; it may be a `Record<Role, Set<string>>`). Add the six new tool names to the `admin` set. Do NOT add to `reader` or `triage`.
- Smoke check: `canUseTool("reader", "block_ipaddress")` returns false; `canUseTool("admin", "block_ipaddress")` returns true.

### 7. Integration registry (`web/lib/integration-registry.ts`)

- Add a new entry after the Wiz entry:
  ```
  {
    slug: "infosec-incident-response",
    name: "Information Security Incident Response",
    iconName: "ShieldAlert",       // pick an existing Lucide icon
    imageSrc: "/infosec-logo.png", // operator may want to provide a real logo later
    description: "Network-layer remediation via the Information Security Incident Response Logic App. Six destructive tools: block-domain, block-email, block-globalprotect, block-hash, block-ipaddress, request-sslbypass. All gated by Neo's destructive-action confirmation; admin role only.",
    capabilities: [
      "block_domain", "block_email", "block_globalprotect",
      "block_hash", "block_ipaddress", "request_sslbypass",
    ],
    secrets: [
      { key: "AGENT_CLIENT_ID",           label: "Agent client ID",     description: "Entra ID app registration FOR THE NEO AGENT — the client_credentials caller. Must have `api://<INFOSEC_LOGIC_APP_API_ID>/.default` admin-consented.",   required: true },
      { key: "AGENT_CLIENT_SECRET",       label: "Agent client secret", description: "Client secret for the agent app registration. Rotate periodically.",                                                                                  required: true },
      { key: "INFOSEC_LOGIC_APP_API_ID",  label: "Logic App API ID",    description: "The Logic App's app registration client ID — the audience for the OAuth token (`api://<this-value>/.default`). Found in Entra under the Logic App app reg's `Expose an API` tab.", required: true },
      { key: "INFOSEC_LOGIC_APP_MCP_URL", label: "MCP server URL",      description: "Full HTTPS URL of the Logic App's MCP endpoint. Gated by a literal-host allowlist in mcp-client.ts — adding new environments requires a code change.", required: true },
    ],
  }
  ```
- If `getToolIntegration` exists and uses a static map, regenerate it (or its build path) to include the six new tool→slug entries.

### 8. Logger allowlist (`web/lib/logger.ts`)

- Extend `SAFE_METADATA_FIELDS` with: `responder`, `apiManagementRequestId`, `apiManagementMiddlewareRequestId`, `workflowRunId`, `mcpSessionId`. All low-cardinality identifiers; none carry PII (the responder is the operator's UPN or hashed-pii equivalent already captured in `ownerIdHash`; if direct UPN matters, hash via `hashPii` at the call site).
- Defensive: write a test that asserts these field names are in the allowlist (mirrors the test the spec calls for; same pattern PR #57 introduced for the Wiz fields).

### 9. Probe (`web/app/api/integrations/[slug]/test/route.ts`)

- Add an `"infosec-incident-response"` entry to the `PROBES` map:
  ```
  "infosec-incident-response": async () => {
    // Stage 1: mint a token. Surfaces Entra-side failures distinctly.
    let token: string;
    try {
      token = await getInfosecAccessToken();
    } catch (err) {
      throw new Error(`Infosec authentication failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    // Stage 2: force the MCP handshake. `ensureSession()` is exposed for this
    // — it runs initialize + notifications/initialized but no tools/call,
    // so the probe doesn't trip any destructive workflow.
    const mcpUrl = env.INFOSEC_LOGIC_APP_MCP_URL!;
    if (!INFOSEC_LOGIC_APP_URL_ALLOWLIST.has(mcpUrl)) {
      throw new Error(`INFOSEC_LOGIC_APP_MCP_URL '${mcpUrl}' is not in the probe allowlist.`);
    }
    const client = getMcpClient(mcpUrl, { type: "bearer", tokenFactory: async () => token });
    try {
      await client.ensureSession();
    } catch (err) {
      throw new Error(`Infosec Logic App handshake failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  ```
- Surface `client.ensureSession()` as a public method on `McpClient` specifically for the probe — same shape as `getWizAccessToken` becoming the Wiz probe's auth step. Production agent-loop calls go through `callTool` which calls `ensureSession` internally.

### 10. Tests

- **`web/test/infosec-auth.test.ts`**: cache hit, cache miss, near-expiry refresh, 401 surface, 5xx surface, fetch timeout, per-credential cache key (rotating only `AGENT_CLIENT_SECRET` produces a new cache entry), missing-creds throws name the specific field. Mock `fetch` directly. Also tests the underlying `getEntraTokenAs` independently so future callers (Wiz re-enable?) have coverage.
- **`web/test/mcp-client.test.ts`**: `initialize` → `notifications/initialized` → `tools/call` happy path (assert request order via mock-call inspection); `Mcp-Session-Id` forwarded on subsequent requests; concurrent `callTool` invocations share one handshake (Promise.all of two calls should result in exactly one `initialize` POST); 401-retry-with-reinit (first response 401 → second response 200 → tool result returned, only one retry); 401-twice gives up; bearer auth strategy sets `Authorization` header; customHeaders auth strategy sets the per-header map and no `Authorization`; allowlist rejection (URL not in `INFOSEC_LOGIC_APP_URL_ALLOWLIST` → constructor throws); fetch timeout; SSE response mode (server returns `text/event-stream`, client consumes final message); correlation headers captured in result.
- **`web/test/infosec-executors.test.ts`**: per-tool mock-mode test (synthetic fixture returned, no network); per-tool live-mode test (calls `mcp-client.callTool` with the right kebab name and payload); per-tool input-validation rejection test (malformed IP, malformed hash, malformed email, etc.); `responder` server-population test (model-supplied `responder` is overwritten OR — given it's not on the schema — the executor injects the right value from `getLogContext`); refuse-without-userName test (no log context → executor throws, no MCP call made).
- **`web/test/infosec-confirmation-flow.test.ts`**: mirror `agent-multi-tool-confirmation.test.ts`. Happy path: prompt "block 1.2.3.4 — phishing IOC" → assistant emits `block_ipaddress` → confirmation gate fires → user confirms → `mcp-client.callTool` is invoked with `{ responder, ioc: "1.2.3.4", notes: "..." }` → `tool_execution` event emitted with the four new audit fields populated. Cancellation: user cancels → `mcp-client.callTool` NEVER called → `tool_result` reflects cancellation → next turn proceeds without errors.
- **`web/test/infosec-probe.test.ts`**: 403 for reader/triage; admin-with-no-creds returns a specific "missing AGENT_CLIENT_ID" error; admin-with-broken-token surfaces the Entra 401 distinctly from the MCP handshake failure; admin-with-allowlist-violating-URL rejected before any fetch.
- **`web/test/logger-safe-metadata-fields.test.ts`** (or extend existing logger test): assert `responder`, `apiManagementRequestId`, `apiManagementMiddlewareRequestId`, `workflowRunId`, `mcpSessionId` are in the allowlist.

### 11. Documentation

- **`docs/configuration.md`**: new section "Information Security Incident Response (Logic App MCP)" after the Wiz section. Document:
  - The four env vars in a table mirroring the Wiz section.
  - The Entra ID app-registration setup steps (operator creates a new app reg, captures client ID/secret, grants `api://<LOGIC_APP_API_ID>/.default` and admin-consents).
  - The OAuth flow diagram (Neo → `login.microsoftonline.com` → bearer → `mcp.<region>...azurewebsites.net`).
  - The destructive-action confirmation gate behaviour from the user's perspective.
  - The audit-correlation fields and where to find them in Event Hub.
- **Comment annotations across the new code** (`mcp-client.ts`, `infosec-auth.ts`, executors): each new module's file-top block cites the spec, the Postman verification date, and the rationale for `responder` server-injection. Future maintainers should not have to re-derive this.

### 12. Pre-commit checks

- `cd web && npm run typecheck` — zero errors.
- `cd web && npm run lint` — zero new warnings (the existing `ApiKeysSection.tsx` pre-existing warning is unchanged).
- `cd web && npm test` — all tests pass. Net delta: +50-80 new tests (across the five new test files), zero regressions in unrelated areas. Confirm `web/test/agent-multi-tool-confirmation.test.ts` still passes — the new tools shouldn't change its behaviour, but they're added to `DESTRUCTIVE_TOOLS` which the test exercises.
- **CodeQL anticipated outcomes**: the literal-`Set` allowlist on `INFOSEC_LOGIC_APP_MCP_URL` short-circuits `js/request-forgery` taint analysis the same way PR #58's allowlist did for Wiz. No suppressions expected; if CodeQL flags `mcp-client.ts`, fall back to the dismissal pattern from PR #57's review with a justification that names the allowlist.

### 13. Manual smoke (post-deploy, NOT in this plan's automation)

- Operator creates the agent app registration in Entra, captures `AGENT_CLIENT_ID` / `AGENT_CLIENT_SECRET`.
- Operator looks up the Logic App app reg's client ID in Entra → captures as `INFOSEC_LOGIC_APP_API_ID`.
- Operator stores all four in Key Vault under the documented names.
- Operator opens Settings → Integrations → Information Security Incident Response → Test connection. Expect green.
- Operator opens a chat as admin: "Block IP 198.51.100.42 — phishing alert IOC. Block at the perimeter." Expect confirmation gate. Confirm. Expect a tool result from the Logic App. Inspect Event Hub for the `tool_execution` event — verify `responder`, `apiManagementRequestId`, and (if present) `workflowRunId` are populated.
- Operator runs the same prompt as a reader user. Expect a `permission_denied` response, no Logic App call.

---

## Verification

1. **`cd web && npm run typecheck`** passes cleanly.
2. **`cd web && npm run lint`** passes (pre-existing `react-hooks/exhaustive-deps` warning in `ApiKeysSection.tsx` unchanged).
3. **`cd web && npm test`** — all tests pass, including the new test files. Confirm `agent-multi-tool-confirmation.test.ts` still passes against the expanded `DESTRUCTIVE_TOOLS` set.
4. **Local probe smoke** (with mock data — `MOCK_MODE=true`): the new probe entry should return a success response when all four secrets are set (even with fake values), because the executors short-circuit in mock mode. **Production probe smoke (post-deploy)**: real creds, real Logic App URL → green.
5. **End-to-end confirmation flow** (manual, post-deploy): prompt the agent to block an indicator, confirm, verify Logic App actually invoked (check Azure Monitor for the workflow run), verify the `tool_execution` event in Event Hub carries `responder`, `apiManagementRequestId`, `apiManagementMiddlewareRequestId`, and `workflowRunId`.
6. **Cancellation path** (manual, post-deploy): prompt the agent to block, cancel at the confirmation. Verify NO workflow run in Azure Monitor; verify the `tool_execution` event records the cancellation.
7. **RBAC denial** (manual, post-deploy): same prompt as a reader user. Verify the agent returns `permission_denied` and never calls the Logic App.
8. **Mcp-Session-Id behaviour**: induce a 401 mid-session (simulate by manually expiring the token in cache). Verify the next `callTool` re-handshakes once and succeeds; verify the `mcp_invocation` audit event records the new session ID.
