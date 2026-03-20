# Spec for ThreatLocker Approval Requests

branch: claude/feature/threatlocker-approval-requests

## Summary

ThreatLocker approval requests currently require analysts to switch to the ThreatLocker portal to review, approve, or deny application/elevation requests. This feature adds a net-new ThreatLocker integration — including secrets management via the integrations system, new tools for listing and managing approval requests, and the ability for Neo to analyze requests from a security perspective before the analyst decides to approve or deny.

## Functional requirements

- Register ThreatLocker as a new integration in `web/lib/integration-registry.ts` with its required secrets (API key/token and portal URL)
- Add a new tool `list_threatlocker_approvals` (read-only) that queries the ThreatLocker Portal API (`/portalAPI/ApprovalRequest`) to list pending approval requests
  - Returns: request ID, requesting user, computer/group, application name, file hash, request reason, timestamp, status
  - Supports optional filters: status (pending/approved/denied), computer group, time range
- Add a new tool `get_threatlocker_approval` (read-only) that retrieves full details of a specific approval request by ID, including the application details from `/portalAPI/Application`
- Add a new tool `approve_threatlocker_request` (destructive, requires confirmation) that approves a pending approval request via the ThreatLocker API
  - Accepts: request ID, approval duration (e.g., 1 hour, 4 hours, permanent), justification
- Add a new tool `deny_threatlocker_request` (destructive, requires confirmation) that denies a pending approval request
  - Accepts: request ID, justification
- All tools should follow the existing mock/live dual-path pattern
- The integration secrets (API key and portal URL) should be configurable via the Settings > Integrations page, using the existing Key Vault storage pattern
- Add all tools to the CLI color mappings

## Possible Edge Cases

- ThreatLocker API key is not configured — return a clear error directing the admin to configure the integration in Settings
- Approval request has already been approved/denied by another analyst — handle the conflict response gracefully
- Request ID not found — clear error message
- ThreatLocker API rate limits — handle 429 responses with appropriate error messages
- Computer group or application details not resolvable — return what's available without failing
- Very large number of pending approvals — support pagination with a reasonable default limit (e.g., 25)

## Acceptance Criteria

- ThreatLocker appears as a configurable integration in Settings > Integrations with API key and portal URL fields
- An analyst can say "show me pending ThreatLocker approval requests" and Neo lists them
- Neo can analyze a request from a security perspective (file hash, application name, requesting user context)
- An analyst can approve or deny a request through the conversation with confirmation
- All tools work in mock mode with realistic simulated data
- Approve/deny go through the confirmation gate (destructive tools)
- Tool color mappings and descriptions are added to the CLI

## Open Questions

- What is the ThreatLocker API authentication format — bearer token, API key header, or basic auth? read this - api key https://threatlocker.kb.help/processing-application-control-approval-requests-through-api/ and this https://github.com/DynamicIT/ThreatLocker/tree/main
- What is the base URL format for the portal API — is it `https://<portal>.threatlocker.com/portalAPI/` or tenant-specific? base url is the same, you pass an org ID as referenced here https://threatlocker.kb.help/processing-application-control-approval-requests-through-api/ 
- Should Neo cross-reference the requesting user with Entra ID to provide additional context (e.g., department, risk level)? no save that for a skill.
- What approval duration options does ThreatLocker support — is it a fixed set of choices or a free-form duration? read this https://threatlocker.kb.help/processing-application-control-approval-requests-through-api/ 
- Does the ThreatLocker API support filtering approvals by status, or does it return all and we filter client-side? read this 

## Testing Guidelines

Create test file(s) in the `./test` folder for the new feature, and create meaningful tests for the following cases:

- Mock list response returns realistic approval request data with expected fields
- Mock approval/denial returns a success response
- Approve and deny tools are in DESTRUCTIVE_TOOLS set
- List and get-detail tools are NOT in DESTRUCTIVE_TOOLS set
- Tool schemas have expected required/optional parameters
- Integration registry includes ThreatLocker with the correct secrets definition
