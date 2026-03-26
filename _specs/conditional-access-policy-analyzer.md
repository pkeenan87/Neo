# Spec for Conditional Access Policy Analyzer

branch: claude/feature/conditional-access-policy-analyzer

## Summary

Add tools to retrieve and analyze Conditional Access (CA) policy configurations from Microsoft Graph. CA is the primary enforcement layer for Zero Trust — gaps in coverage (especially for service principals and legacy auth) are high-risk blind spots. The real power is pairing policy retrieval with Neo's existing KQL tool: Claude pulls the full policy set, runs targeted sign-in log queries to find activity not covered by policies, and synthesizes the gaps conversationally. This replaces a manual, tedious process in the Entra admin center.

## Functional requirements

- Add a new tool `list_ca_policies` (read-only) that retrieves all Conditional Access policies from `GET /v1.0/identity/conditionalAccess/policies` via Microsoft Graph
  - Returns: full policy objects with display name, state (enabled/disabled/report-only), conditions (users, groups, roles, apps, platforms, locations, client app types, risk levels, service principals), grant controls (MFA, compliant device, block), session controls, and timestamps
  - Tries v1.0 first; if a policy errors due to preview features, falls back to `/beta` endpoint
  - Supports optional `resolve_names` boolean parameter that resolves GUIDs to display names (users, groups, roles, apps, named locations) using batch Graph calls

- Add a new tool `get_ca_policy` (read-only) that retrieves a single policy by ID from `GET /v1.0/identity/conditionalAccess/policies/{policyId}`
  - Accepts: `policy_id` (required string), `resolve_names` (optional boolean)
  - Returns: full policy object with optional name resolution

- Add a new tool `list_named_locations` (read-only) that retrieves named locations from `GET /v1.0/identity/conditionalAccess/namedLocations`
  - Returns: IP-based locations (CIDR ranges with isTrusted flag) and country-based locations (ISO 3166-1 codes)
  - Needed because policies reference locations by GUID — this resolves them

- Auth uses the existing `getMSGraphToken()` — same token as other Graph tools. Requires `Policy.Read.All` application permission.
- All tools are read-only (available to all roles, no confirmation gate)
- All tools follow the existing mock/live dual-path pattern with validation before mock
- Add tools to the Microsoft Entra ID integration `capabilities` array (since CA is part of Entra)
- Add tools to CLI color mappings

## Possible Edge Cases

- Policies using preview features fail on v1.0 — fall back to beta endpoint
- GUID resolution for large numbers of users/groups — batch or cap to avoid Graph throttling
- Named locations referenced by policies that have been deleted — handle missing IDs gracefully
- Tenant with 50+ policies — paginate using `$top`/`$skip` or return all (Graph returns all by default for small sets)
- `resolve_names` with many unique GUIDs — cap batch resolution to prevent 429s

## Acceptance Criteria

- An analyst can say "show me all my CA policies" and Neo returns the full policy set with human-readable status
- An analyst can say "which policies are in report-only mode?" and Neo filters from the policy list
- Named locations are resolved from GUIDs to CIDR ranges / country names
- Claude can pair policy data with KQL sign-in log queries to identify coverage gaps
- All tools work in mock mode with realistic simulated CA policy data

## Open Questions

- Should `resolve_names` be on by default or off? Off by default for speed — Claude can request resolution when needed.
- Should we add the gap analysis KQL queries as a Neo skill, or let Claude compose them naturally? Let Claude compose — the KQL queries in the Notion note are examples the system prompt can reference.
- Should we add `Policy.Read.All` to the docs permissions table? Yes.

## Testing Guidelines

Create test file(s) in the `./test` folder for the new feature, and create meaningful tests for the following cases:

- All 3 tools are NOT in DESTRUCTIVE_TOOLS (read-only)
- Tool schemas: list has no required params, get requires policy_id, named locations has no required params
- Mock policy data includes expected fields (displayName, state, conditions, grantControls)
- Mock named locations include both IP and country types
