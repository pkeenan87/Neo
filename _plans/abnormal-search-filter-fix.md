# Abnormal Search Filter Fix

## Context

The `search_abnormal_messages` tool fails with HTTP 400: `{"error": "Validation failed", "details": ["filters: Field required"]}`. The Abnormal Security Search API (POST /v1/search) requires filter criteria to be nested inside a `filters` object in the request body, but our implementation puts them at the top level alongside `source`. The fix restructures the request body to match the documented API schema: `{ source, filters: { start_time, end_time, sender_email, ... } }`.

---

## Key Design Decisions

- **Nest filter fields inside a `filters` object** — The API requires `source` and `filters` as top-level fields. All search criteria (`start_time`, `end_time`, `sender_email`, `subject`, etc.) must be inside `filters`. `page_size` and `page_number` stay at the top level as pagination params.
- **No schema changes needed** — The `SearchAbnormalMessagesInput` interface in `types.ts` is fine as-is; the restructuring is purely in the executor function where the request body is built.
- **Check `remediate_abnormal_messages` too** — The remediate endpoint's `search_filters` field may need similar restructuring if it also expects a nested `filters` format. Per the Swagger docs, `/v1/search/remediate` uses `search_filters` which is already passed as a nested object — this is likely correct as-is.

---

## Files to Change

| File | Change |
|------|--------|
| `web/lib/executors.ts` | Restructure the request body in `search_abnormal_messages` to nest filter fields inside a `filters` object |

---

## Implementation Steps

### 1. Restructure request body in `search_abnormal_messages`

- In `web/lib/executors.ts`, function `search_abnormal_messages` (line ~2102), change the `body` object construction:
  - Keep `source`, `page_size`, and `page_number` at the top level
  - Move all filter fields (`start_time`, `end_time`, `sender_email`, `sender_name`, `recipient_email`, `subject`, `attachment_name`, `attachment_md5_hash`, `body_link`, `sender_ip`, `judgement`) into a nested `filters` object
  - The new structure should be: `{ source, page_size, page_number, filters: { start_time, end_time, sender_email?, ... } }`
  - Only include non-undefined filter fields inside the `filters` object (same spread pattern as current code)

---

## Verification

1. Build: `cd /Users/pkeenan/Documents/Neo/web && export PATH="/Users/pkeenan/.nvm/versions/node/v24.14.0/bin:$PATH" && npm run build 2>&1 | tail -10`
2. Run existing tests to verify no regressions
3. Manual: In the web UI, use the agent to search for abnormal messages (e.g., "search for phishing emails from last week") and verify the tool call succeeds instead of returning a 400 error
