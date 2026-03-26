# Abnormal Employee Risk Profile

## Context

SOC analysts need employee behavioral baselines during ATO and phishing investigations — normal login IPs, locations, devices, browsers — to determine whether observed activity is anomalous. This plan adds two read-only tools: `get_employee_profile` (combines employee info + Genome identity analysis in parallel) and `get_employee_login_history` (30-day login CSV parsed to JSON). Both use the existing `getAbnormalConfig()` / `abnormalApi()` pattern and the `ABNORMAL_API_TOKEN` bearer token. Email validation reuses `validateSenderEmail` from `abnormal-helpers.ts`.

---

## Key Design Decisions

- **Two tools, not three** — per the Notion note, employee info and identity analysis are combined into `get_employee_profile` via `Promise.all` for a single-tool experience. Login history stays separate because it returns a different format (CSV).
- **CSV parsing** — the login CSV from `/v1/employee/{email}/login-csv` is plain text. Parse it into a JSON array of objects (split lines, use first line as headers) before returning.
- **Email validation** — reuse `validateSenderEmail` from `abnormal-helpers.ts` (already imported in executors.ts for the message search tools).
- **Mock-first pattern** — mock check before validation, consistent with the vendor risk tools.

---

## Files to Change

| File | Change |
|------|--------|
| `web/lib/types.ts` | Add `GetEmployeeProfileInput` and `GetEmployeeLoginHistoryInput` interfaces |
| `web/lib/tools.ts` | Add 2 tool schemas (both read-only, none in DESTRUCTIVE_TOOLS) |
| `web/lib/executors.ts` | Add 2 executor functions with mock/live paths; add CSV parser helper; register in executors record |
| `web/lib/integration-registry.ts` | Add 2 tool names to Abnormal Security capabilities array |
| `cli/src/index.js` | Add 2 TOOL_COLORS entries (green) |
| `docs/user-guide.md` | Add 2 tools to tool reference table (All role) |
| `README.md` | Add 2 tools to tools table (Read-only) |
| `test/abnormal-employee-risk.test.js` | New test file |

---

## Implementation Steps

### 1. Add input types in `web/lib/types.ts`

- `GetEmployeeProfileInput`: `email` (required string)
- `GetEmployeeLoginHistoryInput`: `email` (required string)

### 2. Add tool schemas in `web/lib/tools.ts`

- Add `get_employee_profile` after the vendor risk tools:
  - Description: "Get an employee's organizational context and behavioral baseline from Abnormal Security. Returns name, title, manager, and Genome data (common IPs, sign-in locations, devices, browsers)."
  - Properties: `email` (required)
- Add `get_employee_login_history`:
  - Description: "Get an employee's 30-day login history from Abnormal Security. Returns structured login events with IP addresses, locations, timestamps, and devices."
  - Properties: `email` (required)
- Neither added to DESTRUCTIVE_TOOLS

### 3. Add executor functions in `web/lib/executors.ts`

- Import the 2 new input types
- Add a `parseCsvToJson(csv: string)` helper that splits on newlines, uses the first line as headers, and maps remaining lines to objects

**`get_employee_profile`**:
- Mock-first, then validate email with `validateSenderEmail`
- Mock returns realistic employee data: name, title, manager, email, plus Genome histograms (ip_address, sign_in_location, device, browser — each with values array of text/ratio/raw_count)
- Live path: call both `GET /v1/employee/{email}` and `GET /v1/employee/{email}/identity-analysis` via `Promise.all` using `abnormalApi`, merge results into a single response

**`get_employee_login_history`**:
- Mock-first, then validate email
- Mock returns an array of 3 login events with ip, location, timestamp, device, browser
- Live path: call `GET /v1/employee/{email}/login-csv` — since the response is CSV text (not JSON), use `fetch` directly instead of `abnormalApi` (which calls `res.json()`). Parse the CSV text with `parseCsvToJson` and return the structured result.

- Register both in the executors record

### 4. Update integration registry

- Add `get_employee_profile` and `get_employee_login_history` to the Abnormal Security `capabilities` array

### 5. CLI display config

- Add both to TOOL_COLORS with `chalk.green`

### 6. Update docs

- `docs/user-guide.md`: Add 2 tools to tool reference table (All role)
- `README.md`: Add 2 tools to tools table (Read-only)

### 7. Write tests in `test/abnormal-employee-risk.test.js`

- Email validation: accepts valid emails, rejects invalid formats (reuse `validateSenderEmail` logic)
- Both tools are NOT in DESTRUCTIVE_TOOLS
- Tool schemas: both require `email`
- Mock profile data has expected fields (name, title, manager, histograms)
- CSV parser: splits headers + data correctly, handles empty input

---

## Verification

1. Run `node --experimental-strip-types --test test/abnormal-employee-risk.test.js` — all tests pass
2. Run `cd web && npx next build` — build succeeds
3. Start dev server with `MOCK_MODE=true`, ask "what's the normal login pattern for jsmith@goodwin.com?" — verify Genome data returned
4. Verify both tools appear in the Abnormal Security integration capabilities
