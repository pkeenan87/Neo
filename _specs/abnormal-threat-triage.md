# Spec for Abnormal Threat Triage

branch: claude/feature/abnormal-threat-triage

## Summary

Add tools for listing and investigating email threats from Abnormal Security's threat intelligence API. This is the highest-frequency SOC use case — every triage session starts with reviewing recent threats. Analysts can list unremediated threats by time range, get full threat details with attack metadata, and drill into specific threats for sender analysis, attachment inspection, and remediation status.

## Functional requirements

- Add a new tool `list_abnormal_threats` (read-only) that queries `GET /v1/threats` with time-based filtering
  - Accepts: `start_time` (optional ISO-8601 datetime), `end_time` (optional ISO-8601 datetime), `page_size` (optional, default 25), `page_number` (optional, default 1)
  - If neither start_time nor end_time is provided, defaults to the last 24 hours
  - Constructs filter parameter: `receivedTime gte {start} lte {end}`
  - Returns: paginated list of threat IDs and summaries

- Add a new tool `get_abnormal_threat` (read-only) that retrieves full threat details from `GET /v1/threats/{threatId}`
  - Accepts: `threat_id` (required string)
  - Returns: full threat details including attack type/strategy/vector, summary insights, sender info (address, IP, domain), recipients, attachments, URLs, remediation status, impersonated/attacked party, portal link

- All tools use the existing Abnormal Security integration auth (bearer token from `ABNORMAL_API_TOKEN`)
- All tools are read-only (available to all roles, no confirmation gate)
- All tools follow the existing mock/live dual-path pattern
- Add the new tool names to the Abnormal Security integration `capabilities` array
- Add tools to CLI color mappings
- Note: the Notion issue references base URL `https://api.abnormalplatform.com/v1` but the existing Abnormal integration uses `https://api.abnormalsecurity.com` — verify which is correct and use the existing `ABNORMAL_BASE_URL` constant if applicable

## Possible Edge Cases

- Very large threat list — pagination with sensible defaults (25 per page, capped at 100)
- Threat ID not found — clear 404 handling
- Time filter with invalid dates — validate ISO-8601 format before constructing the filter
- Time range spanning many days — the API may return very large result sets; cap at reasonable page sizes
- API token not configured — clear error directing admin to Settings > Integrations

## Acceptance Criteria

- An analyst can say "show me threats from the last 24 hours" and Neo returns the threat list
- An analyst can say "get details on threat {id}" and Neo returns the full investigation data
- Both tools work in mock mode with realistic simulated threat data
- Auth reuses the existing Abnormal Security bearer token and base URL

## Open Questions

- The Notion note uses `https://api.abnormalplatform.com/v1` but existing tools use `https://api.abnormalsecurity.com`. Which is the correct base URL for the threats endpoint? Use whichever the existing integration uses.
- Should `list_abnormal_threats` auto-paginate and return all threats, or return one page at a time? One page at a time — let the agent decide if it needs more.

## Testing Guidelines

Create test file(s) in the `./test` folder for the new feature, and create meaningful tests for the following cases:

- Default time range is last 24 hours when no params provided
- Time filter validation rejects invalid ISO-8601 strings
- Both tools are NOT in DESTRUCTIVE_TOOLS (read-only)
- Tool schemas have expected required/optional parameters
- Mock threat data includes expected fields (attackType, summaryInsights, fromAddress, remediationStatus)
