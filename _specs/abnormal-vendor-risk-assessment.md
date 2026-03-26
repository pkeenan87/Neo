# Spec for Abnormal Vendor Risk Assessment

branch: claude/feature/abnormal-vendor-risk-assessment

## Summary

Add tools for assessing vendor email compromise (VEC) risk using Abnormal Security's vendor intelligence APIs. This enables SOC analysts to check vendor risk levels, review vendor activity timelines, investigate vendor cases with look-alike domain detection, and identify internal contacts communicating with compromised vendors — all from the Neo conversation. Especially relevant for a law firm where vendor/client email trust relationships are high-value targets.

## Functional requirements

- Add a new tool `get_vendor_risk` (read-only) that retrieves vendor details from `GET /v1/vendors/{vendorDomain}`
  - Accepts: `vendor_domain` (required string)
  - Returns: risk level (High/Medium/Low), vendor contacts, company contacts, countries, IP addresses, analysis flags (e.g., "Vendor Compromise Seen in Abnormal Community")

- Add a new tool `list_vendors` (read-only) that lists all vendors from `GET /v1/vendors` with pagination
  - Accepts: `page_size` (optional, default 25), `page_number` (optional, default 1)
  - Returns: paginated vendor list with domain and risk level

- Add a new tool `get_vendor_activity` (read-only) that retrieves vendor event timeline from `GET /v1/vendors/{vendorDomain}/activity`
  - Accepts: `vendor_domain` (required string)
  - Returns: event timeline with timestamps, event types, suspicious domains, attack goals, actions taken, engagement status

- Add a new tool `list_vendor_cases` (read-only) that lists vendor cases from `GET /v1/vendor-cases`
  - Accepts: `filter` (optional: `firstObservedTime` or `lastModifiedTime`), `filter_value` (optional ISO-8601 datetime)
  - Returns: list of vendor cases with IDs and summary

- Add a new tool `get_vendor_case` (read-only) that retrieves full vendor case details from `GET /v1/vendor-cases/{caseId}`
  - Accepts: `case_id` (required string)
  - Returns: insights (look-alike domains, young sender domains, inconsistent registrars), message timeline with sender/recipient, subject, judgement, linked threat IDs

- All tools use the existing Abnormal Security integration auth (bearer token from `ABNORMAL_API_TOKEN` via Key Vault)
- All tools are read-only (available to all roles, no confirmation gate)
- All tools follow the existing mock/live dual-path pattern
- Add the new tool names to the Abnormal Security integration `capabilities` array in the registry
- Add all tools to the CLI color mappings

## Possible Edge Cases

- Vendor domain not found — return a clear message rather than a confusing API error
- Vendor with no activity — return empty timeline with a note
- Vendor case ID not found — clear 404 handling
- Pagination at the end of the list — handle empty pages gracefully
- API token not configured — clear error directing admin to Settings > Integrations

## Acceptance Criteria

- An analyst can say "what's the risk level for vendor domain example.com?" and Neo returns the vendor risk assessment
- An analyst can say "show me all high-risk vendors" and Neo lists vendors filtered by the agent
- Vendor cases with insights (look-alike domains, young domains) are clearly presented for VEC investigation
- All tools work in mock mode with realistic simulated data
- Auth reuses the existing Abnormal Security bearer token

## Open Questions

- Should we validate vendor domains with the same domain regex used elsewhere, or allow any string since the API will reject invalid domains? Validate with domain regex. same regex.
- Should vendor activity be paginated, or return all events? The API may return large event sets. Paginate with a sensible default. yes.

## Testing Guidelines

Create test file(s) in the `./test` folder for the new feature, and create meaningful tests for the following cases:

- Domain validation accepts valid domains and rejects invalid formats
- All 5 tools are NOT in DESTRUCTIVE_TOOLS (read-only)
- Tool schemas have expected required/optional parameters
- Mock data includes realistic vendor risk fields (riskLevel, vendorContacts, analysis)
