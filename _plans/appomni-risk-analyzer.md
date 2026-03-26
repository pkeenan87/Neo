# AppOmni App Registration & Integration Risk Analyzer

## Context

This plan implements a net-new AppOmni integration for Neo, adding 12 tools (11 read-only + 1 destructive) that expose SaaS security posture data — monitored services, posture findings, policy issues, insights, unified identities, discovered apps, and audit logs. The implementation follows the established mock/live dual-path executor pattern with `getAppOmniConfig()` and `appOmniApi()` shared helpers, matching the Abnormal Security and ThreatLocker integration patterns already in the codebase. Per the user's answers in the spec, `dismiss_insight` and `start_policy_scan` are excluded.

---

## Key Design Decisions

- **Auth pattern**: `getAppOmniConfig()` resolves `APPOMNI_ACCESS_TOKEN` and `APPOMNI_SUBDOMAIN` via `getToolSecret()` (Key Vault → env var fallback), constructs base URL, validates subdomain format — matching `getThreatLockerConfig()` pattern
- **API wrapper**: `appOmniApi()` thin fetch wrapper handles Bearer auth, base URL construction, pagination params, error codes (401/403/429) — matching `abnormalApi()` pattern but with `PATCH` support added for destructive actions
- **Subdomain validation**: Regex allows only lowercase alphanumeric + hyphens (like `TL_INSTANCE_RE`), prevents SSRF via full URL injection
- **ID validation**: Two distinct validators — `validatePositiveInt()` for service/identity IDs (integers) and existing `validateGuid()` repurposed for UUID finding/occurrence IDs. AppOmni uses integer IDs for services/identities but UUIDs for findings/occurrences
- **Pagination clamping**: Findings endpoints cap at 100 (API hard limit), other endpoints cap at 50 for consistency with codebase convention
- **Single destructive tool with action dispatch**: `action_appomni_finding` handles both `update_status` and `close_exception` actions, routed by an `action` enum field — matching the `action_ato_case` pattern
- **`get_appomni_identity` makes two API calls**: One for identity details, one for linked service users, merged into a single response — matching the `Promise.allSettled` pattern used in `get_employee_profile`

---

## Files to Change

| File | Change |
|------|--------|
| `web/lib/types.ts` | Add 12 input interfaces + helper types for AppOmni tools |
| `web/lib/tools.ts` | Add 12 tool schema entries to `TOOLS` array + 1 entry to `DESTRUCTIVE_TOOLS` |
| `web/lib/executors.ts` | Add `getAppOmniConfig()`, `appOmniApi()`, 12 executor functions (each with mock + live paths), 12 mock data functions, register all 12 in the executors router |
| `web/lib/integration-registry.ts` | Add `appomni` integration entry with 12 capabilities and 2 secrets |
| `cli/src/index.js` | Add 12 entries to `TOOL_COLORS` and 1 entry to `TOOL_DESCRIPTIONS` |
| `README.md` | Add 12 rows to the "Available Tools" table |
| `docs/user-guide.md` | Add 12 rows to the tool reference table |
| `web/public/appomni-logo.png` | Add AppOmni logo asset (placeholder — user to provide) |
| `test/appomni-risk-analyzer.test.js` | New test file with input validation, destructive classification, pagination, and ID format tests |

---

## Implementation Steps

### 1. Add input types to `web/lib/types.ts`

- Add these interfaces before the `GetFullToolResultInput` interface (at the end of the executor input types section, around line 482):
  - `ListAppOmniServicesInput` — optional fields: `service_type` (string), `search` (string), `score_gte` (number), `score_lte` (number), `limit` (number), `offset` (number)
  - `GetAppOmniServiceInput` — required: `service_id` (number), `service_type` (string)
  - `ListAppOmniFindingsInput` — optional fields: `status` (string, "open" | "closed"), `risk_score_gte` (number), `risk_score_lte` (number), `monitored_service_ids` (number array), `category` (string), `compliance_framework` (string), `source_type` (string, "scanner" | "insight"), `first_opened_gte` (string), `first_opened_lte` (string), `limit` (number), `offset` (number)
  - `GetAppOmniFindingInput` — required: `finding_id` (string, UUID)
  - `ListAppOmniFindingOccurrencesInput` — optional: `finding_id` (string), `status` (string), `detailed_status` (string), `monitored_service_ids` (number array), `limit` (number), `offset` (number)
  - `ListAppOmniInsightsInput` — optional: `status` (string array), `monitored_service_ids` (number array), `first_seen_gte` (string), `last_seen_gte` (string), `limit` (number), `offset` (number)
  - `ListAppOmniPolicyIssuesInput` — optional: `policy_ids` (number array), `service_org_ids` (number array), `service_type` (string), `limit` (number), `offset` (number)
  - `ListAppOmniIdentitiesInput` — optional: `identity_status` (string array), `permission_level` (string array), `service_types` (string array), `search` (string), `last_login_gte` (string), `last_login_lte` (string), `limit` (number), `offset` (number)
  - `GetAppOmniIdentityInput` — required: `identity_id` (number)
  - `ListAppOmniDiscoveredAppsInput` — optional: `status` (string), `criticality` (string), `owner` (string), `search` (string), `limit` (number), `offset` (number)
  - `GetAppOmniAuditLogsInput` — optional: `since` (string), `before` (string), `action_type` (string), `monitored_service_id` (number), `user_id` (number), `policy_id` (number), `limit` (number), `offset` (number)
  - `ActionAppOmniFindingInput` — required: `action` (string, "update_status" | "close_exception"), `occurrence_ids` (string array, UUIDs). Conditional required: `detailed_status` (string, required when action is "update_status"), `reason` (string, required when action is "close_exception"). Optional: `expires` (string, ISO datetime), `message` (string)
- Add helper type: `type FindingDetailedStatus = "new" | "in_research" | "in_remediation" | "done"`
- Add helper type: `type ExceptionReason = "risk_accepted" | "false_positive" | "compensating_controls" | "not_applicable" | "confirmed_intended"`

### 2. Add tool schemas to `web/lib/tools.ts`

- Insert 12 tool schema objects into the `TOOLS` array, before the `get_full_tool_result` entry (which should remain last)
- Each schema follows the existing pattern: `name`, `description`, `input_schema` with `type: "object" as const`, `properties`, `required`
- Tool descriptions should be concise and match the style of existing tools. The destructive tool gets the `⚠️ DESTRUCTIVE —` prefix
- Tool-by-tool schema notes:
  - `list_appomni_services`: all optional, no required array
  - `get_appomni_service`: requires `service_id` (number) and `service_type` (string)
  - `list_appomni_findings`: all optional; include `status` enum (open/closed), `source_type` enum (scanner/insight)
  - `get_appomni_finding`: requires `finding_id` (string)
  - `list_appomni_finding_occurrences`: all optional; include `status` enum (open/closed), `detailed_status` enum (new/in_research/in_remediation/done)
  - `list_appomni_insights`: all optional; include `status` as array-capable string description
  - `list_appomni_policy_issues`: all optional
  - `list_appomni_identities`: all optional; include `permission_level` enum description (admin/elevated/standard)
  - `get_appomni_identity`: requires `identity_id` (number)
  - `list_appomni_discovered_apps`: all optional; include `status` enum (approved/pending/rejected), `criticality` enum (high/medium/low)
  - `get_appomni_audit_logs`: all optional; `since`/`before` described as ISO-8601 datetime strings
  - `action_appomni_finding`: requires `action` (enum: update_status/close_exception), `occurrence_ids` (array of UUID strings). Conditional: `detailed_status` (enum) when action=update_status, `reason` (enum) when action=close_exception. Optional: `expires`, `message`
- Add `"action_appomni_finding"` to the `DESTRUCTIVE_TOOLS` Set

### 3. Add shared helpers and executor functions to `web/lib/executors.ts`

- Add all 12 new input type imports to the import block at the top of the file
- Add a new section comment `// ── AppOmni ────────────────────────────────────────────────────` after the last Abnormal Security executor function and before the mock data helper functions

#### 3a. Shared helpers

- Add `AO_SUBDOMAIN_RE` regex: `/^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/` — validates subdomain format, prevents SSRF
- Add `getAppOmniConfig()` async function:
  - Calls `getToolSecret("APPOMNI_ACCESS_TOKEN")` and `getToolSecret("APPOMNI_SUBDOMAIN")`
  - Throws descriptive error if either is missing ("AppOmni integration not configured — go to Settings > Integrations...")
  - Normalizes subdomain: if it contains `.appomni.com`, extract just the subdomain portion; strip `https://` and trailing slashes
  - Validates subdomain against `AO_SUBDOMAIN_RE`
  - Returns `{ accessToken, baseUrl: \`https://${subdomain}.appomni.com\` }`
- Add `appOmniApi()` async function:
  - Parameters: `config: { accessToken: string; baseUrl: string }`, `method: "GET" | "PATCH"`, `path: string`, `params?: Record<string, string | number | string[]>`, `body?: Record<string, unknown>`
  - Constructs URL: `${config.baseUrl}/api/v1${path}` with query params appended via URLSearchParams (skip undefined/null values, handle array params by JSON-encoding them)
  - Sets headers: `Authorization: Bearer ${config.accessToken}`, `Content-Type: application/json`
  - On non-ok response: specific messages for 401 ("Access token expired or invalid — regenerate in AppOmni Settings > API Settings"), 403 ("Insufficient permissions"), 429 ("Rate limited — try again later"), generic for others
  - Returns parsed JSON

#### 3b. Read-only executor functions (11 functions)

Each function follows the pattern: validate inputs → check `env.MOCK_MODE` → return mock or call live API.

- **`list_appomni_services`**: Clamp limit to 1–50 (default 50). Call `GET /core/monitoredservice/` with `annotations=1` always included plus optional filter params
- **`get_appomni_service`**: Validate `service_id` is a positive integer, `service_type` is non-empty. Call `GET /core/monitoredservice/{service_type}/{service_type}org/{service_id}`
- **`list_appomni_findings`**: Clamp limit to 1–100 (default 100, API max). Map input fields to AppOmni query params (e.g., `risk_score_gte` → `risk_score__gte`, `monitored_service_ids` → `monitored_service__in`). Call `GET /findings/finding/`
- **`get_appomni_finding`**: Validate `finding_id` is non-empty string. Call `GET /findings/finding/{finding_id}/`
- **`list_appomni_finding_occurrences`**: Clamp limit to 1–100. Map filter fields to query params. Call `GET /findings/occurrence/`
- **`list_appomni_insights`**: Clamp limit to 1–500. Map filter fields. Call `GET /insights/discoveredinsight/`
- **`list_appomni_policy_issues`**: Clamp limit to 1–50. Map filter fields. Call `GET /core/ruleevent/`
- **`list_appomni_identities`**: Clamp limit to 1–50. Map filter fields. Call `GET /core/unifiedidentity/annotated_list/`
- **`get_appomni_identity`**: Validate `identity_id` is a positive integer. Use `Promise.allSettled` to call both `GET /core/unifiedidentity/{identity_id}/` and `GET /core/unifiedidentity/{identity_id}/users` in parallel. Merge results: identity details + linked users. Include `_partial` and `_errors` fields if one call fails
- **`list_appomni_discovered_apps`**: Clamp limit to 1–50. Map filter fields. Call `GET /discovery/apps/`
- **`get_appomni_audit_logs`**: Clamp limit to 1–50. Map filter fields (`since` → `since`, `before` → `before`, etc.). Call `GET /core/auditlogs/`

#### 3c. Destructive executor function (1 function)

- **`action_appomni_finding`**: Validate `occurrence_ids` is non-empty array of non-empty strings. Branch on `action`:
  - `update_status`: Validate `detailed_status` is one of `["new", "in_research", "in_remediation", "done"]`. Call `PATCH /findings/occurrence/update_detailed_status/` with `{ ids: occurrence_ids, detailed_status }`
  - `close_exception`: Validate `reason` is one of `["risk_accepted", "false_positive", "compensating_controls", "not_applicable", "confirmed_intended"]`. If `expires` is provided, validate ISO datetime format. Call `PATCH /findings/occurrence/close_by_exception/` with `{ ids: occurrence_ids, reason, expires?, message? }`
  - Log the action via `logger.info()`

#### 3d. Mock data functions

- Add 12 mock functions following existing naming convention (`mockListAppOmniServices`, etc.)
- Each returns realistic data matching the AppOmni API response format with `_mock: true` flag
- Mock monitored services should include realistic SaaS types: m365, sfdc, box, gws, slack, zoom
- Mock findings should include realistic risk levels, compliance frameworks, and occurrence counts
- Mock identities should include admin/elevated/standard permission levels, active/inactive statuses
- Mock discovered apps should include realistic SaaS app names with approved/pending/rejected statuses

#### 3e. Executor router registration

- Add all 12 entries to the `executors` record at the bottom of the file, mapping tool names to their executor functions with the `as unknown as` type cast pattern

### 4. Add integration registry entry to `web/lib/integration-registry.ts`

- Add a new `appomni` integration object to the `INTEGRATIONS` array:
  - `slug`: `"appomni"`
  - `name`: `"AppOmni"`
  - `iconName`: `"ShieldCheck"` (or similar Lucide icon)
  - `imageSrc`: `"/appomni-logo.png"`
  - `description`: "SaaS Security Posture Management. Monitor connected SaaS applications for misconfigurations, excessive permissions, data exposure, and identity risks."
  - `capabilities`: array of all 12 tool names
  - `secrets`: two entries — `APPOMNI_ACCESS_TOKEN` (label "Access Token", description about generating in Settings > API Settings) and `APPOMNI_SUBDOMAIN` (label "Subdomain", description about the instance subdomain)

### 5. Add AppOmni logo

- Add a placeholder logo image file at `web/public/appomni-logo.png`
- If no real logo is available, create a simple SVG-based placeholder or note to user to supply one

### 6. Update CLI tool colors and descriptions in `cli/src/index.js`

- Add 12 entries to `TOOL_COLORS`:
  - All read-only AppOmni tools: `chalk.magenta` (new color to distinguish from existing integrations)
  - `action_appomni_finding`: `chalk.red.bold` (matching destructive tool convention)
- Add 1 entry to `TOOL_DESCRIPTIONS`:
  - `action_appomni_finding`: format as `"${action} ${occurrence_ids.length} AppOmni finding occurrence(s)"` with details of the action type

### 7. Update documentation

- **`README.md`**: Add 12 rows to the "Available Tools" table in the same format as existing entries. Read-only tools marked as "Read-only", destructive tool marked as "Destructive". Group them together under the AppOmni integration
- **`docs/user-guide.md`**: Add the same 12 rows to the tool reference table, following the existing format

### 8. Add test file

- Create `test/appomni-risk-analyzer.test.js` using `node:test` and `node:assert/strict` (matching existing test files)
- Test groups:
  - **Subdomain validation**: Valid subdomains accepted (alphanumeric, hyphens); URLs rejected; empty strings rejected
  - **ID validation**: Positive integers valid for service/identity IDs; UUIDs valid for finding/occurrence IDs; negative numbers and non-numeric strings rejected for integer IDs
  - **Pagination clamping**: Findings limit clamped to 1–100; other endpoints clamped to 1–50; default values applied when omitted
  - **Destructive tool classification**: `action_appomni_finding` is in DESTRUCTIVE_TOOLS; all other 11 AppOmni tools are NOT in DESTRUCTIVE_TOOLS
  - **Tool schema expectations**: Each tool's required fields match expected count
  - **Finding action validation**: `update_status` requires valid `detailed_status` enum; `close_exception` requires valid `reason` enum; invalid actions rejected
  - **Config helper**: Missing token throws; missing subdomain throws; both present succeeds

---

## Verification

1. Run the test suite: `cd /Users/pkeenan/Documents/Neo && /Users/pkeenan/.nvm/versions/node/v24.14.0/bin/node --test test/appomni-risk-analyzer.test.js`
2. Build the web project to verify no TypeScript errors: `cd /Users/pkeenan/Documents/Neo/web && export PATH="/Users/pkeenan/.nvm/versions/node/v24.14.0/bin:$PATH" && npm run build 2>&1 | tail -20`
3. Verify all 12 tools appear in the TOOLS array and the executor router by grepping for `list_appomni_services` and `action_appomni_finding` in tools.ts and executors.ts
4. Verify the integration registry includes the `appomni` slug by grepping integration-registry.ts
5. Run the existing ThreatLocker and Abnormal test suites to verify no regressions
