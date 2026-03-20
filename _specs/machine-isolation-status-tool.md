# Spec for Machine Isolation Status Tool

branch: claude/feature/machine-isolation-status-tool

## Summary

Neo currently lacks a way to check whether a machine is isolated. Querying Sentinel logs (DeviceEvents) for isolation status is unreliable — the expected log events are often missing. A dedicated tool is needed that calls the Microsoft Defender for Endpoint API (`/api/machineactions`) to retrieve the real-time isolation status of a machine, giving SOC analysts an accurate, authoritative answer.

## Functional requirements

- Add a new read-only tool `get_machine_isolation_status` that queries the Defender for Endpoint API to determine whether a specific machine is currently isolated
- The tool should accept a machine hostname (and optionally a machine ID) as input, matching the existing `isolate_machine` / `unisolate_machine` parameter pattern
- Query the Defender API `machineactions` endpoint filtered to `type: "Isolate"` or `type: "Unisolate"` actions for the target machine, sorted by most recent
- Return a clear status indicating: isolated, not isolated, or isolation pending (based on the most recent action's `status` field — e.g. `Succeeded`, `Pending`, `Failed`)
- Include relevant context in the response: when the isolation was applied/removed, who requested it, and the stated reason
- This is a read-only tool — it should NOT be added to the DESTRUCTIVE_TOOLS set
- Follow the existing mock/live dual-path pattern in executors: return realistic mock data when `MOCK_MODE=true`, call the real Defender API when `MOCK_MODE=false`
- Add the tool to both the CLI (`cli/src/tools.js`, `cli/src/executors.js`) and the web (`web/lib/tools.ts`, `web/lib/executors.ts`)

## Possible Edge Cases

- Machine has never been isolated (no `machineactions` records) — return "not isolated" with a note that no isolation history was found
- Machine has been isolated and then unisolated — the most recent action determines the current state
- Isolation action is in a `Pending` state — report "isolation pending" rather than definitively isolated
- Machine hostname not found in Defender — return a clear error rather than a false "not isolated" answer
- Multiple recent actions for the same machine (e.g., rapid isolate/unisolate) — use the most recent by timestamp
- Machine ID provided but hostname not — should still work (query by machine ID directly)

## Acceptance Criteria

- `get_machine_isolation_status` is available as a tool in both CLI and web
- In mock mode, returns realistic simulated isolation status data
- In live mode, queries the Defender for Endpoint `machineactions` API and returns the current isolation state
- The agent can correctly answer "is machine X isolated?" by calling this tool
- The tool does not require confirmation (read-only)
- Tool color mapping and description are added to the CLI display configuration

## Open Questions

- Should the tool also return the machine's overall health status from the Defender machines API (`/api/machines`), or strictly the isolation status? yes health status too.
- Which Defender API permission scope is needed — is `Machine.Read.All` sufficient, or does querying `machineactions` require `MachineAction.Read.All`? Can you research this, let me know the answer, and then update the docs. I will add whatever permission is needed.
- Should the tool support CrowdStrike as a platform option (like `isolate_machine` does), or is Defender-only acceptable for the initial implementation?

## Testing Guidelines

Create test file(s) in the `./test` folder for the new feature, and create meaningful tests for the following cases:

- Mock executor returns valid isolation status data with expected fields (status, timestamp, requestor, reason)
- Tool correctly identifies "isolated" state from a recent `Isolate` action with `Succeeded` status
- Tool correctly identifies "not isolated" when the most recent action is `Unisolate` with `Succeeded` status
- Tool handles the "never isolated" case (no matching actions) gracefully
- Tool handles a `Pending` isolation action correctly
- Tool schema matches the expected parameter structure (hostname required, machine_id optional)
