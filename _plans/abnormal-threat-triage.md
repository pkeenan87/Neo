# Abnormal Threat Triage

## Context

Every SOC triage session starts with reviewing recent email threats. This plan adds two read-only tools: `list_abnormal_threats` (paginated threat list with time-based filtering via `GET /v1/threats`) and `get_abnormal_threat` (full threat details via `GET /v1/threats/{threatId}`). Both use the existing `getAbnormalConfig()` / `abnormalApi()` / `ABNORMAL_BASE_URL` pattern. Time filter defaults to last 24 hours when not specified. The `defaultTimeRange()` helper from `abnormal-helpers.ts` already provides a 48-hour default — we'll use a similar pattern but default to 24 hours per the spec.

---

## Key Design Decisions

- **Two tools** — `list_abnormal_threats` (list with time filter) and `get_abnormal_threat` (details by ID). Single-page results, not auto-paginating.
- **Time filter format** — Abnormal uses `receivedTime gte {start} lte {end}` in the filter query param. Encoded as a single expression like the vendor cases filter.
- **Validation before mock** — consistent with the review fix applied to vendor risk tools.
- **Threat ID validation** — non-empty string, similar to vendor case ID.
- **24-hour default** — when no time range provided, query the last 24 hours (not 48 like the search tool's `defaultTimeRange`).

---

## Files to Change

| File | Change |
|------|--------|
| `web/lib/types.ts` | Add `ListAbnormalThreatsInput` and `GetAbnormalThreatInput` interfaces |
| `web/lib/tools.ts` | Add 2 tool schemas (both read-only, none in DESTRUCTIVE_TOOLS) |
| `web/lib/executors.ts` | Add 2 executor functions; register in executors record |
| `web/lib/integration-registry.ts` | Add 2 tool names to Abnormal Security capabilities array |
| `cli/src/index.js` | Add 2 TOOL_COLORS entries (green) |
| `docs/user-guide.md` | Add 2 tools to tool reference table (All role) |
| `README.md` | Add 2 tools to tools table (Read-only) |
| `test/abnormal-threat-triage.test.js` | New test file |

---

## Implementation Steps

### 1. Add input types in `web/lib/types.ts`

- `ListAbnormalThreatsInput`: `start_time` (optional string), `end_time` (optional string), `page_size` (optional number, default 25), `page_number` (optional number, default 1)
- `GetAbnormalThreatInput`: `threat_id` (required string)

### 2. Add tool schemas in `web/lib/tools.ts`

- Add `list_abnormal_threats` after the employee tools:
  - Description: "List recent email threats from Abnormal Security. Defaults to the last 24 hours. Shows threat IDs, attack types, and summaries."
  - Properties: `start_time`, `end_time`, `page_size`, `page_number` — all optional
- Add `get_abnormal_threat`:
  - Description: "Get full details of a specific email threat from Abnormal Security including attack type, strategy, sender analysis, attachments, URLs, remediation status, and portal link."
  - Properties: `threat_id` (required)
- Neither added to DESTRUCTIVE_TOOLS

### 3. Add executor functions in `web/lib/executors.ts`

- Import the 2 new input types

**`list_abnormal_threats`**:
- Validate time inputs: if start_time or end_time provided, parse with `new Date()` and check `isNaN`
- If neither provided, default to last 24 hours (now - 24h for start, now for end)
- Mock returns 3 realistic threats with IDs, attack types, and timestamps
- Live: construct filter `receivedTime gte {start} lte {end}`, encode as single expression, add pageSize/pageNumber params, call `GET /v1/threats?filter={}&pageSize={}&pageNumber={}` via `abnormalApi`

**`get_abnormal_threat`**:
- Validate threat_id is non-empty string
- Mock returns full threat details: attackType, attackStrategy, attackVector, summaryInsights, fromAddress, senderIpAddress, senderDomain, recipientAddress, toAddresses, attachmentNames, urls, urlCount, autoRemediated, postRemediated, remediationStatus, impersonatedParty, attackedParty, abxPortalUrl
- Live: call `GET /v1/threats/{threatId}` via `abnormalApi`

- Register both in the executors record

### 4. Update integration registry

- Add `list_abnormal_threats` and `get_abnormal_threat` to Abnormal Security capabilities array

### 5. CLI colors

- Add both to TOOL_COLORS with `chalk.green`

### 6. Update docs

- `docs/user-guide.md`: Add 2 tools (All role)
- `README.md`: Add 2 tools (Read-only)

### 7. Write tests in `test/abnormal-threat-triage.test.js`

- Default time range: when no params, start is ~24h ago and end is ~now
- Time validation: rejects invalid ISO-8601 strings
- Both tools NOT in DESTRUCTIVE_TOOLS
- `list_abnormal_threats` has no required params; `get_abnormal_threat` requires threat_id
- Mock threat data has expected fields (attackType, summaryInsights, fromAddress, remediationStatus)
- Threat ID validation rejects empty strings

---

## Verification

1. Run `node --experimental-strip-types --test test/abnormal-threat-triage.test.js` — all tests pass
2. Run `cd web && npx next build` — build succeeds
3. Start dev server with `MOCK_MODE=true`, ask "show me threats from the last 24 hours" — verify mock data returned
