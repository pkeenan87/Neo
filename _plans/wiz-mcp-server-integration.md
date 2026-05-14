# Wiz MCP Server Integration

## Context

This plan implements the spec at `_specs/wiz-mcp-server-integration.md`. We wire Neo's agent loop into the Wiz MCP Server so a Security-role SOC analyst can pull from Wiz's Security Graph, issues, vulnerabilities, compliance, and Defend threats during an investigation. The connection is a generic `McpServerConfig` registry that resolves per role at auth time — Wiz is the first concrete server, but the shape is built so the next four integrations (Abnormal, Lansweeper, AppOmni, ThreatLocker) plug in without further changes to `agent.ts` or the prompt layer. Per the spec's open-question answers, we use the existing `admin`/`reader`/`triage` roles (the multi-team prompt refactor is not a prerequisite), Key Vault from day one, streamable HTTP transport, glob-based per-tool allow-lists, the cheapest auth-only connection-test probe, and Logic Apps inheriting the role mapping.

---

## Key Design Decisions

- **Role mapping uses the existing 3-role model.** Per the user's answer to the open question, we don't introduce Security / Desktop Engineering / Help Desk roles. The mapping is `admin` → Wiz full read + write tools (write gated by the existing confirmation gate), `reader` → Wiz read-only, `triage` → Wiz read-only (Logic Apps inherit). This keeps the change scoped and lets the multi-team refactor remap later without touching the MCP layer.
- **`McpServerConfig` lives in its own file**, `web/lib/mcp-servers.ts`, not crammed into `config.ts`. The shape is `{ name, type: "url", url, authorization_token?, allowedRoles: Role[], allowedTools?: string[] }` matching the Anthropic SDK's `mcp_servers` parameter shape. Glob support for `allowedTools` (e.g. `wiz_get_*`).
- **Credentials live in Key Vault from day one** via the existing `getToolSecret()` helper in `web/lib/secrets.ts`. New secret names: `WIZ_MCP_URL`, `WIZ_MCP_TOKEN` (or `WIZ_CLIENT_ID` + `WIZ_CLIENT_SECRET` if the Wiz MCP requires the OAuth client-credentials flow — we'll find out from the official Wiz MCP transport docs during step 1). Both paths cache via the existing 5-minute TTL in `secrets.ts`. Env-var fallback is automatic per `getToolSecret`'s contract.
- **Streamable HTTP transport** (not SSE). The Anthropic SDK's MCP connector currently exposes `{ type: "url", url, ... }` which corresponds to the streamable HTTP transport. Pin the transport string in `McpServerConfig.type` so a future Wiz transport change shows up as a config diff.
- **Server-side enforcement is the contract.** Even though Claude only sees the role-filtered `mcp_servers` array, we add a defense-in-depth `enforceMcpToolAccess(role, toolName)` check that runs at every MCP tool invocation. This mirrors the existing `executors.ts` RBAC pattern.
- **No request-level caching** for Wiz responses (per the user's answer). Wiz handles its own rate limiting; we accept the latency.
- **No new role definitions.** The existing `admin`/`reader`/`triage` union in `web/lib/permissions.ts` is unchanged.
- **Mock mode returns a small fixture set.** The first turn under `MOCK_MODE=true` against a Wiz tool returns canned `wiz_get_issues` data so dev/test never hits the network.
- **The connection-test probe is cheapest possible** — auth-only. It calls a Wiz MCP server-info / health endpoint (whichever the streamable HTTP transport exposes) and validates the response shape. No representative graph query.
- **Anthropic SDK upgrade is the first step.** The repo is on `@anthropic-ai/sdk@0.30.1`. MCP-connector support landed in newer SDK releases behind a `betas: ["mcp-client-2025-04-04"]` flag. Step 1 confirms the current SDK version supports `mcp_servers` and bumps if needed.

---

## Files to Change

| File | Change |
|------|--------|
| `web/package.json` | Bump `@anthropic-ai/sdk` if 0.30.1 doesn't expose `mcp_servers` on `Messages.MessageCreateParams`. Bump conservatively to the latest patch in the supporting major. |
| `web/lib/mcp-servers.ts` | **New.** Exports `McpServerConfig` interface, `getMcpServers(role: Role): Promise<McpServerConfig[]>`, `enforceMcpToolAccess(role: Role, mcpServer: string, toolName: string): boolean`, and the Wiz registry entry. Handles token fetch via `getToolSecret`, role filtering, and glob expansion for `allowedTools`. |
| `web/lib/mcp-tool-matcher.ts` | **New.** Tiny utility — `matchesAllowedTools(toolName: string, allowedTools: string[] | undefined): boolean` with glob support (`*` only, no full minimatch). Exported separately so the matcher is unit-testable in isolation. |
| `web/lib/agent.ts` | Resolve `mcp_servers` once at the top of the agent loop via `getMcpServers(role)`. Spread the resulting array into the params object passed to `createWithRetry`. Pass the required `betas: ["mcp-client-2025-04-04"]` (or whichever beta header the bumped SDK requires). Wrap the MCP-tool-result handler in `enforceMcpToolAccess` so a denied tool returns a structured "tool denied" message back to the model instead of forwarding to the MCP server. |
| `web/lib/types.ts` | Add `"mcp_invocation"` to the `LogEventType` union. |
| `web/lib/logger.ts` | No behavioural change — the new event type is just used through `logger.emitEvent`. |
| `web/lib/config.ts` | Add `WIZ_MCP_URL` and `WIZ_MCP_TOKEN` (or the OAuth pair, see step 1) to the env schema so the validator catches missing values at startup with a clear message. |
| `web/lib/integration-registry.ts` | Add a new `wiz` entry to `INTEGRATIONS` listing the Wiz MCP secrets and a short operator-facing description. |
| `web/app/api/integrations/[slug]/test/route.ts` | Add a `wiz` entry to `PROBES`. The probe fetches the Wiz MCP server-info / health endpoint with the bearer token; returns 200 on success, structured error otherwise. Auth-only — no representative graph query. |
| `docs/configuration.md` | New "Wiz MCP Server" subsection under the Integrations section: env-var names, Key Vault names, role → Wiz access matrix, connection-test workflow, MOCK_MODE behaviour. |
| `web/.env.example` | New `WIZ_MCP_URL=` / `WIZ_MCP_TOKEN=` lines with comments. |
| `web/test/mcp-servers.test.ts` | **New.** Unit tests for `getMcpServers` (per-role filtering, missing env returns empty, glob expansion of `allowedTools`), token cache behaviour, and `enforceMcpToolAccess` decision matrix. |
| `web/test/mcp-tool-matcher.test.ts` | **New.** Glob matcher unit tests: literal match, wildcard prefix, wildcard suffix, undefined allow-list (allow all), empty array (deny all). |
| `web/test/mcp-integration-route.test.ts` | **New.** Tests for the new `wiz` probe in the integration-test route. Admin gate, success, failure mode, malformed response. |
| `web/test/agent-mcp.test.ts` | **New.** Verifies the agent loop calls `getMcpServers` with the active role and spreads the result into the Anthropic API request. Mock `client.messages.create` and assert the `mcp_servers` array shape. |
| `web/test/mcp-audit-log.test.ts` | **New.** Asserts that every MCP tool invocation emits an `mcp_invocation` event with `{ role, mcpServer, toolName, sessionId, ownerIdHash }` and never carries the raw bearer token, URL, or UPN. |

---

## Implementation Steps

### 1. Confirm Anthropic SDK supports MCP connector; bump if needed

- Inspect `node_modules/@anthropic-ai/sdk/resources/messages.d.ts` (after `npm install`) for `mcp_servers` in `MessageCreateParams` and any `BetaMessageCreateParams` variant.
- If 0.30.1 doesn't expose the surface, bump to the smallest patch that does (check Anthropic SDK changelog — MCP connector lands in the 2025-04-04 beta train).
- Note the required `betas` header value (`mcp-client-2025-04-04` or its successor) and the exact param shape (`{ type: "url", url, name, authorization_token?, tool_configuration? }`).
- Verify the existing `createWithRetry` signature can accept the bumped param shape with no type errors.

### 2. Add the `McpServerConfig` registry

- Create `web/lib/mcp-servers.ts`.
- Define the `McpServerConfig` interface: `name`, `type: "url"`, `url`, `authorization_token?: string`, `allowedRoles: Role[]`, `allowedTools?: string[]`.
- Build a single hardcoded `WIZ_SERVER` registry entry. Its `allowedRoles` are `["admin", "reader", "triage"]`. Its `allowedTools` is a glob list scoped per role via a second helper `wizToolsFor(role)` — admin gets `["*"]` (everything), reader and triage get a read-only glob set like `["wiz_get_*", "wiz_list_*", "wiz_search_*"]` (final list confirmed against Wiz's MCP catalogue during step 1).
- Implement `getMcpServers(role: Role)`: returns an array of zero or one entries — the Wiz entry when `WIZ_MCP_URL` resolves and the role is in `allowedRoles`, an empty array otherwise. Token is fetched via `getToolSecret("WIZ_MCP_TOKEN")`; if missing, log a warning and return an empty array (graceful degradation).
- Implement `enforceMcpToolAccess(role: Role, mcpServer: string, toolName: string)`: looks up the registry entry by name, applies `wizToolsFor(role)` glob via the matcher, returns boolean. Used by the agent loop as the server-side allow-list check.

### 3. Build the glob matcher

- Create `web/lib/mcp-tool-matcher.ts`.
- Export `matchesAllowedTools(toolName: string, allowedTools: string[] | undefined): boolean`.
- Semantics: `undefined` → allow all. Empty array → deny all. Otherwise: match any pattern in the array. A pattern with `*` is converted to a regex (`*` → `.*`, everything else escaped). A literal pattern matches exactly.
- Kept narrow on purpose — no `?` or character-class support. The spec answer for "glob support" intends shell-style `*` only.

### 4. Add the `mcp_invocation` audit event type

- Add `"mcp_invocation"` to the `LogEventType` union in `web/lib/types.ts`.
- No code changes in `logger.ts` — the new type flows through `emitEvent`.
- Document the audit metadata contract: `{ mcpServer, toolName, role, result: "success" | "blocked" | "error", durationMs, ownerIdHash }`. Never include the bearer token, full URL, or raw UPN.

### 5. Wire `mcp_servers` into the agent loop

- In `web/lib/agent.ts`, immediately before the main agent-loop call to `createWithRetry`, call `getMcpServers(activeRole)`.
- Spread the resulting array into the `MessageCreateParams` as `mcp_servers`. Add the required `betas: ["mcp-client-2025-04-04"]` (or whichever beta header step 1 confirmed).
- Where the loop currently dispatches a tool by name to the local executor map, add a discriminator: if the call is an MCP tool (its name is registered against an MCP server, not the local executors), run `enforceMcpToolAccess(role, server, toolName)` first. If denied, emit an `mcp_invocation` event with `result: "blocked"` and feed a structured "tool denied" response back into the model's next turn rather than forwarding to the MCP server.
- On a successful MCP tool result returned by Claude (the SDK surfaces these in the response content blocks), emit `mcp_invocation` with `result: "success"` and the `durationMs` measured against the surrounding tool turn.
- On any caught error from the MCP path, emit `mcp_invocation` with `result: "error"` and the error message stripped of any token/URL fragments.

### 6. Fail-open behaviour when Wiz is unreachable

- The Anthropic SDK surfaces MCP transport errors in the response content as a `mcp_tool_result` with `is_error: true`. Treat these the same as a local tool error: emit the `mcp_invocation` `result: "error"` event, feed the error string back into the model, and let the agent loop continue.
- If `getMcpServers` itself throws (e.g., Key Vault outage on the token fetch), wrap the call in a try/catch in the agent loop and proceed with an empty `mcp_servers` array. Log a warning. This matches the fail-open posture already documented for the dedup cache and triage dispatch.

### 7. Add Wiz to the config validator

- Add `WIZ_MCP_URL` and `WIZ_MCP_TOKEN` to the `EnvSchema` in `web/lib/config.ts`. Both are optional (graceful degradation when missing) but format-validated when present (URL pattern; non-empty string).
- If Wiz MCP requires OAuth client-credentials per step 1's findings, replace these two with `WIZ_CLIENT_ID` and `WIZ_CLIENT_SECRET`, and perform the token exchange inside `getMcpServers` with the existing 5-minute cache.

### 8. Add the connection-test probe

- In `web/app/api/integrations/[slug]/test/route.ts`, add a `wiz` entry to the `PROBES` record.
- The probe calls a Wiz MCP server-info / health endpoint (whichever the streamable HTTP transport exposes — to be confirmed during step 1; if Wiz only exposes the tool-listing endpoint, that is the cheapest auth check available).
- Returns success on a 2xx with a valid JSON body shape. On failure, surfaces a distinct operator-readable message for each of: missing credentials, wrong URL host, 401/403 auth failure, 5xx, network/timeout.
- Reuses the existing admin-only gate at the top of the route handler — no changes to the auth logic.

### 9. Add Wiz to the integration registry

- In `web/lib/integration-registry.ts`, add a new entry to `INTEGRATIONS` with `slug: "wiz"`, `name: "Wiz Cloud Security Platform"`, a short description, and the relevant secret keys (matching the choice from step 7 — either `WIZ_MCP_URL` + `WIZ_MCP_TOKEN` or the OAuth pair).
- This drives the Settings UI's integration list and the connection-test probe wiring.

### 10. Mock-mode fixtures

- In `web/lib/mcp-servers.ts`, when `process.env.MOCK_MODE !== "false"`, `getMcpServers` returns the same registry shape but the resulting `authorization_token` is the literal string `"mock"` and the URL is overridden to a localhost stub.
- The agent loop's MCP-result branch detects the mock-mode marker and short-circuits with a small canned fixture for the most common Wiz tools (`wiz_get_issues`, `wiz_get_vulnerabilities`, `wiz_get_compliance`). The fixture lives in `web/lib/mcp-fixtures.ts` (new — keeps the production code clean).

### 11. Documentation

- Update `docs/configuration.md` with a new "Wiz MCP Server" subsection under Integrations. Cover: env-var names, Key Vault names, role → tool matrix, connection-test workflow, MOCK_MODE behaviour, and the documented Key Vault migration path.
- Update `web/.env.example` with the new `WIZ_MCP_URL=` and `WIZ_MCP_TOKEN=` (or OAuth pair) lines plus comments.

### 12. Tests

- Create `web/test/mcp-tool-matcher.test.ts` covering: literal match, wildcard prefix, wildcard suffix, undefined → allow-all, empty array → deny-all, no `?` support.
- Create `web/test/mcp-servers.test.ts` covering: each role's expected entry/empty result, missing env vars return empty, token cache (one fetch per TTL window, refresh-on-401 retry, second failure logged-and-empty), glob expansion, `enforceMcpToolAccess` decision matrix.
- Create `web/test/mcp-integration-route.test.ts` covering the new `wiz` probe: admin gate (401, 403), happy path, missing credentials, wrong URL host, 401 from Wiz, network error.
- Create `web/test/agent-mcp.test.ts` covering: agent loop spreads `mcp_servers` into the Anthropic API call for an admin-role conversation; the array is empty for a role whose `getMcpServers` returns empty.
- Create `web/test/mcp-audit-log.test.ts` covering: every invocation (success, blocked, error) emits an `mcp_invocation` event with the documented shape; metadata never contains the bearer token, full URL, or raw UPN.

---

## Verification

1. `cd web && npm run typecheck` — clean (especially after the SDK bump in step 1; the `Anthropic.Messages.MessageCreateParams` shape must accept the new fields without `any` escapes).
2. `cd web && npm run lint` — clean. The pre-existing `ApiKeysSection.tsx` warning may persist; nothing new should be introduced.
3. `cd web && npm run test` — all suites pass, including the five new MCP test files.
4. `cd web && npm run dev`, then in a browser as an admin: open `/settings` → Integrations, run the new Wiz connection-test probe against a real Wiz tenant. Expect a structured success body. Run it again with a deliberately bad token to confirm the 401 path returns a clear operator-readable error.
5. From the chat as an admin role, ask "show me critical Wiz issues from the last 24 hours" and confirm a real Wiz response is returned in the conversation transcript.
6. From the chat as a reader role, ask the same and confirm the agent returns results scoped to the read-only allow-list (no Defend or remediation tools surfaced in the tool-use blocks).
7. From the chat as a triage role (or via the Logic-App-style API call), confirm the same read-only scoping applies.
8. Tail the Event Hub audit feed (or check the local console sink in dev) and confirm every Wiz invocation logs an `mcp_invocation` event with the documented fields and no leaked credentials.
9. Stop the local network egress (or point `WIZ_MCP_URL` at a sinkhole), ask the same chat question, and confirm the agent loop still produces a response and the failure is logged but not raised as a 500.
10. CI: required checks (`All checks passed`, `CodeQL (security-extended)`, `Secret scan (gitleaks)`) all green on the PR before merge.
