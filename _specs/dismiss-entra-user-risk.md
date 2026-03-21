# Spec for Dismiss Entra User Risk

branch: claude/feature/dismiss-entra-user-risk

## Summary

Users flagged as high-risk in Microsoft Entra ID Identity Protection are blocked from logging in by conditional access policies. Analysts currently need to open the Entra portal to dismiss the risk after investigating. This feature adds a new destructive tool `dismiss_user_risk` that calls the Microsoft Graph `riskyUsers/dismiss` API to clear the risk state for a specified user, allowing analysts to complete the remediation workflow entirely from Neo.

## Functional requirements

- Add a new tool `dismiss_user_risk` (destructive, requires confirmation) that dismisses the risk state for a user in Entra ID Identity Protection
- The tool should accept: `upn` (required — the user principal name to dismiss risk for) and `justification` (required — reason for dismissing, written to audit log)
- Call the Microsoft Graph API `POST /beta/riskyUsers/dismiss` with the user's object ID in the `userIds` array
- The tool must resolve the user's object ID from their UPN first (using the existing Graph `/users/{upn}` lookup pattern)
- This is a destructive action — add to `DESTRUCTIVE_TOOLS` set, requires admin role and confirmation gate
- Follow the existing mock/live dual-path pattern
- Add the tool to the CLI color mapping and TOOL_DESCRIPTIONS

## Possible Edge Cases

- User UPN not found in Entra ID — return a clear error
- User has no active risk (risk level is "none") — the dismiss call should still succeed (idempotent), but the agent should note that no active risk was found
- The Graph `riskyUsers/dismiss` endpoint is on the `/beta` API — document this dependency
- Service principal lacks `IdentityRiskyUser.ReadWrite.All` permission — return a clear permission error
- Multiple users with similar UPNs — the tool operates on a single exact UPN match

## Acceptance Criteria

- An analyst can say "dismiss the risk for jsmith@goodwin.com" and Neo handles the full workflow with confirmation
- The confirmation gate fires before the dismiss action
- In mock mode, returns realistic simulated success data
- In live mode, resolves the user's object ID from UPN and calls the Graph dismiss endpoint
- The tool is admin-only (in DESTRUCTIVE_TOOLS)
- Tool color mapping and confirmation description are added to the CLI

## Open Questions

- Should the tool also show the user's current risk level and risk detections before dismissing, or should the analyst use `get_user_info` first? get_user_info already shows risk. get_user_info will work.
- Does the service principal need `IdentityRiskyUser.ReadWrite.All` specifically, or is a broader permission sufficient? Yes it needs IdentityRiskyUser.ReadWrite.All
- Should we support dismissing risk for multiple users at once, or keep it single-user? Single user.

## Testing Guidelines

Create test file(s) in the `./test` folder for the new feature, and create meaningful tests for the following cases:

- Mock dismiss returns a success response with expected fields
- Tool is in DESTRUCTIVE_TOOLS set
- Tool schema has `upn` and `justification` as required parameters
- UPN validation rejects invalid formats
