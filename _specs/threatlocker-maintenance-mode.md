# Spec for ThreatLocker Maintenance Mode

branch: claude/feature/threatlocker-maintenance-mode

## Summary

Add tools to put machines into maintenance mode in ThreatLocker via Neo — enable/disable protection, set mode type (learning, installation, monitor, secured), schedule start/end times, and return to secured mode. This currently requires portal access and multiple clicks through the Devices page. During patching windows, software deployments, or incident response, security engineers need to quickly toggle machines in/out of maintenance without context-switching. Uses the existing ThreatLocker integration (API key + instance + org ID).

## Functional requirements

- Add a new tool `search_threatlocker_computers` (read-only) that searches for computers via `POST /portalapi/Computer/ComputerGetByAllParameters`
  - Accepts: `search_text` (required string — computer name, username, or IP), `search_by` (optional: `"name"` | `"username"` | `"ip"`, default `"name"`), `page_size` (optional, default 25)
  - Returns: list of computers with computerId, organizationId, computerGroupId, computerName, status

- Add a new tool `get_threatlocker_computer` (read-only) that gets full details via `GET /portalapi/Computer/ComputerGetForEditById?computerId={id}`
  - Accepts: `computer_id` (required GUID)
  - Returns: full computer details including current maintenance mode, group, options

- Add a new tool `set_maintenance_mode` (destructive, requires confirmation) that sets a single computer's maintenance mode via `POST /portalapi/Computer/ComputerUpdateMaintenanceMode`
  - Accepts: `computer_id` (required GUID), `organization_id` (required GUID), `mode` (required: `"learning"` | `"installation"` | `"monitor"` | `"secured"` | `"network_monitor"` | `"storage_monitor"`), `duration_hours` (optional number — calculates end time), `end_time` (optional ISO-8601 — absolute end), `learning_type` (optional: `"autocomp"` | `"autogroup"` | `"autosystem"`, default `"autogroup"`)
  - Maps mode to maintenanceTypeId: learning→3, installation→2, monitor→1, secured→8, network_monitor→17, storage_monitor→18
  - For secured mode, calls `ComputerEnableProtection` instead

- Add a new tool `schedule_bulk_maintenance` (destructive, requires confirmation) that schedules maintenance on multiple computers via `POST /portalapi/Computer/ComputerDisableProtection`
  - Accepts: `computers` (required array of {computer_id, organization_id, computer_group_id}), `mode` (required: `"learning"` | `"installation"` | `"monitor"` | `"disable_tamper"`), `start_time` (required ISO-8601), `end_time` (required ISO-8601), `permit_end` (optional boolean — allow user to end early, default false)

- Add a new tool `enable_secured_mode` (destructive, requires confirmation) that returns computers to secured mode via `POST /portalapi/Computer/ComputerEnableProtection`
  - Accepts: `computers` (required array of {computer_id, organization_id})

- All tools use the existing ThreatLocker integration auth (`getThreatLockerConfig()`)
- Search and get-detail tools are read-only; set/schedule/enable tools are destructive (admin + confirmation)
- All tools follow the existing mock/live dual-path pattern with validation before mock
- Add tool names to the ThreatLocker integration `capabilities` array
- Add tools to CLI color mappings and TOOL_DESCRIPTIONS for destructive tools

## Possible Edge Cases

- Computer not found by hostname — return clear message with search suggestions
- Computer already in maintenance mode — the API may succeed (overwrite) or error; handle gracefully
- Duration + end_time both provided — prefer end_time, ignore duration
- End time in the past — validate before API call
- Bulk maintenance with computers from different organizations — each computer has its own org ID
- Learning mode without learning_type — default to `autogroup`
- Installation mode without application_id — some installations may require it; for now pass empty string and let the API respond

## Acceptance Criteria

- An analyst can say "put DESKTOP-001 into learning mode for 4 hours" and Neo handles the full workflow (search → set maintenance)
- An analyst can say "put DESKTOP-001 back in secured mode" and Neo re-enables protection
- Bulk scheduling works for multiple computers with a specified window
- All destructive tools require confirmation
- All tools work in mock mode with realistic data

## Open Questions

- Should the search tool auto-resolve the first result or always present options to the analyst? Always present options — let the analyst confirm which computer.
- Should `set_maintenance_mode` auto-search by hostname if no computer_id is provided? No — keep the two steps separate (search then set) for clarity and confirmation.

## Testing Guidelines

Create test file(s) in the `./test` folder for the new feature, and create meaningful tests for the following cases:

- Maintenance mode type mapping: learning→3, installation→2, monitor→1, secured→8
- Search tool and get-detail tool are NOT in DESTRUCTIVE_TOOLS
- set_maintenance_mode, schedule_bulk_maintenance, enable_secured_mode ARE in DESTRUCTIVE_TOOLS
- GUID validation on computer_id and organization_id
- Duration-to-end-time calculation produces valid ISO-8601
- End time validation rejects past dates
