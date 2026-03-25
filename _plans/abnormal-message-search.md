# Abnormal Security Message Search & Remediate Tool

## Context

This is a **net new integration** — Abnormal Security has no existing presence in the codebase. The plan adds three tools: a read-only `search_abnormal_messages` for querying messages, a destructive `remediate_abnormal_messages` for bulk remediation (delete, move to inbox, submit to Detection360), and a read-only `get_abnormal_remediation_status` for tracking remediation progress. The user confirmed: `remediate_all` is supported, EML download is deferred, `reclassify` is excluded from v1, and actions are limited to delete/move_to_inbox/submit_to_d360. The Abnormal API docs were unreachable for max remediation count — the implementation should not impose an artificial cap but should surface the total count prominently before `remediate_all` is confirmed.

---

## Key Design Decisions

- **Three tools, not one**: Search and remediate are separate tools so the destructive action goes through the confirmation gate independently. Status tracking is a third read-only tool.
- **`remediate_all` supported**: The remediate tool accepts either an explicit message list OR a set of search filters with `remediate_all: true`. The agent should always search first and show count before calling remediate.
- **Actions limited to three**: `delete`, `move_to_inbox`, `submit_to_d360` only. `reclassify` deferred.
- **Pure helpers extracted**: MD5 validation and time range default logic go in `web/lib/abnormal-helpers.ts` for testability, following the Lansweeper pattern.
- **Error sanitization**: Following the Lansweeper pattern — log full API errors server-side via `logger.error`, return only status codes to the caller.
- **Key Vault for secrets**: `ABNORMAL_API_TOKEN` fetched via `getToolSecret()`.

---

## Files to Change

| File | Change |
|------|--------|
| `web/lib/types.ts` | Add `SearchAbnormalMessagesInput`, `RemediateAbnormalMessagesInput`, and `GetAbnormalRemediationStatusInput` interfaces |
| `web/lib/tools.ts` | Add three tool schemas to `TOOLS` array; add `remediate_abnormal_messages` to `DESTRUCTIVE_TOOLS` |
| `web/lib/abnormal-helpers.ts` | New file — pure helpers: MD5 validation, default time range computation |
| `web/lib/executors.ts` | Add `getAbnormalConfig()`, `abnormalApi()`, three executor functions, three mock functions, register all three in the `executors` object |
| `web/lib/integration-registry.ts` | Add Abnormal Security integration entry |
| `.env.example` | Add `ABNORMAL_API_TOKEN` placeholder |
| `test/abnormal-message-search.test.js` | New test file for helpers and mock response structure |

---

## Implementation Steps

### 1. Define TypeScript types

In `web/lib/types.ts`, add three interfaces in the executor input types section:

- `SearchAbnormalMessagesInput` — fields: `sender_email` (optional string), `sender_name` (optional string), `recipient_email` (optional string), `subject` (optional string), `attachment_name` (optional string), `attachment_md5_hash` (optional string), `body_link` (optional string), `sender_ip` (optional string), `judgement` (optional union: `"attack" | "borderline" | "spam" | "graymail" | "safe"`), `source` (optional union: `"abnormal" | "quarantine"`, default `"abnormal"`), `start_time` (optional ISO 8601 string), `end_time` (optional ISO 8601 string), `page_number` (optional number), `page_size` (optional number).

- `RemediateAbnormalMessagesInput` — fields: `action` (required union: `"delete" | "move_to_inbox" | "submit_to_d360"`), `remediation_reason` (required union: `"false_negative" | "misdirected" | "unsolicited" | "other"`), `messages` (optional array of objects with `message_id` and `recipient_email`), `remediate_all` (optional boolean), `search_filters` (optional object matching search params, required when `remediate_all` is true), `justification` (required string for audit log).

- `GetAbnormalRemediationStatusInput` — fields: `activity_log_id` (required string).

### 2. Add tool schemas

In `web/lib/tools.ts`:

- Add `search_abnormal_messages` to the `TOOLS` array. Description should explain it searches across all messages in the Abnormal Security platform by sender, recipient, subject, attachment, judgement, etc. Input schema mirrors `SearchAbnormalMessagesInput`. All fields optional. Read-only — do NOT add to `DESTRUCTIVE_TOOLS`.

- Add `remediate_abnormal_messages` to the `TOOLS` array. Description should have the `⚠️ DESTRUCTIVE` prefix and explain it performs bulk remediation (delete, move to inbox, or submit to Detection360). Input schema mirrors `RemediateAbnormalMessagesInput`. Add to `DESTRUCTIVE_TOOLS` set.

- Add `get_abnormal_remediation_status` to the `TOOLS` array. Description should explain it checks the status of a previously submitted remediation. Input schema has `activity_log_id` (required string). Read-only.

### 3. Create helper module

Create `web/lib/abnormal-helpers.ts` with:

- **`validateMd5Hash(hash: string): boolean`** — returns true if the string matches `/^[a-f0-9]{32}$/i`. Exported for tests.

- **`defaultTimeRange(): { start_time: string; end_time: string }`** — returns ISO 8601 strings for the last 48 hours (end = now, start = now minus 48 hours). Exported for tests.

- **`validateRemediateInput(input)`** — validates that either `messages` is a non-empty array, or `remediate_all` is true with `search_filters` present. Throws a descriptive error on invalid input. Exported for tests.

### 4. Implement executors

In `web/lib/executors.ts`:

- **Import** the three new input types from `./types` and the helpers from `./abnormal-helpers`.

- **`getAbnormalConfig()` helper** — fetches `ABNORMAL_API_TOKEN` via `getToolSecret()`. Throws descriptive error if missing. Returns `{ apiToken: string }`.

- **`abnormalApi()` helper** — generic HTTP helper for Abnormal API calls. Accepts method, path, optional body. Sends to `https://api.abnormalsecurity.com{path}` with `Authorization: Bearer <token>` and `Content-Type: application/json`. On non-2xx, log the full response body via `logger.error` and throw a generic error with only the status code (following Lansweeper pattern). Returns the parsed JSON response.

- **`search_abnormal_messages()` executor** — mock branch returns `mockSearchAbnormalMessages()`. Live branch: validate `attachment_md5_hash` if present via `validateMd5Hash()`. Apply `defaultTimeRange()` if neither `start_time` nor `end_time` provided. Default `page_size` to 50. Build the request body with all provided filters and call `POST /v1/search` via `abnormalApi()`. Return the message list, total count, and pagination info.

- **`remediate_abnormal_messages()` executor** — mock branch returns `mockRemediateAbnormalMessages()`. Live branch: call `validateRemediateInput()`. Log the remediation action via `logger.info` with tool name, action, reason, and message count (or "remediate_all"). Build the request body and call `POST /v1/search/remediate` via `abnormalApi()`. Return the activity log ID from the response.

- **`get_abnormal_remediation_status()` executor** — mock branch returns `mockGetAbnormalRemediationStatus()`. Live branch: validate `activity_log_id` is non-empty. Call `GET /v1/search/activities/{activity_log_id}` via `abnormalApi()`. Return the status object.

- **Mock functions**:
  - `mockSearchAbnormalMessages()` — return 3 sample messages with realistic fields (sender, recipient, subject, timestamp, judgement, message_id), total count of 3, and pagination info.
  - `mockRemediateAbnormalMessages()` — return a mock activity log ID (UUID format) and a status of "pending".
  - `mockGetAbnormalRemediationStatus()` — return a status object with `activity_log_id`, `status: "completed"`, `message_count`, `completed_at` timestamp.

- **Register** all three in the `executors` object.

### 5. Register the integration

In `web/lib/integration-registry.ts`:

- Add a new entry to the `INTEGRATIONS` array:
  - `slug`: `"abnormal-security"`
  - `name`: `"Abnormal Security"`
  - `iconName`: `"MailWarning"` (represents email security)
  - `imageSrc`: `"/abnormal-logo.png"`
  - `description`: text explaining Abnormal Security provides email threat detection, message search, and bulk remediation.
  - `capabilities`: `["search_abnormal_messages", "remediate_abnormal_messages", "get_abnormal_remediation_status"]`
  - `secrets`: single entry for `ABNORMAL_API_TOKEN` (label: "API Token", description about the Abnormal Security REST API bearer token, required: true).

### 6. Update environment example

In `.env.example`:

- Add after the Lansweeper section: a `# Abnormal Security (optional — only needed when MOCK_MODE=false)` comment and `ABNORMAL_API_TOKEN=` placeholder.

### 7. Write tests

Create `test/abnormal-message-search.test.js` using `node:test` and `node:assert/strict`, importing from `../web/lib/abnormal-helpers.ts`:

- **MD5 validation**: valid 32-char hex accepted, invalid strings rejected (too short, uppercase accepted, non-hex rejected, empty string rejected).
- **Default time range**: `start_time` is approximately 48 hours before `end_time`, both are valid ISO 8601 strings.
- **Remediate input validation**: throws when `messages` is empty and `remediate_all` is false/absent. Throws when `remediate_all` is true but `search_filters` is missing. Passes when `messages` has entries. Passes when `remediate_all` is true with `search_filters`.
- **Mock search response structure**: validate the mock has `messages` array, `total_count` number, and pagination info.
- **Mock remediation response structure**: validate it has `activity_log_id` string.
- **Mock status response structure**: validate it has `status` field with valid value.

### 8. Verify

- Run `node --test test/abnormal-message-search.test.js` and confirm all tests pass.
- Run `cd web && npm run build` to confirm no TypeScript compilation errors (if npm is available).
- Verify brace balance on all modified TypeScript files.

---

## Verification

1. All tests pass: `node --test test/abnormal-message-search.test.js`
2. Web build succeeds: `cd web && npm run build`
3. Mock mode returns realistic data for all three tools
4. `remediate_abnormal_messages` appears in `DESTRUCTIVE_TOOLS` and triggers the confirmation gate
5. Integration appears on the Settings page
6. No TypeScript errors, no `any` types, all inputs validated
