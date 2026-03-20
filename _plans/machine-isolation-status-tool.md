# Machine Isolation Status Tool

## Context

Neo returned an incorrect answer about a machine's isolation status because it relied on Sentinel logs (DeviceEvents), which are unreliable for this data. A new read-only tool `get_machine_isolation_status` is needed that queries the Defender for Endpoint API directly for real-time isolation status and machine health. The CLI is a thin client that delegates to the web server, so the tool only needs to be added to the web side (`web/lib/`). The CLI display config (`cli/src/index.js`) needs a color mapping entry. The required API permission is `Machine.Read.All` which covers both `/api/machines/{id}` and `/api/machineactions`.

---

## Key Design Decisions

- **Defender-only for initial implementation** — CrowdStrike support can be added later following the same pattern as `isolate_machine`. No `platform` parameter needed yet.
- **Two API calls per invocation** — first `/api/machines?$filter=computerDnsName eq '{hostname}'` to resolve the machine ID and get health status, then `/api/machineactions?$filter=machineId eq '{id}'&$orderby=creationDateTimeUtc desc&$top=5` filtered to Isolate/Unisolate to determine isolation state.
- **Read-only tool** — not added to `DESTRUCTIVE_TOOLS`, available to both admin and reader roles.
- **Include machine health** — per the user's answer, return overall health status (healthStatus, riskScore, exposureLevel) alongside isolation status from the machines endpoint.
- **Existing hostname resolution pattern** — reuse the same `validateHostname` + `escapeODataString` + machines lookup pattern from `isolate_machine`.

---

## Files to Change

| File | Change |
|------|--------|
| `web/lib/tools.ts` | Add `get_machine_isolation_status` schema to the `TOOLS` array |
| `web/lib/types.ts` | Add `MachineIsolationStatusInput` interface |
| `web/lib/executors.ts` | Add `get_machine_isolation_status` executor with mock and live paths; register in the `executors` record |
| `cli/src/index.js` | Add entry to `TOOL_COLORS` map |
| `test/machine-isolation-status.test.js` | New test file for tool schema, mock responses, and status determination logic |

---

## Implementation Steps

### 1. Add the input type in `web/lib/types.ts`

- Add a new `MachineIsolationStatusInput` interface near the existing `IsolateMachineInput`
- Properties: `hostname` (required string) and `machine_id` (optional string)
- No `platform` parameter — Defender-only for now

### 2. Add the tool schema in `web/lib/tools.ts`

- Add a new tool object to the `TOOLS` array, positioned after `search_xdr_by_host` (grouping Defender tools together)
- Name: `get_machine_isolation_status`
- Description: "Check the real-time network isolation status and health of a machine via Microsoft Defender for Endpoint. Returns whether the machine is currently isolated, pending isolation, or not isolated, along with health status and risk score."
- Input schema: `hostname` (required string — "Hostname or FQDN of the machine") and `machine_id` (optional string — "Defender machine ID, if known")
- Do NOT add to `DESTRUCTIVE_TOOLS`

### 3. Add the executor function in `web/lib/executors.ts`

- Add a new `get_machine_isolation_status` async function following the existing dual-path pattern

- **Mock path**: Return a realistic object with fields: `isolationStatus` ("Isolated" / "NotIsolated" / "Pending"), `machineId`, `hostname`, `lastAction` (object with `type`, `status`, `requestor`, `creationDateTime`, `reason`), and `health` (object with `healthStatus`, `riskScore`, `exposureLevel`, `osPlatform`, `lastSeen`)

- **Live path**:
  1. Get a Defender token via `getAzureToken("https://api.securitycenter.microsoft.com")`
  2. If `machine_id` is not provided, resolve it by querying `GET /api/machines?$filter=computerDnsName eq '{hostname}'` using the same pattern as `isolate_machine`. Use `validateHostname` and `escapeODataString` for the hostname.
  3. If no machine is found, return an error result with a clear message
  4. From the machines response, extract health fields: `healthStatus`, `riskScore`, `exposureLevel`, `osPlatform`, `lastSeen`
  5. Query `GET /api/machineactions?$filter=machineId eq '{machineId}'&$orderby=creationDateTimeUtc desc&$top=10` to get recent actions
  6. Filter the results to actions where `type` is `"Isolate"` or `"Unisolate"` — take the most recent one
  7. Determine isolation status:
     - If no isolate/unisolate actions found → `"NotIsolated"` with a note "No isolation history found"
     - If most recent action is `Isolate` with status `Succeeded` → `"Isolated"`
     - If most recent action is `Isolate` with status `Pending` → `"Pending"`
     - If most recent action is `Unisolate` with status `Succeeded` → `"NotIsolated"`
     - If most recent action is `Isolate` with status `Failed` → `"NotIsolated"` with a note about the failed attempt
     - Any other combination → return the raw action for the agent to interpret
  8. Return a structured object with `isolationStatus`, `hostname`, `machineId`, `lastAction` details (type, status, requestor, creationDateTime, comment), and `health` details

- Register the function in the `executors` record at the bottom of the file

### 4. Add CLI display config in `cli/src/index.js`

- Add `get_machine_isolation_status: chalk.yellow` to the `TOOL_COLORS` map (yellow, matching other Defender/XDR tools)

### 5. Write tests in `test/machine-isolation-status.test.js`

- Use `node:test` runner matching existing test patterns
- Replicate the status determination logic (since the executor can't be imported directly)
- Test cases:
  - Most recent action is `Isolate` + `Succeeded` → returns `"Isolated"`
  - Most recent action is `Unisolate` + `Succeeded` → returns `"NotIsolated"`
  - No isolation actions found → returns `"NotIsolated"` with "no history" note
  - Most recent action is `Isolate` + `Pending` → returns `"Pending"`
  - Most recent action is `Isolate` + `Failed` → returns `"NotIsolated"` with failure note
  - Multiple actions — only the most recent determines status
  - Tool schema has expected properties (hostname required, machine_id optional)

---

## Verification

1. Run `node --experimental-strip-types --test test/machine-isolation-status.test.js` — all tests should pass
2. Run `cd web && npx next build` — build should succeed
3. Start dev server with `MOCK_MODE=true`, send "is machine DESKTOP-ABC123 isolated?" — verify the agent calls `get_machine_isolation_status` and returns mock data with both isolation status and health info
4. Confirm the tool appears in the reader role's tool list (not gated behind admin)

---

## API Permission Note

The `Machine.Read.All` application permission (configured in the Azure AD app registration under Microsoft Threat Protection / WindowsDefenderATP) is sufficient for both:
- `GET /api/machines/{id}` (machine details and health)
- `GET /api/machineactions` (action history including isolation)

No additional permissions beyond what's already configured for `isolate_machine` are needed, since the existing app registration already has Defender access.
