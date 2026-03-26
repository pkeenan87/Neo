# Abnormal ATO Case Investigator

## Context

Account takeover is the most complex investigation type, and where Claude's synthesis ability adds the most value — correlating impossible travel, mail rule changes, suspicious sign-ins, and lateral phishing into a coherent narrative. This plan adds three tools: `list_ato_cases` (read-only, paginated with time filter), `get_ato_case` (read-only, combines case details + analysis timeline via `Promise.allSettled`), and `action_ato_case` (destructive, acknowledge or mark as action required). All use the existing `getAbnormalConfig()` / `abnormalApi()` / `ABNORMAL_BASE_URL` pattern. The action tool is the first destructive Abnormal tool — it goes in DESTRUCTIVE_TOOLS.

---

## Key Design Decisions

- **Three tools** — list, get (combined details + timeline), and action. The get tool uses `Promise.allSettled` with `_partial` / `_errors` pattern from `get_employee_profile`.
- **One destructive tool** — `action_ato_case` supports `action_required` and `acknowledge`. Requires admin + confirmation gate. Added to DESTRUCTIVE_TOOLS.
- **Validation before mock** — all three tools validate inputs before the mock branch, consistent with the convention established in this session.
- **Time filter** — `list_ato_cases` uses `lastModifiedTime gte {value}` filter, same encoding pattern as vendor cases and threat list.
- **ISO-8601 validation** — reuses the `validateIsoDatetime` helper added in the threat triage tools.

---

## Files to Change

| File | Change |
|------|--------|
| `web/lib/types.ts` | Add `ListAtoCasesInput`, `GetAtoCaseInput`, `ActionAtoCaseInput` interfaces |
| `web/lib/tools.ts` | Add 3 tool schemas; add `action_ato_case` to DESTRUCTIVE_TOOLS |
| `web/lib/executors.ts` | Add 3 executor functions; register in executors record |
| `web/lib/integration-registry.ts` | Add 3 tool names to Abnormal Security capabilities array |
| `cli/src/index.js` | Add 3 TOOL_COLORS entries (green for read-only, red bold for action) and TOOL_DESCRIPTIONS entry for action |
| `docs/user-guide.md` | Add 3 tools to tool reference table |
| `README.md` | Add 3 tools to tools table |
| `test/abnormal-ato-cases.test.js` | New test file |

---

## Implementation Steps

### 1. Add input types in `web/lib/types.ts`

- `ListAtoCasesInput`: `filter_value` (optional ISO-8601 string for `lastModifiedTime`), `page_size` (optional number, default 25), `page_number` (optional number, default 1)
- `GetAtoCaseInput`: `case_id` (required string)
- `ActionAtoCaseInput`: `case_id` (required string), `action` (required: `"action_required" | "acknowledge"`), `justification` (required string)

### 2. Add tool schemas in `web/lib/tools.ts`

- Add `list_ato_cases` after the threat triage tools:
  - Description: "List Account Takeover cases from Abnormal Security. Filterable by last modified time."
  - Properties: `filter_value`, `page_size`, `page_number` — all optional
- Add `get_ato_case`:
  - Description: "Get full details of an Account Takeover case including analysis timeline with impossible travel, mail rule changes, suspicious sign-ins, and AI summary."
  - Properties: `case_id` (required)
- Add `action_ato_case`:
  - Description: "⚠️ DESTRUCTIVE — Take action on an Abnormal Security Account Takeover case (acknowledge or mark as action required)."
  - Properties: `case_id` (required), `action` (required, enum), `justification` (required)
- Add `action_ato_case` to DESTRUCTIVE_TOOLS

### 3. Add executor functions in `web/lib/executors.ts`

- Import the 3 new input types

**`list_ato_cases`**:
- Validate filter_value with `validateIsoDatetime` if provided
- Mock returns 3 realistic ATO cases with severity, affected employee, status
- Live: construct filter `lastModifiedTime gte {value}` if provided, add pagination, call `GET /v1/cases` via `abnormalApi`

**`get_ato_case`**:
- Validate case_id non-empty
- Mock returns full case with details + analysis timeline (insights with impossible travel and risky location signals, risk events, mail rule changes with DELETE_ALL conditions, suspicious sign-ins, lateral phishing, GenAI summary, linked threat IDs)
- Live: `Promise.allSettled` on `GET /v1/cases/{caseId}` and `GET /v1/cases/{caseId}/analysis-and-timeline`, merge results, log and surface rejections as `_errors`

**`action_ato_case`**:
- Validate case_id non-empty, validate action is one of the two allowed values
- Mock returns success with action_id and status_url
- Live: `POST /v1/cases/{caseId}` with `{ action }` body via `abnormalApi`, log the action
- Register in executors record

### 4. Update integration registry

- Add `list_ato_cases`, `get_ato_case`, `action_ato_case` to Abnormal Security capabilities

### 5. CLI config

- TOOL_COLORS: `list_ato_cases: chalk.green`, `get_ato_case: chalk.green`, `action_ato_case: chalk.red.bold`
- TOOL_DESCRIPTIONS: `action_ato_case: "Mark ATO case {case_id} as {action}"`

### 6. Update docs

- `docs/user-guide.md`: Add 3 tools (list/get as All, action as Admin)
- `README.md`: Add 3 tools (list/get Read-only, action Destructive)

### 7. Write tests in `test/abnormal-ato-cases.test.js`

- Time filter validation rejects invalid ISO-8601
- `list_ato_cases` and `get_ato_case` NOT in DESTRUCTIVE_TOOLS
- `action_ato_case` IS in DESTRUCTIVE_TOOLS
- Tool schemas: list has no required, get requires case_id, action requires case_id + action + justification
- Action validation: only `action_required` and `acknowledge` accepted
- Mock case data has expected fields (severity, affectedEmployee, genai_summary, timeline insights)

---

## Verification

1. Run `node --experimental-strip-types --test test/abnormal-ato-cases.test.js` — all tests pass
2. Run `cd web && npx next build` — build succeeds
3. Start dev server with `MOCK_MODE=true`, ask "walk me through ATO case 12345" — verify mock case with timeline returned
4. Verify `action_ato_case` triggers confirmation gate
