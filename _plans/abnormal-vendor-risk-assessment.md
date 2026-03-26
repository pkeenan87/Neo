# Abnormal Vendor Risk Assessment

## Context

SOC analysts need to assess vendor email compromise (VEC) risk during investigations — checking vendor risk levels, reviewing suspicious activity timelines, and investigating vendor cases with look-alike domain detection. This plan adds five read-only tools that query the Abnormal Security vendor intelligence APIs. Auth reuses the existing `getAbnormalConfig()` / `abnormalApi()` pattern with the `ABNORMAL_API_TOKEN` bearer token. All tools are read-only (no confirmation gate). The Abnormal Security integration already exists in the registry — we just need to add the new tool names to its `capabilities` array.

---

## Key Design Decisions

- **Five read-only tools** — `get_vendor_risk`, `list_vendors`, `get_vendor_activity`, `list_vendor_cases`, `get_vendor_case`. None are destructive.
- **Existing Abnormal auth** — reuses `getAbnormalConfig()` and `abnormalApi()` already in `executors.ts`. Same bearer token, same base URL (`https://api.abnormalsecurity.com`).
- **Domain validation** — uses the same domain regex pattern from the Defender indicator tools (allows `*.` prefix for wildcard domains, validates label format).
- **Pagination** — `list_vendors` and `get_vendor_activity` accept `page_size` (default 25, capped at 100) and `page_number` (default 1). `list_vendor_cases` uses the API's time-based filtering.

---

## Files to Change

| File | Change |
|------|--------|
| `web/lib/types.ts` | Add 5 input interfaces: `GetVendorRiskInput`, `ListVendorsInput`, `GetVendorActivityInput`, `ListVendorCasesInput`, `GetVendorCaseInput` |
| `web/lib/tools.ts` | Add 5 tool schemas (all read-only, none in DESTRUCTIVE_TOOLS) |
| `web/lib/executors.ts` | Add 5 executor functions using `getAbnormalConfig()` + `abnormalApi()`; register in executors record |
| `web/lib/integration-registry.ts` | Add the 5 new tool names to the Abnormal Security integration's `capabilities` array |
| `cli/src/index.js` | Add 5 TOOL_COLORS entries (green for Abnormal read-only tools) |
| `docs/user-guide.md` | Add 5 tools to tool reference table (All role) |
| `README.md` | Add 5 tools to tools table (Read-only) |
| `test/abnormal-vendor-risk.test.js` | New test file |

---

## Implementation Steps

### 1. Add input types in `web/lib/types.ts`

- `GetVendorRiskInput`: `vendor_domain` (required string)
- `ListVendorsInput`: `page_size` (optional number, default 25), `page_number` (optional number, default 1)
- `GetVendorActivityInput`: `vendor_domain` (required string), `page_size` (optional number, default 25), `page_number` (optional number, default 1)
- `ListVendorCasesInput`: `filter` (optional string: `"firstObservedTime"` or `"lastModifiedTime"`), `filter_value` (optional ISO-8601 string)
- `GetVendorCaseInput`: `case_id` (required string)

### 2. Add tool schemas in `web/lib/tools.ts`

- Add all 5 after the existing Abnormal tools (`get_abnormal_remediation_status`)
- `get_vendor_risk`: description mentions vendor email compromise risk assessment, required param `vendor_domain`
- `list_vendors`: description mentions paginated vendor list with risk levels, optional `page_size` and `page_number`
- `get_vendor_activity`: description mentions vendor event timeline with suspicious domains and attack goals, required `vendor_domain`, optional pagination
- `list_vendor_cases`: description mentions vendor cases with look-alike domain and young domain insights, optional time filter
- `get_vendor_case`: description mentions full case details with insights and message timeline, required `case_id`
- None added to DESTRUCTIVE_TOOLS

### 3. Add executor functions in `web/lib/executors.ts`

- Import the 5 new input types
- Add a `validateVendorDomain(domain)` function that validates with the same domain regex pattern, allowing wildcards

**`get_vendor_risk`**: validate domain, mock returns realistic vendor data (riskLevel, vendorContacts, companyContacts, countries, IPs, analysis), live calls `GET /v1/vendors/{vendorDomain}` via `abnormalApi`

**`list_vendors`**: mock returns 3 vendors, live calls `GET /v1/vendors?pageSize={}&pageNumber={}` via `abnormalApi`, cap page_size at 100

**`get_vendor_activity`**: validate domain, mock returns event timeline, live calls `GET /v1/vendors/{vendorDomain}/activity?pageSize={}&pageNumber={}` via `abnormalApi`

**`list_vendor_cases`**: mock returns 2 cases, live calls `GET /v1/vendor-cases` with optional `filter` and `filterValue` query params via `abnormalApi`

**`get_vendor_case`**: validate case_id is non-empty string, mock returns full case with insights and timeline, live calls `GET /v1/vendor-cases/{caseId}` via `abnormalApi`

- Register all 5 in the executors record

### 4. Update integration registry in `web/lib/integration-registry.ts`

- Add the 5 new tool names to the Abnormal Security entry's `capabilities` array

### 5. Add CLI display config in `cli/src/index.js`

- Add all 5 to TOOL_COLORS with `chalk.green` (matching other Abnormal read-only tools)

### 6. Update docs

- `docs/user-guide.md`: Add 5 tools to tool reference table (All role)
- `README.md`: Add 5 tools to tools table (Read-only)

### 7. Write tests in `test/abnormal-vendor-risk.test.js`

- Domain validation: accepts valid domains, rejects invalid formats
- All 5 tools are NOT in DESTRUCTIVE_TOOLS
- Tool schemas: `get_vendor_risk` requires vendor_domain; `list_vendors` has no required params; `get_vendor_case` requires case_id
- Mock vendor risk data has expected fields (riskLevel, vendorContacts, analysis)
- Case ID validation: rejects empty strings

---

## Verification

1. Run `node --experimental-strip-types --test test/abnormal-vendor-risk.test.js` — all tests pass
2. Run `cd web && npx next build` — build succeeds
3. Start dev server with `MOCK_MODE=true`, ask "what's the risk level for vendor domain example.com?" — verify mock data returned
4. Verify all 5 tools appear in the Abnormal Security integration's capabilities on the integrations page
