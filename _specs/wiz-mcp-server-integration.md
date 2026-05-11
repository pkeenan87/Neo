# Spec for wiz-mcp-server-integration

branch: claude/feature/wiz-mcp-server-integration
figma_component (if used): n/a

## Summary

Integrate Neo with the Wiz MCP Server so the agent can query Wiz's cloud security platform (Security Graph, issues, vulnerabilities, compliance, Defend threats, blast radius) inline during investigations. The connection is wired in at the agent loop — `mcp_servers` is passed to the Anthropic API call — and scoped per role via a new `McpServerConfig` registry in `config.ts` that resolves at auth time. Server-side enforcement is the contract: even if Claude attempts to invoke a Wiz tool outside the caller's allow-list, the request is rejected before reaching Wiz. This mirrors the existing executor RBAC pattern so the same security posture covers tools and MCP servers.

Notion source: [🛡️ Wiz MCP Server Integration](https://www.notion.so/3317b36249e2816f83dbc8f3088632ac). Grammarly's Wiz MCP rollout reported a 91% reduction in investigation time; the goal here is to give the SOC analyst the same correlation surface across Wiz and the existing Sentinel / Defender XDR / Entra tooling.

## Functional requirements

- A new `McpServerConfig` interface lives next to the existing tool/role config in `web/lib/config.ts` (or a sibling file) with fields: `type`, `url`, `name`, `authorization_token?`, `allowedTools?: string[]`, `allowedRoles: Role[]`.
- A new `getMcpServers(role: Role)` function returns the role-filtered array of MCP servers the agent loop should announce on the next Anthropic call. It pulls Wiz credentials from environment variables today (`WIZ_MCP_URL`, `WIZ_MCP_TOKEN`) with a near-term path to Key Vault (`kv-neovault-prod-001`). If Wiz uses OAuth client-credentials, the token exchange is performed inside `getMcpServers` and cached with a TTL.
- `web/lib/agent.ts` calls `getMcpServers(role)` immediately before the agent loop and spreads the result into `createWithRetry`'s `mcp_servers` parameter so the Wiz tools are available to Claude for that turn.
- The registry is built so future integrations (Abnormal Security, Lansweeper, AppOmni, ThreatLocker) plug into the same shape — Wiz is the first concrete server, not a one-off.
- The CLI surface needs no change beyond the natural-language prompt: the user types "show me all critical Wiz issues in production" and the agent loop transparently routes through the configured Wiz MCP server.
- Phase 1 ships read-only Wiz capabilities (issues, vulnerabilities, compliance, Defend threats). Any remediation/write action must flow through the existing destructive-action confirmation gate — the same `DESTRUCTIVE_TOOLS` pattern the executors use.
- Per-role server access (initial cut, per the Notion table):
  - **Security** — Wiz full read (issues, vulnerabilities, compliance, Defend, blast radius); remediation gated by confirmation
  - **Desktop Engineering** — Wiz read-only (issues, vulnerabilities, compliance); no Defend or remediation
  - **Help Desk** — no Wiz access
  - **Reader** — Wiz read-only (issues, compliance) — reporting-level queries only
- Audit logging: every MCP tool invocation emits an Event Hub event with `role`, `mcpServer`, `toolName` (and a hashed identity envelope), matching the structure of the existing executor logging.
- A new admin-only **Settings → Integrations** entry (or an extension of the existing "Integrations" tab) exposes a Wiz connection-test probe parallel to the existing ThreatLocker / Lansweeper / Abnormal probes in `web/app/api/integrations/[slug]/test/route.ts`.
- When the planned "Multi-Team System Prompt Architecture" refactor lands, the Wiz capability description is injected via the role-specific prompt module (e.g., `buildSecurityModule()` mentions Wiz; `buildHelpdeskModule()` does not). The MCP registry is the single source of truth that drives both prompt content and server availability.

## Possible Edge Cases

- **Wiz MCP server is unreachable** during a triage request. The agent loop must still produce a verdict — log a warning to Event Hub, exclude the Wiz server from the `mcp_servers` array for that turn, and continue. Fail-open posture matches the existing Cosmos / executor failure modes documented in other specs.
- **OAuth token expiry mid-conversation.** Token cache TTL needs a refresh-on-401 retry, similar to the existing `getAzureToken` pattern in `web/lib/auth.ts`. One transparent retry per call.
- **A role's `allowedTools` list drifts out of sync with Wiz's actual tool catalogue** (Wiz adds or renames a tool). The server-side enforcement layer must reject anything not on the allow-list rather than blindly forwarding — a Wiz-side rename should produce a clean 403-style refusal in the audit trail, not a silent pass-through.
- **A Help Desk user types "show me Wiz issues"** — the agent should respond that Wiz tooling isn't available for their role, not silently fail or expose tools they shouldn't have. Server-side filter at `getMcpServers` ensures the tools aren't announced; the prompt module ensures the agent doesn't gaslight by claiming capability it lacks.
- **Caller-allowlist drift between MCP servers and the existing triage caller allowlist.** Reuse the existing pattern in `triage-dispatch.ts → checkCallerAllowlist` so service-principal callers (Logic Apps) get the same scoping as interactive admins.
- **Audit event volume spike.** A long investigation might invoke 20+ Wiz tools per turn. Confirm the Event Hub sink batches these without dropping; the existing buffered sink (`FLUSH_INTERVAL_MS`) already handles bursts but worth re-checking under MCP load.
- **MCP server URL accidentally points at a non-Wiz endpoint** (env-var fat-finger). The connection-test probe should make a known harmless Wiz API call and fail loudly if the response shape isn't Wiz's.
- **Wiz's MCP transport changes from SSE to streamable HTTP** during the preview period. Pin the transport in `McpServerConfig.type` so a transport change shows up as a config diff rather than silently breaking.
- **Operator runs a Wiz query in MOCK_MODE.** Mirror the existing dual-source pattern: in mock mode, return a small canned fixture set so dev/test doesn't require real Wiz credentials.

## Acceptance Criteria

- [ ] A Security-role user can ask Neo "show me all critical Wiz issues in production" and receive results sourced from the live Wiz Security Graph via the MCP server.
- [ ] A Help Desk user asking the same question is told Wiz tooling isn't available for their role; no Wiz tool calls appear in the Anthropic request payload for that user's turns.
- [ ] A Desktop Engineering user can list Wiz issues and vulnerabilities but cannot invoke Wiz Defend or any remediation tool.
- [ ] All Wiz MCP tool calls (any role, any outcome) emit `mcp_invocation` audit events to Event Hub with the role, MCP server name, tool name, and the standard hashed identity envelope.
- [ ] Wiz credentials live in environment variables for Phase 1 with a documented Key Vault migration path; raw credentials never appear in logs or audit metadata.
- [ ] A new connection-test probe under `web/app/api/integrations/[slug]/test/route.ts` validates the Wiz MCP endpoint and credentials before the operator commits a new deployment.
- [ ] `MOCK_MODE=true` returns a fixture set so contributors can develop against the Wiz MCP path without real credentials.
- [ ] `docs/configuration.md` documents the new environment variables, the role → Wiz tool matrix, and the admin connection-test workflow.
- [ ] The `McpServerConfig` shape is generic enough that adding a second MCP server (Abnormal, Lansweeper, AppOmni, ThreatLocker) is a config-only change — no further changes to `agent.ts` or the prompt layer.
- [ ] All required CI checks pass (typecheck, lint, tests, CodeQL, gitleaks, all-checks aggregator).

## Open Questions

- **Transport — SSE vs streamable HTTP?** The Wiz official MCP server is in preview; pick the production transport and document the rationale. streamable HTTP. future proof it.
- **Token storage in Phase 1 — env vars only, or env vars + Key Vault read-through?** Operationally simplest is env vars now; Key Vault soon. Need confirmation that env vars are acceptable for the security role's bearer token even short-term. Key Vault.
- **Caching layer for MCP responses?** Wiz queries can be expensive (Security Graph traversals). Is there a request-level cache (per turn, per session, or global) we want to add, or do we let Wiz handle rate limiting and accept the latency? accept latency and address if it becomes an issue
- **Should the "Multi-Team System Prompt Architecture" refactor be a hard prerequisite, or do we ship Wiz scoping via a simpler `Role → string` description map first and migrate later?** The latter unblocks Wiz integration without waiting on the larger refactor. we havent implemented the multi team architecture yet. Go with existing permission model.
- **Per-tool allow-listing — string match or pattern?** With Wiz's tool catalogue growing during preview, do we want glob support (`wiz_get_*` for the Security role) or only exact tool names? glob support. 
- **Connection-test probe scope** — does it just verify auth (cheapest), or does it run a representative graph query to confirm the integration actually returns data the agent can consume? cheapest. 
- **Caller-allowlist alignment** — should service-principal Logic App callers automatically inherit the role mapping that drives MCP access, or is there a separate "Logic App can call MCP server X" list? logic app inherit role mapping

## Testing Guidelines

Create test files in `web/test/` covering at least:

- **`getMcpServers(role)` filtering** — each role returns the expected MCP server set with the expected `allowedTools` list; an unknown role returns an empty array; an unset `WIZ_MCP_URL` returns an empty array (graceful degradation, not a crash).
- **Token cache** — token is fetched once per TTL window; a 401 from Wiz triggers a single refresh-and-retry; a second 401 fails cleanly with an audit-logged error.
- **Server-side tool enforcement** — when Claude requests a Wiz tool not in the caller's `allowedTools` list, the dispatch layer rejects the call before any network egress, the request is logged with `result: blocked`, and the agent loop receives a structured "tool denied" response.
- **Audit log shape** — every Wiz invocation emits an event with the documented fields; no raw credentials, no raw UPN reach the metadata.
- **Mock mode** — `MOCK_MODE=true` returns the fixture set and never touches the network.
- **Connection-test probe** — admin-only; returns a structured success/failure body; failure modes (wrong URL, expired token, network error) each produce a distinct operator-readable message.
- **Agent loop integration** — a Security-role conversation includes `mcp_servers` in the Anthropic API call; a Help Desk conversation does not.
- **Failure mode** — when the Wiz MCP server is unreachable, the agent loop still produces a response; the failure is logged but the user-visible answer doesn't crash.
