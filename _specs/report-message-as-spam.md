# Spec for Report Message as Spam

branch: claude/feature/report-message-as-spam

## Summary

When users submit phishing inquiries to the security team, analysts currently have to instruct the user to report the message themselves. This feature adds the ability for Neo to find a specific email message in a user's mailbox via Microsoft Graph and report it as spam/phishing on their behalf — streamlining the phishing triage workflow so analysts can handle the entire process from the investigation conversation.

## Functional requirements

- Add a new tool `search_user_messages` (read-only) that searches a user's Exchange Online mailbox via Microsoft Graph to find specific messages by sender, subject, and/or date range - do we need this? Or can we do the same thing with Sentinel? I am ok adding another tool if it is more efficient.
- Add a new tool `report_message_as_phishing` (destructive, requires confirmation) that reports a specific message as phishing/spam on behalf of the user
- The search tool should accept: recipient UPN (required), sender email or display name (optional), subject text (optional), and a time range (optional, default 7 days)
- The search tool returns a list of matching messages with: message ID, subject, sender, received date, preview snippet, and whether the message has attachments
- The report tool should accept: recipient UPN (required), message ID (required), report type (`phishing` or `junk`, default `phishing`), and justification (required for audit log)
- The report action should use the Microsoft Graph reporting API to submit the message as phishing/spam — the exact mechanism depends on available Graph endpoints (see Open Questions)
- Both tools should follow the existing mock/live dual-path pattern
- `search_user_messages` is read-only (available to all roles); `report_message_as_phishing` is destructive (admin-only, requires confirmation gate)
- Add both tools to the CLI color mapping

## Possible Edge Cases

- Message not found — the search returns no results for the given criteria; the agent should report this clearly rather than attempting to report a non-existent message
- Multiple matching messages — the search returns several results; the agent should present them and ask the user to confirm which one to report
- Message already reported — the Graph API may return an error if the message was previously reported; handle gracefully
- Recipient UPN does not exist or the service principal lacks access to their mailbox — return a clear error
- Large mailboxes with many matching messages — limit search results (e.g., top 10) and support pagination if needed
- Deleted messages — messages in the user's Deleted Items or that have been purged may not be findable

## Acceptance Criteria

- An analyst can say "find the message from attacker@evil.com with subject 'Invoice' sent to jsmith@goodwin.com and report it as phishing" and Neo handles the full workflow
- `search_user_messages` returns matching messages from the user's mailbox
- `report_message_as_phishing` submits the phishing report via Graph API after confirmation
- Both tools work in mock mode with realistic simulated data
- The confirmation gate fires before the report action (destructive tool)
- Tool color mappings and descriptions are added to the CLI

## Open Questions

- Which Microsoft Graph API endpoint is best for reporting messages as phishing? Options include:
  - `POST /users/{id}/messages/{id}/forward` to a phishing intake mailbox (as suggested in the Notion issue)
  - The Graph `reportJunkMessage` / `reportPhishingMessage` actions if available in the tenant - if this is the better option, lets use this one
  - Submitting to the Microsoft 365 abuse reporting endpoint
- Does the service principal need `Mail.Read` and `Mail.Send` permissions, or are there more specific scopes for message reporting? Yes it does
- Should the search tool support searching by message body content, or just sender/subject/date? message content would be good too
- Should there be an option to also delete the message from the user's inbox after reporting? no lets leave that out for now.

## Testing Guidelines

Create test file(s) in the `./test` folder for the new feature, and create meaningful tests for the following cases:

- Mock search returns realistic message data with expected fields (id, subject, sender, receivedDateTime, preview)
- Search correctly filters by sender, subject, and date range
- Report tool requires confirmation (is in DESTRUCTIVE_TOOLS set)
- Report tool validates that message ID and recipient UPN are provided
- Tool schemas have the expected parameter structure
