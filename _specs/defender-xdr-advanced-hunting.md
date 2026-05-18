# Spec for defender-xdr-advanced-hunting

branch: claude/feature/defender-xdr-advanced-hunting
figma_component (if used): n/a

## Summary

Add a Neo executor that runs KQL queries against the Microsoft Defender XDR Advanced Hunting API via Microsoft Graph. This gives Neo direct access to the full Defender XDR schema — including the `DeviceTvm*` vulnerability management tables that Sentinel's Defender XDR data connector does not stream. Without this executor, Neo cannot answer questions like "which devices are non-compliant with our antivirus baseline" or "which endpoints have CVEs with public exploit code" without sending the analyst to the Defender portal.

The executor follows the same shape as existing Neo data executors (Sentinel KQL, Wiz, etc.): tool schema in `web/lib/tools.ts`, executor function in `web/lib/executors.ts`, mock/live dual path gated on `MOCK_MODE`, normalized tabular output for the agent loop to reason over.

## Functional requirements

- Expose a new tool, e.g. `run_defender_hunting_query`, registered in `TOOLS` in `web/lib/tools.ts`.
- Input shape: `{ query: string }`. KQL query string is the only required parameter.
- Executor calls `POST https://graph.microsoft.com/v1.0/security/runHuntingQuery` with the query in the request body.
- Auth: reuse the existing Graph OAuth client credentials flow (`getMSGraphToken()` in `auth.ts`). The app registration needs the `ThreatHunting.Read.All` application permission added.
- Response handling: normalize the Graph response (which returns `Schema` + `Results`) into a tabular result set consistent with how other data executors return rows. The agent should see `{ columns: [...], rows: [...] }` or an equivalent shape that's already used elsewhere.
- Surface result metadata in the response: row count, truncation indicator, query duration if available.
- Mock-mode path: when `MOCK_MODE=true`, return canned `DeviceTvm*` rows (mix of compliance, vulnerability, and inventory examples) so the agent loop can be exercised without live credentials.
- Document the new tool in the system prompt / tool description so the agent knows when to reach for it versus the existing Sentinel KQL executor (rule of thumb: TVM / device posture / software inventory → Defender XDR; signals streamed into Sentinel → Sentinel).

### Client-side limits to enforce

The Advanced Hunting API enforces several limits server-side. The executor should fail fast on the obvious ones rather than wait for the API to reject:

- 30-day query window (API-enforced; executor can warn if a `TimeGenerated` filter clearly exceeds 30d).
- 100,000-row result cap (API-enforced; surface clearly if the response indicates truncation).
- 200-second per-request execution timeout (set `fetch` timeout slightly above this).
- 124 MB max response size (let the API enforce; surface the failure clearly).
- Tenant quota: 45 calls/min, 1,500 calls/hour, 10 min execution/hour, 3 hours execution/day.

### 429 / quota handling

When the API returns 429, the executor must distinguish **request-rate** quota exhaustion from **CPU-time** quota exhaustion based on the response body and surface that distinction to the agent. The agent's downstream messaging should make it obvious to the analyst whether to retry shortly (rate quota) or wait until the hour/day window rolls over (CPU quota).

## Figma Design Reference (only if referenced)

n/a — backend-only feature, no UI changes required.

## Possible Edge Cases

- Query returns 0 rows — return an empty tabular result, not an error.
- Query is syntactically invalid KQL — surface the Graph error message verbatim so the agent can self-correct on the next loop iteration.
- 429 Too Many Requests — distinguish request-rate from CPU-time quota and propagate the distinction.
- Result set hits the 100,000-row API cap — flag truncation in the executor's return value.
- Tenant lacks the `ThreatHunting.Read.All` permission consent — return a clear, actionable error (not the raw 403 body).
- Long-running query approaches the 200-second timeout — make sure the executor's own timeout fires *after* the server's, so we always get the server's error message instead of a generic client abort.
- Very large but under-cap responses (tens of MB) — confirm the JSON parse and context manager handle the size without blowing the per-tool-result token cap (`context-manager.ts` already truncates to 50K tokens).
- Tenants that don't have Defender XDR licensed — the API will reject; surface that clearly.
- Multi-tenant note: the executor should work against whichever tenant `AZURE_TENANT_ID` is set to and not assume a hardcoded environment.
- Prompt injection via KQL output — table contents (e.g., `DeviceName`, software publisher strings) could contain hostile text. Defer to the existing `injection-guard.ts` patterns used by other executors.

## Acceptance Criteria

- A new tool is registered in `web/lib/tools.ts` and routed in `web/lib/executors.ts`.
- `MOCK_MODE=true` returns plausible canned data for at least three of the TVM tables (e.g. `DeviceTvmSecureConfigurationAssessment`, `DeviceTvmSoftwareVulnerabilities`, `DeviceTvmSoftwareInventory`).
- `MOCK_MODE=false` against a real tenant successfully runs a `DeviceTvmSoftwareInventory | take 5` style query and returns rows.
- 429 responses are correctly classified as request-rate vs CPU-time and surfaced distinctly.
- Truncation at 100,000 rows is surfaced in the executor's response.
- Existing Sentinel KQL executor still works and is not regressed.
- System prompt (or tool description) guides the agent on when to use this versus Sentinel KQL.
- The new app registration permission (`ThreatHunting.Read.All`) is documented in the repo's environment / deployment notes alongside other Graph scopes.
- CI checks pass (typecheck, lint, tests).

## Open Questions

- Should we expose this in the CLI as well, or gate to Teams/Web initially? (CLI is now a thin client over the web server, so exposing it on the web side likely propagates automatically — confirm.) yes CLI too.
- Role gating: restrict to SOC / VM analyst roles, or open to all Neo users with existing RBAC? all users for now.
- Do we want a helper that auto-joins `*KB` tables when the corresponding fact table is referenced, or leave that to the analyst's KQL? leave that to the analyst
- Do we want a soft client-side rate limiter (token bucket against the 45/min and 1,500/hour tenant quotas) to avoid burning quota on agent-driven query loops, or rely on the API's 429s as the only signal? rely on 429.
- Should we cache identical query results briefly (e.g. 60s) to absorb agent loop re-issues of the same query? no.

## Testing Guidelines

Create a test file in the `./test` folder for the new feature, and create meaningful tests for the following cases, without going too heavy:

- Mock-mode happy path: executor returns the canned tabular shape with non-empty rows and a `columns` descriptor.
- Mock-mode covers all the seeded TVM tables (compliance, vulns, inventory) so the agent loop can exercise representative queries.
- Live path (mocked `fetch`) — verify the request goes to `POST https://graph.microsoft.com/v1.0/security/runHuntingQuery` with the query in the body and a bearer token in the `Authorization` header.
- 429 response with a request-rate quota body — executor classifies as rate-quota.
- 429 response with a CPU-time quota body — executor classifies as CPU-quota.
- Truncation marker — when the API indicates the result was capped, the executor's return value flags truncation.
- Invalid KQL — Graph returns 4xx with an error message; executor surfaces it verbatim to the agent.
- Missing permission consent (403) — executor returns an actionable error message rather than the raw 403.
- Tool routing — the new tool is registered in the executor router and reachable via `executeTool("run_defender_hunting_query", ...)`.
