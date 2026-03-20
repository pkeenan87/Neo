# Report Message as Spam

## Context

Analysts currently instruct users to report phishing messages themselves. This plan adds two new tools: `search_user_messages` (read-only, searches a user's Exchange mailbox via Microsoft Graph) and `report_message_as_phishing` (destructive, reports the message as phishing using Graph's `message.reportPhishing` action). The service principal needs `Mail.Read` and `Mail.Send` application permissions. No email-related tools exist yet — this is entirely new Graph mail functionality.

---

## Key Design Decisions

- **Dedicated Graph search tool over Sentinel** — Graph gives direct access to message IDs needed for the report action. Sentinel email tables (`EmailEvents`) may not be configured and don't return Graph message IDs. The Graph `/users/{upn}/messages` endpoint with `$search` and `$filter` is purpose-built for this.
- **Use Graph `reportPhishing` action** — per user preference, use `POST /users/{upn}/messages/{messageId}/reportPhishing` (available in beta; falls back to `reportJunkMessage` if phishing action is unavailable). This is the native Graph reporting mechanism rather than forwarding to an intake mailbox.
- **Search supports body content** — use `$search` parameter which searches across subject, body, sender, and other fields. OData `$filter` is used for date range.
- **No message deletion** — per user preference, leave the message in the user's mailbox after reporting.
- **`search_user_messages` is read-only** — available to all roles. `report_message_as_phishing` is destructive — requires admin role and confirmation gate.

---

## Files to Change

| File | Change |
|------|--------|
| `web/lib/types.ts` | Add `SearchUserMessagesInput` and `ReportMessageAsPhishingInput` interfaces |
| `web/lib/tools.ts` | Add `search_user_messages` and `report_message_as_phishing` schemas to TOOLS array; add `report_message_as_phishing` to DESTRUCTIVE_TOOLS |
| `web/lib/executors.ts` | Add `search_user_messages` and `report_message_as_phishing` executor functions with mock/live paths; register in executors record |
| `cli/src/index.js` | Add TOOL_COLORS entries and TOOL_DESCRIPTIONS entry for the report tool |
| `.env.example` | Add note about `Mail.Read` and `Mail.Send` permissions needed ** update docs/ too |
| `test/report-message-as-spam.test.js` | New test file for mock data structure, tool schema validation |

---

## Implementation Steps

### 1. Add input types in `web/lib/types.ts`

- Add `SearchUserMessagesInput` interface near the existing input types:
  - `upn` (required string) — the recipient/mailbox owner's UPN
  - `sender` (optional string) — sender email address or display name to filter by
  - `subject` (optional string) — subject text to search for
  - `search_text` (optional string) — free-text search across subject, body, sender
  - `days` (optional number) — how many days back to search (default 7)
- Add `ReportMessageAsPhishingInput` interface:
  - `upn` (required string) — the mailbox owner's UPN
  - `message_id` (required string) — the Graph message ID to report
  - `report_type` (optional string, `"phishing"` or `"junk"`, default `"phishing"`)
  - `justification` (required string) — reason for reporting, written to audit log

### 2. Add tool schemas in `web/lib/tools.ts`

- Add `search_user_messages` schema after `get_machine_isolation_status` (grouping read-only tools):
  - Name: `search_user_messages`
  - Description: "Search a user's Exchange Online mailbox for specific messages by sender, subject, body content, or date range. Returns message IDs needed for reporting actions."
  - Input schema with properties for `upn` (required), `sender`, `subject`, `search_text`, `days`
- Add `report_message_as_phishing` schema after `unisolate_machine` (grouping with other destructive tools):
  - Name: `report_message_as_phishing`
  - Description: "⚠️ DESTRUCTIVE — Report a message in a user's mailbox as phishing or junk via Microsoft Graph. Use after searching for the message with search_user_messages."
  - Input schema with properties for `upn` (required), `message_id` (required), `report_type`, `justification` (required)
- Add `"report_message_as_phishing"` to the `DESTRUCTIVE_TOOLS` Set

### 3. Add executor functions in `web/lib/executors.ts`

- Import the new input types at the top
- Add `search_user_messages` function:
  - Validate UPN using existing `validateUpn`
  - **Mock path**: Return a realistic array of 3 mock email messages with fields: `id`, `subject`, `sender` (object with `emailAddress`), `receivedDateTime`, `bodyPreview`, `hasAttachments`, `isRead`
  - **Live path**:
    1. Get Graph token via `getMSGraphToken()`
    2. Build the Graph URL: `https://graph.microsoft.com/v1.0/users/${encodedUpn}/messages`
    3. If `search_text` is provided, add `$search="<text>"` query param (requires `ConsistencyLevel: eventual` header and `$count=true`)
    4. If `sender` is provided, add `$filter=from/emailAddress/address eq '<sender>'`
    5. If `subject` is provided, add to `$filter`: `contains(subject, '<subject>')`
    6. Add date filter using `days` parameter: `receivedDateTime ge <iso-date>`
    7. Add `$select=id,subject,from,receivedDateTime,bodyPreview,hasAttachments,isRead`
    8. Add `$top=10` and `$orderby=receivedDateTime desc`
    9. Return the `value` array from the response
- Add `report_message_as_phishing` function:
  - Validate UPN using existing `validateUpn`
  - Validate `message_id` is a non-empty string
  - **Mock path**: Return a success object with `reported: true`, `messageId`, `reportType`, `upn`, `_mock: true`
  - **Live path**:
    1. Get Graph token via `getMSGraphToken()`
    2. Based on `report_type`:
       - If `"phishing"`: `POST https://graph.microsoft.com/beta/users/${encodedUpn}/messages/${encodeURIComponent(messageId)}/reportPhishing`
       - If `"junk"`: `POST https://graph.microsoft.com/v1.0/users/${encodedUpn}/messages/${encodeURIComponent(messageId)}/reportJunkMessage` with body `{ "moveToJunk": true }`
    3. If the response is not OK, throw with status and error text
    4. Return a success result with the message ID, report type, and UPN
- Register both functions in the `executors` record at the bottom of the file

### 4. Add CLI display config in `cli/src/index.js`

- Add `search_user_messages: chalk.blue` to TOOL_COLORS (blue, matching other Graph/identity tools like `get_user_info`)
- Add `report_message_as_phishing: chalk.red.bold` to TOOL_COLORS (red bold, matching other destructive tools)
- Add `report_message_as_phishing` entry to `TOOL_DESCRIPTIONS`: describe as "Report message as {report_type} in {upn}'s mailbox"

### 5. Update `.env.example`

- Add a comment in the Azure credentials section noting that `Mail.Read` and `Mail.Send` application permissions are required on the app registration for the message search and report tools

### 6. Write tests in `test/report-message-as-spam.test.js`

- Use `node:test` runner matching existing test patterns
- Test cases:
  - Mock search response has expected fields (id, subject, from, receivedDateTime, bodyPreview, hasAttachments)
  - Report type defaults to "phishing" when not specified
  - Report type validation accepts only "phishing" or "junk"
  - Message ID validation rejects empty strings
  - UPN validation regex rejects invalid formats
  - Tool schema for search has `upn` as required, others optional
  - Tool schema for report has `upn`, `message_id`, `justification` as required
  - `report_message_as_phishing` is in the destructive tools set
  - `search_user_messages` is NOT in the destructive tools set

---

## Verification

1. Run `node --experimental-strip-types --test test/report-message-as-spam.test.js` — all tests pass
2. Run `cd web && npx next build` — build succeeds
3. Start dev server with `MOCK_MODE=true`, ask "find emails from attacker@evil.com sent to jsmith@goodwin.com in the past 3 days" — verify `search_user_messages` is called and returns mock results
4. Ask "report that message as phishing" — verify the confirmation gate fires for `report_message_as_phishing`
5. Confirm the tool appears in admin tool list and reader can use search but not report

---

## API Permission Note

The Azure AD app registration needs these additional Microsoft Graph application permissions:
- `Mail.Read` — to search user mailboxes via `/users/{upn}/messages`
- `Mail.Send` — required by the `reportPhishing` / `reportJunkMessage` actions (the action sends a copy to Microsoft for analysis)

The `reportPhishing` action is currently in the Graph beta endpoint. If the endpoint is not available or returns 404, the fallback is `reportJunkMessage` on the v1.0 endpoint.
