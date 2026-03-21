# ThreatLocker Approval Requests

## Context

Analysts currently switch to the ThreatLocker portal to handle approval requests. This plan adds a net-new ThreatLocker integration (secrets via Key Vault, registration in the integrations registry) and four new tools for listing, inspecting, approving, and denying approval requests via the ThreatLocker Portal API. The API uses an API key + organization ID header pattern, with a base URL of `https://portalapi.INSTANCE.threatlocker.com/portalapi/`. The approve flow uses `ApprovalRequestPermitApplication` (complex body with policy options) and deny uses status-change to Ignored (statusId=10).

---

## Key Design Decisions

- **Three integration secrets**: `THREATLOCKER_API_KEY` (API key), `THREATLOCKER_INSTANCE` (instance name for base URL, e.g. "us" for `portalapi.us.threatlocker.com`), and `THREATLOCKER_ORG_ID` (managed organization GUID). All stored in Key Vault via the integrations UI.
- **Four tools**: `list_threatlocker_approvals` (read-only, lists pending requests), `get_threatlocker_approval` (read-only, full details by ID), `approve_threatlocker_request` (destructive), `deny_threatlocker_request` (destructive). The list and get-detail tools are read-only; approve and deny require admin + confirmation.
- **Simplified approve flow** — the full `ApprovalRequestPermitApplication` endpoint has many options (policy level, ringfencing, elevation). For the initial implementation, approve will apply the policy to the requesting computer only (`toComputer: true`) with no maintenance mode (`ruleId: 0`), matching the simplest common case. The agent can describe additional options and advise the analyst to use the ThreatLocker portal for complex policy configurations.
- **Deny = Ignore** — ThreatLocker doesn't have a "deny" action; the closest is setting status to Ignored (statusId=10). The tool will be named `deny_threatlocker_request` for SOC clarity but will call the ignore/authorize endpoint.
- **Auth pattern**: API key sent as `Authorization` header. The `managedOrganizationId` header passes the org GUID on every request. Secrets are loaded via `getToolSecret()` at call time (same as other integrations).

---

## Files to Change

| File | Change |
|------|--------|
| `web/lib/integration-registry.ts` | Add ThreatLocker integration with 3 secrets |
| `web/lib/types.ts` | Add `ListThreatLockerApprovalsInput`, `GetThreatLockerApprovalInput`, `ApproveThreatLockerRequestInput`, `DenyThreatLockerRequestInput` interfaces |
| `web/lib/tools.ts` | Add 4 tool schemas to TOOLS array; add approve and deny to DESTRUCTIVE_TOOLS |
| `web/lib/executors.ts` | Add 4 executor functions with mock/live paths; add a `getThreatLockerConfig()` helper; register all in executors record |
| `cli/src/index.js` | Add TOOL_COLORS entries (all 4) and TOOL_DESCRIPTIONS entries (approve + deny) |
| `test/threatlocker-approval-requests.test.js` | New test file for mock data, tool schemas, destructive classification |
| `docs/user-guide.md` | Add 4 tools to tool reference table |
| `README.md` | Add 4 tools to tools table |

---

## Implementation Steps

### 1. Register ThreatLocker integration in `web/lib/integration-registry.ts`

- Add a new entry to the `INTEGRATIONS` array after the Microsoft Entra ID entry
- Slug: `threatlocker`
- Name: `ThreatLocker`
- Icon: `Shield` (or `Lock` — use a Lucide icon that fits)
- Description: "Application allowlisting and ringfencing. Review, approve, or deny application approval requests."
- Capabilities: `["list_threatlocker_approvals", "get_threatlocker_approval", "approve_threatlocker_request", "deny_threatlocker_request"]`
- Secrets array with 3 entries:
  - `THREATLOCKER_API_KEY` — required, label "API Key", description "ThreatLocker Portal API key"
  - `THREATLOCKER_INSTANCE` — required, label "Instance", description "Portal API instance name (e.g., 'us' for portalapi.us.threatlocker.com)"
  - `THREATLOCKER_ORG_ID` — required, label "Organization ID", description "Managed organization GUID"

### 2. Add input types in `web/lib/types.ts`

- `ListThreatLockerApprovalsInput`: `status` (optional string: `"pending"`, `"approved"`, `"ignored"`, default `"pending"`), `search_text` (optional string — searches hostname, username, file path), `page` (optional number, default 1), `page_size` (optional number, default 25)
- `GetThreatLockerApprovalInput`: `approval_request_id` (required string — GUID)
- `ApproveThreatLockerRequestInput`: `approval_request_id` (required string), `policy_level` (optional string: `"computer"`, `"group"`, `"organization"`, default `"computer"`), `justification` (required string)
- `DenyThreatLockerRequestInput`: `approval_request_id` (required string), `justification` (required string)

### 3. Add tool schemas in `web/lib/tools.ts`

- Add `list_threatlocker_approvals` schema (read-only) after the email tools:
  - Description: "List ThreatLocker application approval requests. Returns pending requests by default with request details, file hashes, and requesting user/computer."
  - Properties: `status` (enum with pending/approved/ignored), `search_text`, `page`, `page_size`
  - Required: none (all optional)
- Add `get_threatlocker_approval` schema (read-only):
  - Description: "Get full details of a specific ThreatLocker approval request by ID, including application matching information."
  - Properties: `approval_request_id` (required)
- Add `approve_threatlocker_request` schema (destructive):
  - Description: "⚠️ DESTRUCTIVE — Approve a ThreatLocker application approval request. By default applies the policy to the requesting computer only."
  - Properties: `approval_request_id` (required), `policy_level` (enum), `justification` (required)
- Add `deny_threatlocker_request` schema (destructive):
  - Description: "⚠️ DESTRUCTIVE — Deny (ignore) a ThreatLocker application approval request."
  - Properties: `approval_request_id` (required), `justification` (required)
- Add `approve_threatlocker_request` and `deny_threatlocker_request` to `DESTRUCTIVE_TOOLS`

### 4. Add executor functions in `web/lib/executors.ts`

- Import the 4 new input types
- Add a helper function `getThreatLockerConfig()` that loads all 3 secrets via `getToolSecret()` and returns `{ apiKey, baseUrl, orgId }` — constructs `baseUrl` from instance name. Throws a clear error if any secret is missing ("ThreatLocker integration not configured — go to Settings > Integrations").
- Add a GUID validation regex: `/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i`

**`list_threatlocker_approvals`**:
- Mock path: return realistic array of 3 pending approval requests with fields matching the API response (approvalRequestId, computerName, userName, path, hash, sha256, dateTime, statusId)
- Live path: POST to `{baseUrl}/ApprovalRequest/ApprovalRequestGetByParameters` with body containing `statusId` (map "pending"→1, "approved"→4, "ignored"→10), `pageNumber`, `pageSize`, `searchText`, `orderBy: "dateTime"`, `isAscending: false`. Headers: `Authorization: {apiKey}`, `managedOrganizationId: {orgId}`, `Content-Type: application/json`.

**`get_threatlocker_approval`**:
- Validate approval_request_id as GUID format
- Mock path: return detailed approval request with application matching info
- Live path: GET to `{baseUrl}/ApprovalRequest/ApprovalRequestGetPermitApplicationById?approvalRequestId={id}`. Same auth headers.

**`approve_threatlocker_request`**:
- Validate approval_request_id as GUID format
- Mock path: return success object with `_mock: true`
- Live path: First call `get_threatlocker_approval` internally to get the full request details (needed for the permit body). Then POST to `{baseUrl}/ApprovalRequest/ApprovalRequestPermitApplication` with the approval body. Set `policyLevel` based on the `policy_level` input (`toComputer: true` for "computer", `toComputerGroup: true` for "group", `toEntireOrganization: true` for "organization"). Set `ruleId: 0` (no maintenance mode). Include the `approvalRequest` object with the request's JSON and add the justification as comments.

**`deny_threatlocker_request`**:
- Validate approval_request_id as GUID format
- Mock path: return success object with `_mock: true`
- Live path: POST to `{baseUrl}/ApprovalRequest/ApprovalRequestAuthorizeForPermitById` with `approvalRequestId` and `message` set to the justification.

- Register all 4 functions in the `executors` record

### 5. Add CLI display config in `cli/src/index.js`

- Add to TOOL_COLORS:
  - `list_threatlocker_approvals: chalk.green`
  - `get_threatlocker_approval: chalk.green`
  - `approve_threatlocker_request: chalk.red.bold`
  - `deny_threatlocker_request: chalk.red.bold`
- Add to TOOL_DESCRIPTIONS:
  - `approve_threatlocker_request`: "Approve ThreatLocker request {approval_request_id} (policy: {policy_level})"
  - `deny_threatlocker_request`: "Deny ThreatLocker request {approval_request_id}"

### 6. Update docs

- Add all 4 tools to the tool reference table in `docs/user-guide.md` (list and get as All, approve and deny as Admin)
- Add all 4 tools to the tools table in `README.md`

### 7. Write tests in `test/threatlocker-approval-requests.test.js`

- GUID validation: accepts valid GUIDs, rejects invalid formats
- Status mapping: "pending"→1, "approved"→4, "ignored"→10
- Mock list response has expected fields (approvalRequestId, computerName, userName, path, hash, dateTime, statusId)
- Approve and deny are in DESTRUCTIVE_TOOLS
- List and get-detail are NOT in DESTRUCTIVE_TOOLS
- Tool schemas: list has no required params, get has approval_request_id required, approve has approval_request_id + justification required, deny has approval_request_id + justification required
- Integration registry includes "threatlocker" with 3 secrets

---

## Verification

1. Run `node --experimental-strip-types --test test/threatlocker-approval-requests.test.js` — all tests pass
2. Run `cd web && npx next build` — build succeeds
3. Start dev server with `MOCK_MODE=true`, navigate to Settings > Integrations — verify ThreatLocker appears with API Key, Instance, and Organization ID fields
4. Ask "show me pending ThreatLocker approval requests" — verify `list_threatlocker_approvals` is called and returns mock data
5. Ask "approve that request" — verify confirmation gate fires for `approve_threatlocker_request`
6. Verify list/get tools are available to readers, approve/deny are admin-only
