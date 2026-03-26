# Spec for Abnormal ATO Case Investigator

branch: claude/feature/abnormal-ato-case-investigator

## Summary

Add tools for investigating Account Takeover (ATO) cases from Abnormal Security. This is the most complex investigation type and where Claude's synthesis ability adds the most value — correlating impossible travel events, mail rule changes, suspicious sign-ins, and lateral phishing into a coherent narrative. The tools cover listing cases, retrieving full case details with analysis timelines, and taking action on cases (acknowledge, action required).

## Functional requirements

- Add a new tool `list_ato_cases` (read-only) that queries `GET /v1/cases` with time-based filtering
  - Accepts: `filter_value` (optional ISO-8601 datetime for `lastModifiedTime` filter), `page_size` (optional, default 25), `page_number` (optional, default 1)
  - Returns: paginated list of ATO cases with case IDs, severity, affected employee, status

- Add a new tool `get_ato_case` (read-only) that combines case details and analysis/timeline in a single call
  - Accepts: `case_id` (required string)
  - Calls both `GET /v1/cases/{caseId}` and `GET /v1/cases/{caseId}/analysis-and-timeline` via `Promise.allSettled`
  - Returns: combined result with case details (severity, affected employee, status, remediation status, GenAI summary, linked threat IDs) and full analysis timeline (insights with signals, risk events with impossible travel/risky locations, mail rule changes, suspicious sign-ins, lateral phishing indicators)

- Add a new tool `action_ato_case` (destructive, requires confirmation) that takes action on an ATO case via `POST /v1/cases/{caseId}`
  - Accepts: `case_id` (required string), `action` (required: `"action_required"` or `"acknowledge"`), `justification` (required string)
  - Returns: action ID and status URL for tracking

- All tools use the existing Abnormal Security integration auth (bearer token from `ABNORMAL_API_TOKEN`)
- `list_ato_cases` and `get_ato_case` are read-only (available to all roles)
- `action_ato_case` is destructive (admin-only, requires confirmation gate)
- All tools follow the existing mock/live dual-path pattern with validation before mock
- Add the new tool names to the Abnormal Security integration `capabilities` array
- Add tools to CLI color mappings and TOOL_DESCRIPTIONS for the action tool

## Possible Edge Cases

- Case ID not found — clear 404 handling
- Analysis/timeline endpoint fails but case details succeed — return partial results with `_partial` flag and `_errors` (same pattern as `get_employee_profile`)
- Case has no timeline events (new case, not yet analyzed) — return empty timeline with a note
- Action on an already-acknowledged case — the API may return a specific response; handle gracefully
- Time filter with invalid date — validate ISO-8601 before constructing filter

## Acceptance Criteria

- An analyst can say "walk me through ATO case 12345" and Neo returns the full case narrative with timeline
- An analyst can say "show me all active ATO cases" and Neo lists cases with severity and status
- An analyst can acknowledge an ATO case through Neo with confirmation
- All tools work in mock mode with realistic simulated ATO data
- Auth reuses the existing Abnormal Security bearer token

## Open Questions

- Should `get_ato_case` flag `DELETE_ALL` mail rule conditions as high-severity in the response, or let Claude decide? Let Claude decide based on the data.
- Should `action_ato_case` support any actions beyond `action_required` and `acknowledge`? Just those two for now.

## Testing Guidelines

Create test file(s) in the `./test` folder for the new feature, and create meaningful tests for the following cases:

- Time filter validation rejects invalid ISO-8601 strings
- `list_ato_cases` and `get_ato_case` are NOT in DESTRUCTIVE_TOOLS
- `action_ato_case` IS in DESTRUCTIVE_TOOLS
- Tool schemas: list has no required params, get requires case_id, action requires case_id + action + justification
- Mock case data includes expected fields (severity, affectedEmployee, genai_summary, timeline insights)
