# Spec for Abnormal Employee Risk Profile

branch: claude/feature/abnormal-employee-risk-profile

## Summary

Add tools for pulling employee organizational context and behavioral Genome data from Abnormal Security. This gives SOC analysts identity-aware investigation capabilities — checking an employee's normal login patterns, baseline IP addresses, devices, and locations — so they can quickly determine whether observed activity is anomalous during account takeover or phishing investigations.

## Functional requirements

- Add a new tool `get_employee_profile` (read-only) that combines employee info and identity analysis in a single call
  - Accepts: `email` (required string — the employee's email address)
  - Calls both `GET /v1/employee/{email}` (name, title, manager) and `GET /v1/employee/{email}/identity-analysis` (behavioral Genome histograms) in parallel
  - Returns: combined result with employee details and Genome data (common IPs, sign-in locations, devices, browsers with ratios and raw counts)

- Add a new tool `get_employee_login_history` (read-only) that retrieves the 30-day login CSV
  - Accepts: `email` (required string)
  - Calls `GET /v1/employee/{email}/login-csv`
  - Returns: parsed login history with IP addresses, locations, timestamps, devices

- All tools use the existing Abnormal Security integration auth (bearer token from `ABNORMAL_API_TOKEN`)
- All tools are read-only (available to all roles, no confirmation gate)
- All tools follow the existing mock/live dual-path pattern
- Add the new tool names to the Abnormal Security integration `capabilities` array
- Add tools to CLI color mappings
- Validate email format before API calls using the existing `validateSenderEmail` from `abnormal-helpers.ts`

## Possible Edge Cases

- Employee email not found in Abnormal — return a clear error rather than a confusing 404
- Employee has no Genome data (new employee, no login history) — return empty histograms with a note
- Login CSV response is plain text, not JSON — parse it into a structured format before returning
- Very large login CSV (30 days of frequent logins) — consider truncating or summarizing

## Acceptance Criteria

- An analyst can say "what's the normal login pattern for jsmith@goodwin.com?" and Neo returns the Genome baseline data
- An analyst can say "pull the login history for jsmith@goodwin.com" and Neo returns the 30-day login CSV as structured data
- Both tools work in mock mode with realistic simulated data
- Auth reuses the existing Abnormal Security bearer token

## Open Questions

- Should `get_employee_profile` combine both the info and identity-analysis calls, or keep them separate? Combine them per the Notion note.
- Should the login CSV be parsed into JSON or returned as raw text? Parse into JSON for the agent to analyze.

## Testing Guidelines

Create test file(s) in the `./test` folder for the new feature, and create meaningful tests for the following cases:

- Email validation accepts valid emails and rejects invalid formats
- Both tools are NOT in DESTRUCTIVE_TOOLS (read-only)
- Tool schemas have expected required parameters (email)
- Mock employee profile data includes expected fields (name, title, manager, histograms)
