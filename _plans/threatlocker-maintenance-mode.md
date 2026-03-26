# ThreatLocker Maintenance Mode

## Context

Maintenance mode changes in ThreatLocker currently require portal access and multiple clicks. During patching windows, software deployments, or incident response, security engineers need to quickly toggle machines in/out of maintenance. This plan adds five tools: two read-only (search computers, get computer details) and three destructive (set maintenance mode, schedule bulk maintenance, enable secured mode). All use the existing `getThreatLockerConfig()` pattern with SSRF-safe instance validation and GUID validation. The maintenance mode type mapping covers all 6 ThreatLocker modes plus the secured mode toggle.

---

## Key Design Decisions

- **Five tools** — `search_threatlocker_computers` (read-only), `get_threatlocker_computer` (read-only), `set_maintenance_mode` (destructive), `schedule_bulk_maintenance` (destructive), `enable_secured_mode` (destructive).
- **Existing ThreatLocker auth** — reuses `getThreatLockerConfig()` with `TL_INSTANCE_RE` validation and GUID validation from the approval tools.
- **Mode mapping** — short names to ThreatLocker IDs: learning→3, installation→2, monitor→1, secured→8, network_monitor→17, storage_monitor→18. `secured` mode uses `ComputerEnableProtection` instead of `ComputerUpdateMaintenanceMode`.
- **Search by type** — maps `name→1`, `username→2`, `ip→4` for the `searchBy` parameter.
- **Duration calculation** — if `duration_hours` is provided, calculates `endTime = now + duration`. If `end_time` is provided directly, uses that. Validates end time is in the future.
- **Separate search and set** — the analyst searches first to confirm the correct computer, then sets maintenance mode with the computer ID. No auto-resolve to avoid acting on the wrong machine.

---

## Files to Change

| File | Change |
|------|--------|
| `web/lib/types.ts` | Add 5 input interfaces |
| `web/lib/tools.ts` | Add 5 tool schemas; add 3 destructive tools to DESTRUCTIVE_TOOLS |
| `web/lib/executors.ts` | Add 5 executor functions with mode mapping, duration calculation; register in executors record |
| `web/lib/integration-registry.ts` | Add 5 tool names to ThreatLocker capabilities array |
| `cli/src/index.js` | Add 5 TOOL_COLORS + 3 TOOL_DESCRIPTIONS entries |
| `docs/user-guide.md` | Add 5 tools to tool reference table |
| `README.md` | Add 5 tools to tools table |
| `test/threatlocker-maintenance-mode.test.js` | New test file |

---

## Implementation Steps

### 1. Add input types in `web/lib/types.ts`

- `SearchThreatLockerComputersInput`: `search_text` (required string), `search_by` (optional: `"name" | "username" | "ip"`, default `"name"`), `page_size` (optional number, default 25)
- `GetThreatLockerComputerInput`: `computer_id` (required string — GUID)
- `SetMaintenanceModeInput`: `computer_id` (required GUID), `organization_id` (required GUID), `mode` (required: `"learning" | "installation" | "monitor" | "secured" | "network_monitor" | "storage_monitor"`), `duration_hours` (optional number), `end_time` (optional ISO-8601 string), `learning_type` (optional: `"autocomp" | "autogroup" | "autosystem"`, default `"autogroup"`)
- `ScheduleBulkMaintenanceInput`: `computers` (required array of `{computer_id, organization_id, computer_group_id}`), `mode` (required: `"learning" | "installation" | "monitor" | "disable_tamper"`), `start_time` (required ISO-8601), `end_time` (required ISO-8601), `permit_end` (optional boolean, default false)
- `EnableSecuredModeInput`: `computers` (required array of `{computer_id, organization_id}`)

### 2. Add tool schemas in `web/lib/tools.ts`

- Add all 5 after the existing ThreatLocker tools (after `deny_threatlocker_request`)
- `search_threatlocker_computers`: read-only, description mentions searching by hostname/username/IP
- `get_threatlocker_computer`: read-only, requires computer_id
- `set_maintenance_mode`: destructive, description mentions all 6 modes plus duration
- `schedule_bulk_maintenance`: destructive, description mentions multiple computers with scheduled window
- `enable_secured_mode`: destructive, description mentions returning computers to secured mode
- Add `set_maintenance_mode`, `schedule_bulk_maintenance`, `enable_secured_mode` to DESTRUCTIVE_TOOLS

### 3. Add executor functions in `web/lib/executors.ts`

- Import the 5 new input types
- Add mode mapping constants: `MAINTENANCE_MODE_MAP` (learning→3, etc.) and `SEARCH_BY_MAP` (name→1, username→2, ip→4)

**`search_threatlocker_computers`**: validate search_text non-empty, mock returns 2 computers, live POSTs to `/portalapi/Computer/ComputerGetByAllParameters` with `searchBy`, `searchText`, `pageNumber: 1`, `pageSize`, `orderBy: "computername"`

**`get_threatlocker_computer`**: validate computer_id as GUID, mock returns full computer details, live GETs `/portalapi/Computer/ComputerGetForEditById?computerId={id}`

**`set_maintenance_mode`**: validate both GUIDs, validate mode, calculate end time from duration_hours OR validate end_time, if mode is "secured" call `enable_secured_mode` internally instead. Mock returns success. Live POSTs to `/portalapi/Computer/ComputerUpdateMaintenanceMode` with mapped type, applicationId (learning_type for learning mode, empty for others), start/end datetimes. Log the action.

**`schedule_bulk_maintenance`**: validate computers array non-empty, validate all GUIDs, validate start/end times, mock returns success with count. Live POSTs to `/portalapi/Computer/ComputerDisableProtection` with `computerDetailDtos`, mode mapped, `permitEnd`, dates. Log the action.

**`enable_secured_mode`**: validate computers array non-empty, validate all GUIDs, mock returns success. Live POSTs to `/portalapi/Computer/ComputerEnableProtection` with `computerDetailDtos`. Log the action.

- Register all 5 in the executors record

### 4. Update integration registry

- Add 5 tool names to ThreatLocker `capabilities` array

### 5. CLI config

- TOOL_COLORS: search/get green, set/schedule/enable red bold
- TOOL_DESCRIPTIONS: `set_maintenance_mode: "Set {computer_id} to {mode} mode"`, `schedule_bulk_maintenance: "Schedule {mode} for {count} computers"`, `enable_secured_mode: "Enable secured mode on {count} computers"`

### 6. Update docs

- `docs/user-guide.md`: 5 tools (search/get All, set/schedule/enable Admin)
- `README.md`: 5 tools

### 7. Write tests

- Mode mapping: all 6 types map correctly
- Search-by mapping: name→1, username→2, ip→4
- Search and get-detail NOT in DESTRUCTIVE_TOOLS
- Set, schedule, enable ARE in DESTRUCTIVE_TOOLS
- GUID validation rejects invalid formats
- Duration calculation: 4 hours from now produces valid future ISO-8601
- End time validation rejects past dates

---

## Verification

1. Run `node --experimental-strip-types --test test/threatlocker-maintenance-mode.test.js` — all tests pass
2. Run `cd web && npx next build` — build succeeds
3. Start dev with `MOCK_MODE=true`, ask "put DESKTOP-001 into learning mode for 4 hours" — verify search + set flow
4. Verify destructive tools trigger confirmation gate
