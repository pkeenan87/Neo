# Spec for infosec-incident-response-mcp

branch: spec/infosec-incident-response-mcp
figma_component (if used): n/a

## Summary

Wire the Information Security Incident Response Logic App into Neo as a tool surface. The Logic App speaks MCP over HTTPS at `logic-infosecautomation-prod-001-*.azurewebsites.net/api/mcpservers/InfosecIncidentResponse/mcp`, authenticated via Entra ID OAuth2 client_credentials against the Logic App's app registration audience. The first cut exposes the six tools the Logic App publishes via `tools/list` — `block-domain`, `block-email`, `block-globalprotect`, `block-hash`, `block-ipaddress`, and `request-sslbypass` — every one of which is **destructive** and must route through Neo's existing confirmation gate before execution.

Tool input schemas were verified against the live Logic App via Postman on 2026-05-15 (handshake: `initialize` → `notifications/initialized` → `tools/list`). The five `block-*` tools share a flat `{ responder, ioc, notes }` shape; `request-sslbypass` takes `{ responder, submitDate, reportedDomain }`. None of the Logic App's tool schemas declare `required` fields or `description` strings — Neo writes its own descriptions for Claude's tool definitions and applies Neo-side input validation (e.g. IPv4/IPv6 shape on `block-ipaddress`).

**Critical design choice: Neo acts as the MCP client itself; the Logic App is NOT registered with Anthropic's `mcp_servers` connector.** The reason is the destructive-action gate. Anthropic's MCP connector executes tools server-side — by the time Neo sees the response, the call has already happened. For Wiz (read-only) that was acceptable; for Infosec (every tool is a remediation write) it's not. So the integration ships as:

- An MCP client inside Neo (TypeScript port of the Python sketch the operator provided), implementing the JSON-RPC `initialize` → `notifications/initialized` → `tools/call` handshake of the Streamable HTTP MCP transport. The Logic App returns an `Mcp-Session-Id` header on `initialize` and expects it forwarded on every subsequent request; the client caches the session per process and re-initialises on a 401-or-equivalent.
- The six tools registered as ordinary Neo tools in `web/lib/tools.ts`, added to `DESTRUCTIVE_TOOLS`, and dispatched through a generic executor in `web/lib/executors.ts` that proxies the call to the Logic App MCP server.
- From Claude's perspective, these are local Neo tools — not MCP. The agent loop's existing confirmation gate (`DESTRUCTIVE_TOOLS.has(name)`), audit pipeline (`tool_execution` event), RBAC check (`canUseTool`), and resumeAfterConfirmation plumbing all work without modification.

A useful side effect: the same "Neo as MCP client" pattern is exactly re-enable path #3 from PR #59's Wiz disable. Building it once for Infosec gives us the foundation for a future Wiz re-enable if/when Wiz won't issue MCP-compatible OAuth bearers and Anthropic doesn't add custom-header support.

## Functional requirements

- A new `infosec-incident-response` entry in `web/lib/integration-registry.ts` listing the six tools as `capabilities` and the four required secrets (see below) as `secrets`. Marked admin-only via the integration's role scoping comment — the registry doesn't enforce role today; `permissions.ts` does, see below.
- A new auth helper at `web/lib/infosec-auth.ts` (or a small extension to `web/lib/auth.ts`) that mints Entra ID access tokens via `client_credentials` against `https://login.microsoftonline.com/<tenant>/oauth2/v2.0/token` with `scope=api://<LOGIC_APP_API_ID>/.default`. Mirrors the cache-and-refresh shape of `getAzureToken` in `auth.ts` — same in-memory cache, 5-minute expiry buffer, `AbortSignal.timeout(10s)`, `redirect: "error"`. The new helper can almost certainly be `getAzureToken("api://<LOGIC_APP_API_ID>")` — the existing helper builds the scope as `<resource>/.default`, so passing the audience identifier as the resource arg gives the right scope shape. **One detail to verify** during implementation: today's `getAzureToken` reads `AZURE_CLIENT_ID`/`AZURE_CLIENT_SECRET` for every token request. The Infosec integration uses a SEPARATE app registration (`AGENT_CLIENT_ID`/`AGENT_CLIENT_SECRET` in the operator's sketch). Either (a) parameterise `getAzureToken` to accept an optional credential pair, (b) introduce a sibling helper `getEntraTokenAs(clientId, clientSecret, resource)`, or (c) reuse the existing AZURE_CLIENT_ID/SECRET if operations decides the same app reg should hold both Sentinel/Defender and Logic App permissions. Approach (b) is the cleanest; defer the decision to the implementation plan.
- A small Streamable HTTP MCP client at `web/lib/mcp-client.ts` (the proxy pattern's reusable bit) that:
  - Accepts `{ url, accessToken, toolName, args }` and returns the tool's result content.
  - Speaks JSON-RPC 2.0 — `initialize` once per process (cached Promise to serialise concurrent first-turn calls), `notifications/initialized` immediately after (the Logic App returns 202 and won't accept `tools/call` without this ack), `tools/call` per invocation. The `Mcp-Session-Id` returned by `initialize` is captured and forwarded on every subsequent request.
  - Sends `Authorization: Bearer <token>`, `Content-Type: application/json`, `Accept: application/json, text/event-stream` (per the MCP transport spec — required for compatibility with both response modes).
  - Handles synchronous JSON responses (the expected Logic App path — verified via Postman) AND streaming SSE responses (some MCP servers stream; the client should consume the final response message).
  - Re-initialises on 401 (token expired or server-side session evicted): drop the cached session, re-mint a token via the auth helper, redo the handshake, retry the original `tools/call` once. After a second 401, surface as a tool error rather than looping.
  - Captures the Azure API Management correlation headers from every response (`x-ms-middleware-request-id`, `x-ms-request-id`, and any `Workflow-Run-Id` / `x-ms-workflow-run-id` if the Logic App emits one on `tools/call`) and returns them alongside the tool result so the executor can plumb them into the `tool_execution` audit event.
  - 10-second timeout, `redirect: "error"`, same SSRF guard pattern as the Wiz `WIZ_AUTH_URL_ALLOWLIST` — a strict literal allowlist on the MCP URL host so an operator typo can't redirect tokens to an attacker host.
- Six executor entries in `web/lib/executors.ts`, one per tool: `block_domain`, `block_email`, `block_globalprotect`, `block_hash`, `block_ipaddress`, `request_sslbypass`. Each one:
  - Has a mock-mode path (per the project's MOCK_MODE convention) that returns a synthetic success without touching the network.
  - In live mode, calls `mcp-client.callTool(...)` with the configured Logic App URL + access token + canonical kebab-case tool name + a request payload built from the model's args. **The `responder` field is server-populated** from the authenticated user's identity (sourced from `getLogContext()?.userName` and falling back to a stable per-call default) before forwarding — the model never gets to choose who's accountable on a destructive action. The model is responsible for the operational fields (`ioc` + `notes` for the five `block-*` tools; `submitDate` + `reportedDomain` for `request-sslbypass`).
  - Returns the MCP tool result through the existing `wrapAndMaybeOffloadToolResult` injection-guard envelope.
- Six tool schemas in `web/lib/tools.ts` matching Anthropic's tool schema shape. **The Logic App's `tools/list` schemas have no `description` and no `required` fields** (verified via Postman 2026-05-15); Neo writes its own descriptions for Claude AND its own `required` arrays per tool (e.g. `["ioc", "notes"]` for the block tools, `["submitDate", "reportedDomain"]` for `request-sslbypass`). The `responder` field is intentionally NOT exposed on Neo's tool schema — the executor injects it after model dispatch. All six tools are added to `DESTRUCTIVE_TOOLS`.
- Neo-side input validation per tool, since the Logic App's JSON Schema is permissive: `block_ipaddress` checks IPv4/IPv6 shape; `block_domain` checks for a valid hostname-ish string; `block_email` checks for a single `@`; `block_hash` accepts an optional `hash_type` arg and validates length per type (MD5=32, SHA1=40, SHA256=64). Invalid input is rejected at the executor before any Logic App call.
- Per-role access via `web/lib/permissions.ts`: `admin` only. `reader` and `triage` cannot invoke any of the six tools. Mirrors how `isolate_machine` / `reset_user_password` are scoped today.
- A connection-test probe at `/api/integrations/infosec-incident-response/test/route.ts`. Two stages:
  1. Mint a token via the new auth helper.
  2. Call `initialize` against the MCP URL with the resulting bearer.
  Distinct error messages for each stage so the admin UI can tell "wrong credentials" from "Logic App unreachable" — same pattern PRs #57/#58 established for Wiz.
- Audit: every Logic App tool invocation emits the standard `tool_execution` event with `toolCategory: "infosec-incident-response"`, `isDestructive: true`, the resolved indicator type and value (from input args), the server-populated `responder` (so the audit shows the human accountable, not just the agent's role), the Azure API Management correlation IDs (`x-ms-middleware-request-id`, `x-ms-request-id`) the Logic App returns on every response, and the workflow-run header (`Workflow-Run-Id` or `x-ms-workflow-run-id`) if one appears on `tools/call` responses. Tool input is captured via the existing `toolInput` field; tool result via the wrapped envelope. No raw bearer or app-secret reaches metadata. The new audit-metadata field names (`apiManagementRequestId`, `apiManagementMiddlewareRequestId`, `workflowRunId`, `responder`) are added to `SAFE_METADATA_FIELDS` in `web/lib/logger.ts` so they survive `sanitizeMetadata` — same trap PR #57 fell into for the Wiz audit fields.
- A confirmation-flow integration test (mirroring `web/test/agent-multi-tool-confirmation.test.ts`) verifying that a request to "block 1.2.3.4" hits the confirmation gate, that a confirmed call dispatches to `mcp-client`, that a cancelled call records no Logic App invocation, and that the resulting `tool_execution` event carries the destructive metadata.

## Environment variables / Key Vault secrets

Stored via the existing Settings → Integrations admin flow (Key Vault primary, env fallback). The auth helper resolves them via `getToolSecret`. All four required.

| Variable | Key Vault name | Purpose |
|---|---|---|
| `AGENT_CLIENT_ID` | `agent-client-id` | Entra ID app registration **for the Neo agent** — the client_credentials caller. Must have `api://<LOGIC_APP_API_ID>/.default` granted (admin-consented) in Entra. |
| `AGENT_CLIENT_SECRET` | `agent-client-secret` | Client secret for the agent app registration. Rotate periodically. |
| `INFOSEC_LOGIC_APP_API_ID` | `infosec-logic-app-api-id` | The Logic App's app registration client ID — the **audience** for the OAuth token (`api://<this-value>/.default`). Listed in Entra under the Logic App app reg's "Expose an API" tab. |
| `INFOSEC_LOGIC_APP_MCP_URL` | `infosec-logic-app-mcp-url` | The full HTTPS URL of the Logic App MCP endpoint, e.g. `https://logic-infosecautomation-prod-001-b0b2eje4fehphtf2.eastus2-01.azurewebsites.net/api/mcpservers/InfosecIncidentResponse/mcp`. Gated by a literal-host allowlist in `mcp-client.ts`. |

`AZURE_TENANT_ID` is already in `env`/`EnvConfig` and reused. Both `AGENT_CLIENT_ID` and `AGENT_CLIENT_SECRET` are net-new secrets — the existing `AZURE_CLIENT_ID`/`AZURE_CLIENT_SECRET` are scoped to Sentinel/Defender/Entra and shouldn't be cross-purposed without an explicit decision.

The Logic App URL is hostname-locked to a literal Set allowlist (CodeQL `js/request-forgery` learning from PR #57/#58 — regex `.test()` isn't recognised as a sanitiser, but `Set.has()` against literal strings is). Initial allowlist: just the production Logic App URL the operator pasted. Adding a new environment requires a code change — same trade-off the Wiz probe accepts.

## Tool catalogue (v1)

Schemas below are the **Logic App's `tools/list` output**, verified via Postman on 2026-05-15. Neo writes its own descriptions for Claude (the Logic App emits none) and its own `required` arrays (the Logic App declares none). `responder` is server-populated by Neo's executor, not exposed on the Neo tool schema the model sees.

| Neo tool name | Logic App tool name | Model-visible input fields | Server-injected | Destructive | Roles |
|---|---|---|---|---|---|
| `block_domain` | `block-domain` | `{ ioc: string, notes: string }` — `ioc` is the domain; `notes` is the operator/agent justification (also feeds Neo's audit log) | `responder` | yes | admin |
| `block_email` | `block-email` | `{ ioc: string, notes: string }` — `ioc` is the sender or recipient email; `notes` is justification | `responder` | yes | admin |
| `block_globalprotect` | `block-globalprotect` | `{ ioc: string, notes: string }` — `ioc` is the GlobalProtect identifier (user / device / address); `notes` is justification | `responder` | yes | admin |
| `block_hash` | `block-hash` | `{ ioc: string, notes: string }` — `ioc` is the file hash; Neo validates length against MD5 (32) / SHA1 (40) / SHA256 (64) and rejects malformed input; `notes` is justification | `responder` | yes | admin |
| `block_ipaddress` | `block-ipaddress` | `{ ioc: string, notes: string }` — `ioc` is an IPv4 or IPv6 address; Neo validates shape and rejects invalid input; `notes` is justification | `responder` | yes | admin |
| `request_sslbypass` | `request-sslbypass` | `{ submitDate: string, reportedDomain: string }` — `submitDate` is ISO-8601 (Neo can default to `new Date().toISOString()` if the model omits it); `reportedDomain` is the domain to bypass | `responder` | yes | admin |

Naming convention: snake_case for Neo's tool registry (matches the existing local-tool naming — `isolate_machine`, `reset_user_password`, etc.); the executor maps it back to the Logic App's kebab-case when calling `tools/call`. The `notes` field is intentionally re-used as Neo's audit-justification field — no separate `justification` arg needed. `request_sslbypass` has no `notes` equivalent in the Logic App schema; if Neo's audit pipeline requires a justification it can be captured via a Neo-side `notes` field that's recorded in the audit event only, not forwarded to the Logic App (decision deferred to the plan).

Logic App tool `description` fields are empty in `tools/list`. Neo's Anthropic tool definitions need rich descriptions for Claude to choose between them correctly. Suggested copy (final wording deferred to the plan):

- `block_domain` — "Block a malicious domain at the network layer via the Information Security Incident Response Logic App. Destructive: requires admin confirmation. Use after positively identifying a domain as part of a confirmed incident."
- `block_email` — "Block a malicious sender/recipient email address. Destructive: requires admin confirmation. Use during phishing / BEC remediation when a specific email address must be denied delivery."
- `block_globalprotect` — "Block a GlobalProtect connection identifier (user, device, or address) from establishing VPN sessions. Destructive: requires admin confirmation."
- `block_hash` — "Block a file hash (MD5 / SHA1 / SHA256) from execution across the EDR fleet. Destructive: requires admin confirmation."
- `block_ipaddress` — "Block an IPv4 or IPv6 address at the network perimeter. Destructive: requires admin confirmation. Use after positively identifying an IP as part of a confirmed incident."
- `request_sslbypass` — "File an SSL inspection bypass request for a domain (e.g. a third-party app the security stack is breaking). Destructive: requires admin confirmation. Files a ticket with the security team; does not bypass inspection unilaterally."

## Possible edge cases

- **Logic App is unreachable / 5xx.** The executor should NOT throw out of the agent loop; surface a structured tool error (matching the existing executor error envelope) so the agent can recover gracefully. Same fail-open posture the rest of Neo's executors take.
- **Logic App returns a stale OAuth-token error after a deploy.** The auth helper's in-memory cache might still hold a now-invalid token. Mirror `clearWizTokenCache` — add `clearInfosecTokenCache` callable by the credential-rotation admin route.
- **MCP `initialize` race.** The Logic App issues a per-session `Mcp-Session-Id` on `initialize` and rejects `tools/call` without it (verified via Postman). Two parallel first-turn calls must not both run the handshake. Resolution: cache a `Promise<{ accessToken, sessionId } | null>` in `mcp-client.ts`; both callers await the same promise. On 401 mid-session, invalidate the cache and let the next call re-run the handshake — at most one extra round-trip per token rotation.
- **Confirmation cancellation.** If the user cancels a `block_ipaddress` confirmation, the audit event should record `confirmed: false` (existing pattern). No Logic App call is made. This already works with the existing confirmation infrastructure.
- **Confirmation timeout.** The agent loop's existing interruption semantics handle this — no new behaviour needed.
- **Logic App response shape changes.** MCP `tools/call` results are loosely typed (`content: array<TextContent | ImageContent | ...>`). The executor should JSON-stringify the result and pass through unchanged, letting the model interpret it. Same way executor results are handled today.
- **Multiple block tools in one turn.** Today's confirmation gate already handles multiple destructive tools in one assistant turn (see PR-merged commits referencing `DESTRUCTIVE_TOOLS` and `multi-tool-confirmation`). No new handling required.
- **Token-budget pressure on output.** Block tool inputs are small (an IP, a justification); not a budget risk.
- **CodeQL SSRF.** The literal-host allowlist on `INFOSEC_LOGIC_APP_MCP_URL` and the explicit Set-membership check on the auth URL (`login.microsoftonline.com/<tenant>/oauth2/v2.0/token` is hardcoded inside `getAzureToken` already) make the data flow CodeQL-clean — same pattern PR #58 settled into.

## Open questions

### Resolved by Postman discovery on 2026-05-15

- ~~**Tool input schemas — exact shape?**~~ **Resolved.** The Logic App publishes 6 tools (not 5 — `request-sslbypass` is the surprise). The 5 `block-*` tools share `{ responder, ioc, notes }`; `request-sslbypass` is `{ responder, submitDate, reportedDomain }`. None declare `required` fields or `description` strings. See the Tool catalogue table above.
- ~~**Logic App correlation ID in response headers.**~~ **Resolved (partial).** Every MCP response from the Logic App carries `x-ms-middleware-request-id` and `x-ms-request-id` (Azure API Management correlation IDs). No `Workflow-Run-Id` header on `initialize` or `tools/list` — that one only fires when a workflow actually executes, so `tools/call` is where to look. The audit pipeline captures all three header names; whichever the Logic App emits at runtime is what shows up.
- ~~**Justification field.**~~ **Resolved.** The Logic App's own `notes` field doubles as Neo's audit-justification convention. No separate `justification` arg needed for the 5 `block-*` tools. `request-sslbypass` has no equivalent; Neo can capture a `notes` field client-side for the audit event without forwarding it.

### Still open (deferred to the implementation plan)

- **`responder` default when no authenticated user is in scope.** Server-populated from `getLogContext()?.userName` is the canonical path, but the agent loop also runs from background callers (the triage endpoint, automated playbooks) where the "user" is a service principal. Fall back to the service-principal display name? Use a sentinel like `"neo-system"`? Decision: capture an explicit `responder` value at every call site and refuse the executor call if none is available — destructive actions without an accountable human shouldn't fire.
- **`request_sslbypass` `submitDate` default.** The Logic App takes any string. Neo can default to `new Date().toISOString()` if the model omits it, or require the model to provide one (forces the agent to think about whether the request is for today vs scheduled). Tentative: default to `now` when absent.
- **Mock-mode fixtures.** The six executors need synthetic responses for MOCK_MODE. Reasonable defaults: `{ status: "submitted", indicator: <input.ioc>, mocked: true, runId: "mock-run-<uuid>" }` for the block tools; `{ status: "queued", reportedDomain: <input.reportedDomain>, mocked: true }` for `request_sslbypass`. Finalised in the plan.
- **Permission helper.** `permissions.ts` doesn't currently special-case destructive remediation differently from read tools — the role check is per-tool-name. Confirm during implementation that adding the six tool names to the admin allowlist (and ONLY the admin allowlist) is sufficient. is sufficient
- **Re-use for Wiz?** The `mcp-client.ts` built here is the foundation for Wiz re-enable path #3 (Neo as MCP client, injecting the three custom headers). Worth a deliberate name and structure that anticipates a second integration — accept an `authStrategy` of `bearer` (Infosec) or `customHeaders` (future Wiz). Actually wiring Wiz through it stays out of scope here, but the API shape should accommodate it. yes, build this model to scale this is how we will do mcp going forward

## Testing Guidelines

Create test files in `web/test/` covering at least:

- **`infosec-auth.test.ts` (or extension to `auth.test.ts`)** — token mint, cache hit/miss, near-expiry refresh, 401 from token endpoint surfaces, 5xx surfaces, fetch timeout, credential-rotation cache invalidation. Mock `fetch` directly.
- **`mcp-client.test.ts`** — `initialize` → `tools/call` flow, synchronous JSON response handling, SSE response handling (a fake server that returns `text/event-stream` with a single final message), 401 from MCP server (token-rejected), 5xx (server unhealthy), host-allowlist rejection, fetch timeout, malformed JSON-RPC response handling.
- **`infosec-executors.test.ts`** — each of the six executors: mock mode returns the synthetic fixture without calling the network, live mode dispatches to `mcp-client` with the right tool name and args, **`responder` is server-populated** (model-supplied value is ignored / overwritten), tool-result envelope wrapping, error-path envelope (Logic App returns a structured error → executor wraps as a tool failure, agent loop continues). Per-tool input-validation tests: `block_ipaddress` rejects `"not-an-ip"`, `block_hash` rejects a 31-char string, `block_email` rejects `"no-at-sign.com"`, etc.
- **`infosec-confirmation-flow.test.ts`** — happy path: model emits `block_ipaddress` → confirmation gate fires → user confirms → executor dispatches → `tool_execution` event emitted with `responder`, `apiManagementRequestId`, `apiManagementMiddlewareRequestId`, `workflowRunId` (if present) populated. Cancellation path: user cancels → no MCP call made → tool_result records cancellation → next turn proceeds.
- **`infosec-probe.test.ts`** — admin gets through to the two-stage probe; reader/triage get 403; missing creds produce a precise error per missing field; token-endpoint failure surfaces as "authentication failed"; MCP-side failure surfaces as "Logic App rejected the bearer or unreachable".
- **Per-role permission tests** — `reader` and `triage` users invoking any of the six tools get a `permission_denied` response. `admin` is allowed (subject to confirmation).
- **Integration registry test (if any)** — verify the `"infosec-incident-response"` entry exists with the six tools and four secrets in the expected shape.
- **`SAFE_METADATA_FIELDS` extension test** — assert the new audit field names (`responder`, `apiManagementRequestId`, `apiManagementMiddlewareRequestId`, `workflowRunId`) are in the allowlist. Same defensive test pattern PR #57 added for the Wiz audit fields.

## Out of scope (recorded for follow-up)

- **Dynamic `tools/list` discovery.** Spec ships with hardcoded tools. A follow-up issue can add discovery at startup once the v1 shape is proven.
- **Settings UI for the five tools' "what does this do?" copy.** The integration registry's `description` and the tool's `description` field cover this for v1; richer admin documentation is a separate workstream.
- **Wiz re-enable via the same `mcp-client.ts` pattern.** Foundation is built here; actual Wiz wiring (custom-header strategy + role/catalogue port) is a separate PR.
- **Logic App side changes.** The Logic App owner is responsible for the MCP endpoint's reliability, schema, and Entra ID app reg. This spec assumes those are stable.
