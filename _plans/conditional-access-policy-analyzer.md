# Conditional Access Policy Analyzer

## Context

Conditional Access is the primary enforcement layer for Zero Trust. Gaps in CA coverage — especially for service principals and legacy auth — are high-risk blind spots. This plan adds three read-only tools to retrieve CA policies, individual policy details, and named locations from Microsoft Graph. Auth uses the existing `getMSGraphToken()`. The tools pair with Neo's existing `run_sentinel_kql` tool for gap analysis: Claude pulls policy config, then runs KQL queries against sign-in logs to find uncovered activity. Requires `Policy.Read.All` permission on the app registration.

---

## Key Design Decisions

- **Three tools** — `list_ca_policies` (all policies), `get_ca_policy` (single by ID), `list_named_locations` (IP/country locations). All read-only.
- **Graph token reuse** — `getMSGraphToken()` already used by `get_user_info`, `reset_user_password`, `dismiss_user_risk`, and email tools. Just needs `Policy.Read.All` permission added.
- **v1.0 with beta fallback** — `list_ca_policies` tries v1.0 first. If any policy errors due to preview features, retries that specific policy via `/beta`. For the initial implementation, just use beta endpoint directly since it's a superset of v1.0 and avoids the retry complexity.
- **`resolve_names` parameter** — optional boolean on `list_ca_policies` and `get_ca_policy`. When true, resolves user/group/role/app GUIDs to display names via batch Graph calls. Off by default for speed.
- **Named location resolution** — `list_named_locations` returns the full location set so Claude (or the analyst) can cross-reference location GUIDs in policies. No separate per-location tool needed since the full set is small.
- **Part of Entra ID integration** — tools added to the existing `microsoft-entra-id` integration capabilities (not a new integration).

---

## Files to Change

| File | Change |
|------|--------|
| `web/lib/types.ts` | Add `ListCaPoliciesInput`, `GetCaPolicyInput`, `ListNamedLocationsInput` interfaces |
| `web/lib/tools.ts` | Add 3 tool schemas (all read-only, none in DESTRUCTIVE_TOOLS) |
| `web/lib/executors.ts` | Add 3 executor functions using `getMSGraphToken()`; add `resolveGraphNames()` helper; register in executors record |
| `web/lib/integration-registry.ts` | Add 3 tool names to Microsoft Entra ID capabilities array |
| `cli/src/index.js` | Add 3 TOOL_COLORS entries (blue, matching other Graph/identity tools) |
| `docs/configuration.md` | Add `Policy.Read.All` to API permissions table |
| `docs/user-guide.md` | Add 3 tools to tool reference table (All role) |
| `README.md` | Add 3 tools to tools table (Read-only) |
| `test/conditional-access-policies.test.js` | New test file |

---

## Implementation Steps

### 1. Add input types in `web/lib/types.ts`

- `ListCaPoliciesInput`: `resolve_names` (optional boolean)
- `GetCaPolicyInput`: `policy_id` (required string), `resolve_names` (optional boolean)
- `ListNamedLocationsInput`: no required params (empty interface with optional pagination if needed)

### 2. Add tool schemas in `web/lib/tools.ts`

- Add `list_ca_policies` after the existing Entra ID tools (after `dismiss_user_risk`):
  - Description: "List all Conditional Access policies from Microsoft Entra ID. Returns policy names, states, conditions (users, apps, locations, platforms, risk levels), grant controls (MFA, block, compliant device), and session controls. Set resolve_names to resolve GUIDs to display names."
  - Properties: `resolve_names` (optional boolean)
- Add `get_ca_policy`:
  - Description: "Get full details of a specific Conditional Access policy by ID."
  - Properties: `policy_id` (required string), `resolve_names` (optional boolean)
- Add `list_named_locations`:
  - Description: "List all named locations configured in Conditional Access. Returns IP-based locations (CIDR ranges) and country-based locations. Useful for resolving location GUIDs referenced in CA policies."
  - No required properties
- None added to DESTRUCTIVE_TOOLS

### 3. Add executor functions in `web/lib/executors.ts`

- Import the 3 new input types

**`resolveGraphNames` helper**:
- Takes an array of GUIDs and a type hint (`user`, `group`, `role`, `application`)
- Calls the appropriate Graph API endpoint to resolve display names
- Uses `Promise.allSettled` to handle individual lookup failures gracefully
- Returns a `Record<string, string>` mapping GUID → display name
- Capped at 50 GUIDs per call to avoid throttling

**`list_ca_policies`**:
- Validate inputs
- Mock returns 3 realistic CA policies (MFA for all users, block legacy auth, require compliant devices for admins) with different states (enabled, report-only, enabled)
- Live: get Graph token via `getMSGraphToken()`, call `GET /beta/identity/conditionalAccess/policies` (use beta to support all policy types)
- If `resolve_names` is true, collect unique GUIDs from all policies' conditions blocks, call `resolveGraphNames`, then annotate each GUID reference with the resolved name

**`get_ca_policy`**:
- Validate policy_id is non-empty
- Mock returns a single detailed policy
- Live: call `GET /beta/identity/conditionalAccess/policies/{policyId}`, optionally resolve names

**`list_named_locations`**:
- Mock returns 2 locations (one IP-based with CIDRs, one country-based)
- Live: call `GET /v1.0/identity/conditionalAccess/namedLocations` (named locations work fine on v1.0)

- Register all 3 in the executors record

### 4. Update integration registry

- Add the 3 tool names to the `microsoft-entra-id` integration's `capabilities` array

### 5. CLI colors

- Add all 3 to TOOL_COLORS with `chalk.blue` (matching other Graph/identity tools)

### 6. Update docs

- `docs/configuration.md`: Add `Policy.Read.All` (Microsoft Graph) to the API permissions table
- `docs/user-guide.md`: Add 3 tools (All role)
- `README.md`: Add 3 tools (Read-only)

### 7. Write tests in `test/conditional-access-policies.test.js`

- All 3 tools NOT in DESTRUCTIVE_TOOLS
- `list_ca_policies` has no required params; `get_ca_policy` requires policy_id
- Mock policy data has expected fields (displayName, state, conditions, grantControls)
- Mock named locations include both IP and country types with expected fields
- Policy ID validation rejects empty strings

---

## Verification

1. Run `node --experimental-strip-types --test test/conditional-access-policies.test.js` — all tests pass
2. Run `cd web && npx next build` — build succeeds
3. Start dev server with `MOCK_MODE=true`, ask "show me all my conditional access policies" — verify mock policies returned
4. Ask "which policies are in report-only mode?" — verify Claude filters from the mock data
5. Verify `Policy.Read.All` is in the docs permissions table
