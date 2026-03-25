# Spec for Abnormal Security Message Search & Remediate Tool

branch: claude/feature/abnormal-message-search

## Summary

Neo executor that integrates with Abnormal Security's Search & Respond API to query messages across the entire mailbox estate and take bulk remediation actions. This is a two-tool design: a read-only search tool and a destructive remediate tool, enabling a search-first-then-act workflow critical for incident response containment of active phishing campaigns.

## Functional requirements

- **Message search (`search_abnormal_messages`)**: Query the Abnormal Security `POST /v1/search` endpoint with filters for sender email, sender name, recipient email, subject, attachment name, attachment MD5 hash, body URL, sender IP, judgement (attack/borderline/spam/graymail/safe), source (abnormal/quarantine), and time range. Returns message count and paginated message list.
- **Bulk remediation (`remediate_abnormal_messages`)**: Call `POST /v1/search/remediate` with an action (delete, move_to_inbox, submit_to_d360, reclassify), a remediation reason (false_negative, misdirected, unsolicited, other), and either an explicit message list or `remediate_all` with search filters. This is a destructive tool requiring confirmation.
- **Remediation status (`get_abnormal_remediation_status`)**: Call `GET /v1/search/activities/{activityLogId}` to check the status of a previously submitted remediation action. Read-only.
- **Two-step workflow**: The agent should search first to show results, then the user confirms before remediation is executed. The remediate tool must be in the `DESTRUCTIVE_TOOLS` set.
- **Pagination**: Search supports `page_number` and `page_size` (max 1000). Default to a reasonable page size (e.g. 50) and surface total count so the agent knows if there are more results.
- **Time range defaults**: Default to last 48 hours if no time range is specified.
- **Mock/Live dual-path**: Mock mode returns realistic sample data for all three endpoints; live mode calls `https://api.abnormalsecurity.com` with Bearer token auth.
- **Secrets**: Requires `ABNORMAL_API_TOKEN` stored in Key Vault (via `getToolSecret()`).

## Possible Edge Cases

- Search returns zero results — return a clear "no messages found" response.
- Search returns thousands of results — paginate and surface total count; warn the agent if `remediate_all` would affect a large number of messages.
- Invalid attachment hash format (not a valid MD5) — validate before sending to API.
- Remediation on an empty message list — reject with a clear error.
- API rate limiting — surface the 429 status clearly so the agent can wait and retry.
- Activity log ID not found — return a descriptive "not found" message.
- Token expired or invalid — surface a clear auth failure message without leaking the token.

## Acceptance Criteria

- `search_abnormal_messages` returns message count, message list with sender/recipient/subject/timestamp/judgement, and pagination info.
- `remediate_abnormal_messages` is registered in `DESTRUCTIVE_TOOLS` and requires confirmation before execution.
- `remediate_abnormal_messages` returns the activity log ID so status can be tracked.
- `get_abnormal_remediation_status` returns the current status (pending, in_progress, completed, failed) of a remediation action.
- Mock mode returns believable sample data for all three tools.
- All three tools are registered in `tools.ts`, `executors.ts`, and the `executors` router.
- Abnormal Security is registered in `integration-registry.ts` with `ABNORMAL_API_TOKEN` as a required secret.
- Error messages from the Abnormal API are logged server-side only — not forwarded raw to the caller.
- `.env.example` includes the `ABNORMAL_API_TOKEN` placeholder.

## Open Questions

- Should the tool support EML download (`POST /v1/search/download-eml`) for forensic analysis, or defer that to a future tool? future tool.
- Should `remediate_all` (applying remediation to all search results without listing them) be supported, or should we require explicit message IDs to prevent accidental mass deletion? remediate_all should be supported.
- Is there a maximum number of messages that can be remediated in a single API call? check the abnormal api docs.
- Should we support the `reclassify` action, or limit to delete/move_to_inbox/submit_to_d360 initially? just those three initially.

## Testing Guidelines
Create a test file(s) in the ./test folder for the new feature, and create meaningful tests for the following cases, without going too heavy
- Mock search returns expected message structure with all fields
- Search with no filters defaults to 48-hour time range
- MD5 hash validation accepts valid hashes and rejects invalid ones
- Mock remediation returns an activity log ID
- Remediation with empty message list is rejected
- Activity status returns expected status fields
- Error handling for auth failures does not leak token
