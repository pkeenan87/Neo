# Scheduled-Task Tool Routing Destination

## Context

Today a scheduled task can only route its final agent output to one of three fixed destinations: `teams-channel` (Microsoft Graph), `cosmos-log` (no-op log-only), or `email` (Phase 2, not implemented). The Teams path uses the Neo app registration's `ChannelMessage.Send` Graph permission — every Teams change is a Neo code/permission change.

The operator has added two new workflows to the existing **Information Security Incident Response** Logic App: `send-teams-message` and `send-email`. Both have the same MCP `tools/list` shape — `{ taskName: string, status: string, summary: string }`, no `responder` field, no per-call recipient/channel configuration (the workflow itself owns routing). This plan introduces a new scheduled-task routing destination, `tool`, that invokes a named Neo tool with task context (name, status, summary) instead of posting to a fixed sink. The two Logic App tools are the first members; the allowlist is extensible without a Logic App schema change.

`cosmos-log` stays exactly as it is (preserved for dry runs and as the default fallback). `teams-channel` is preserved unchanged (no migration / no breaking change for existing tasks). The work spans the Neo-side mirror of the Infosec MCP integration (registry + tools + executors), the scheduled-task routing layer, validators, the create-task UI template, operator docs, and tests. It does NOT touch the Logic App workflows — those are shipped.

---

## Key Design Decisions

- **New destination value `tool`, not a generic "tool name as destination" string.** Keeps the discriminator in `routing.destination` consistent with the existing `teams-channel` / `cosmos-log` / `email` union and avoids breaking the TypeScript type. The tool to invoke lives in a new `routing.toolName` field.
- **No `routing.toolArgs`.** The Logic App's new workflows take a fixed three-field shape; per-call recipient/channel/subject configuration lives in the Logic App, not in the task document. The router builds the args from task context. If the Logic App ever exposes optional configuration fields, `toolArgs` can be added later without breaking persisted tasks.
- **Allowlist of tools that can serve as routing destinations.** Not every Neo tool is a notification — `delete_indicator` must not be configurable as a destination. Add a `ROUTING_ALLOWED_TOOLS` Set with explicit membership; initially `send_teams_message` and `send_email`. Adding a tool is a deliberate code change.
- **Destructive tools are structurally banned from this Set.** Validator double-checks `!DESTRUCTIVE_TOOLS.has(toolName)` to keep a careless future allowlist addition from making a destructive write configurable as a notification destination.
- **Neo-side schema decouples model UX from the Logic App wire contract.** Neo's tool schema uses `title` / `status` / `body` (the names that read naturally when the model calls these tools interactively). The executor maps them to the Logic App's `taskName` / `status` / `summary` before dispatching. If the Logic App schema ever changes, the mapping moves with it; Neo-side semantics stay stable.
- **The two new tools are NOT destructive.** They are notification dispatch — no remediation, no IOC blocks. They are added to `tools.ts` and `executors.ts` like the existing six Infosec tools, but NOT added to `DESTRUCTIVE_TOOLS`. They remain admin-only via `permissions.ts`, matching the rest of the Infosec integration.
- **No `responder` injection on the new tools.** Unlike the six destructive Infosec tools, the new MCP schema has no `responder` field. The executors do NOT call `resolveResponder`. Neo's own `tool_execution` audit event still captures the calling identity via `getLogContext()` (so internal audit is intact); the Logic App's audit captures whatever the Logic App captures.
- **`status` is hardcoded to `"success"` on routing-path dispatch.** `routeOutput` is only invoked when the agent loop succeeded (per the existing runner — `agentResult.type === "response" && !agentResult.interrupted`). Failure-path notification dispatch is intentionally out of scope; this destination notifies on success only. The status field is still wired up (rather than omitted) so the Logic App can use it for card colour / icon and a future failure-notification path can populate it directly.
- **`summary` is the same truncated text as the run-history `outputSummary`.** Reuse the runner's `summarize()` helper (or hoist it into a shared module) so the notification body matches what the operator sees in the run history — no surprise divergence.
- **Bypass the agent loop for routing.** Routing tool calls invoke the executor directly (not via `runAgentLoop`). The model never sees these dispatches. This matches how `routeOutput` currently calls Graph for `teams-channel`.
- **Establish a `task.createdBy` log-context envelope around the dispatch.** Neo's internal `tool_execution` audit reads `getLogContext()`. Without an envelope the routing-time call would have no calling identity. Wrap the dispatch so audit captures `userEmail: task.createdBy`, `role: admin` — same identity already used for the agent loop run.
- **Fallback destination stays restricted to the original three** (`teams-channel` / `cosmos-log` / `email`). A `tool` fallback would invite recursion (tool fails → fall back to another tool fails → …). `tool` primary always falls back to a simple, low-dependency destination — default `cosmos-log`.
- **Dry-run behaviour matches the existing pattern.** When `task.dryRun === true`, the router records `routedTo: "dry-run-log"` and does NOT invoke the tool. The would-have-sent payload (toolName + arg sizes) is logged at info level.
- **No schema migration on existing tasks.** Existing documents have `routing.destination` ∈ {teams-channel, cosmos-log, email} and no `toolName`. The new field is optional on the type and required only when `destination === "tool"`.

---

## Files to Change

| File | Change |
|------|--------|
| `web/lib/scheduled-task-types.ts` | Extend `ScheduledTaskDestination` union with `"tool"`. Add optional `toolName?: string` to `ScheduledTaskRouting`. |
| `web/lib/scheduled-task-validators.ts` | Add `"tool"` to `VALID_DESTINATIONS`. Add `ROUTING_ALLOWED_TOOLS` Set and a `validateToolRouting` helper (`toolName` required, in allowlist, not destructive). Reject `tool` as `fallbackDestination`. |
| `web/lib/scheduled-task-routing.ts` | Add `case "tool":` to `sendTo`. Establish a `task.createdBy` log-context envelope. Build args `{ title: task.name, status: "success", body: summarize(outputText) }` and dispatch via the local tool executor. Re-route to fallback on failure. Hoist `summarize()` out of `scheduled-task-runner.ts` into a shared module (or import it) so summary text matches the run-history entry. |
| `web/app/api/scheduled-tasks/route.ts` | Plumb `routing.toolName` through to `CreateScheduledTaskInput`. |
| `web/app/api/scheduled-tasks/[id]/route.ts` | Same plumbing for the PATCH update path. |
| `web/lib/tools.ts` | Add tool schemas for `send_teams_message` and `send_email` under a new "Notification workflows" comment. Both take `{ title, status, body }`, all required. Descriptions emphasise that these dispatch notifications via the Information Security Incident Response Logic App — they do NOT post directly and the channel/recipient routing is owned by the Logic App workflow. NOT added to `DESTRUCTIVE_TOOLS`. |
| `web/lib/executors.ts` | Add `send_teams_message` and `send_email` executors in the existing Infosec section. Both validate the three input fields (non-empty strings, no control chars), then dispatch via `callInfosecLogicAppTool` with the Neo → Logic App field mapping (`title → taskName`, `status → status`, `body → summary`). NO `resolveResponder` call. Update the executors map. |
| `web/lib/integration-registry.ts` | Append `send_teams_message` and `send_email` to the `infosec-incident-response` integration's `capabilities`. Update the `description` to mention notification dispatch alongside remediation. |
| `web/lib/permissions.ts` | Add both new tool names to the admin-allowed list. Mirror the existing six Infosec tools' permission grants. |
| `web/lib/scheduled-task-runner.ts` | If `summarize` gets hoisted (per routing.ts above), update the import. Otherwise no change. |
| `web/components/SettingsPage/ScheduledTasksSection.tsx` | Update `DEFAULT_NEW_TASK` template to demonstrate a `tool` destination with `cosmos-log` fallback. No form-control changes (raw-JSON editor). |
| `docs/scheduled-tasks.md` | New row in the "Routing destinations" table for `tool`. New subsection explaining the destination shape, the auto-populated args, the allowlist, and the fallback restriction. Update "Prerequisites" to clarify `ChannelMessage.Send` is only needed for `teams-channel` (not `tool`). Add an "Adding a new notification workflow" section. |
| `web/test/scheduled-task-routing.test.ts` (new) | Routing-layer unit tests (happy path, allowlist rejection, fallback on failure, dry-run skip, log-context envelope, arg construction). |
| `web/test/scheduled-task-validators.test.ts` (new or extend) | Validator tests for the new field shape. |
| `web/test/infosec-notification-executors.test.ts` (new) | Executor tests: mock-mode fixture, live-mode kebab-case dispatch, Neo → Logic App field mapping, input validation. |
| `cli/src/index.js` | Doc-only update to the `schedule` verb help text to mention `destination: "tool"`. |

---

## Implementation Steps

### 1. Extend the type and validator surface

- In `web/lib/scheduled-task-types.ts`:
  - Add `"tool"` to the `ScheduledTaskDestination` union.
  - Add optional `toolName?: string` to `ScheduledTaskRouting`. Document in a comment that `toolName` is required when `destination === "tool"` and that the routing layer auto-populates the tool's `{ title, status, body }` args from task context — there is no `toolArgs` field by design.
- In `web/lib/scheduled-task-validators.ts`:
  - Add `"tool"` to `VALID_DESTINATIONS`.
  - Add an exported `ROUTING_ALLOWED_TOOLS` Set: `new Set(["send_teams_message", "send_email"])`.
  - Add `validateToolRouting(routing, prefix)`:
    - Require `routing.toolName` to be a non-empty string.
    - Require `ROUTING_ALLOWED_TOOLS.has(toolName)` — clear error message listing the allowed values.
    - Import `DESTRUCTIVE_TOOLS` from `./tools` and reject if the candidate name is destructive (defence in depth against future allowlist mistakes).
  - Wire the helper into `validateRoutingShape` for `r.destination === "tool"`.
  - In the `fallbackDestination` block, reject `fallbackDestination === "tool"` with a clear error message (recursion guard).
- In `web/app/api/scheduled-tasks/route.ts` and `web/app/api/scheduled-tasks/[id]/route.ts`:
  - Pass `routing.toolName` through from the request body into the persisted shape.
  - No new validation at the route layer — the validators above are the single source of truth.

### 2. Add the two notification tools to the Infosec integration

- In `web/lib/tools.ts`, under a new comment header "Information Security Incident Response Logic App — notification workflows", add two new entries to the `TOOLS` array:
  - `send_teams_message`:
    - Required args: `title` (string), `status` (string), `body` (string).
    - Description emphasises: notification dispatch, Logic App owns Teams routing, idempotent fire-and-forget. Make clear this does NOT post directly via Graph.
  - `send_email`:
    - Same shape: `title`, `status`, `body`, all required.
    - Description: notification dispatch via email; recipient list is configured in the Logic App workflow, not per-call.
  - Neither tool added to `DESTRUCTIVE_TOOLS`.
- In `web/lib/executors.ts`:
  - Add a small validator `validateNotificationInput(toolName, input)` that:
    - Requires non-empty `title`, `status`, `body` (after trim).
    - Rejects control characters in any field via the existing `INFOSEC_CONTROL_CHAR_RE`.
    - Caps lengths defensively (e.g. `title` ≤ 200 chars, `status` ≤ 64 chars, `body` is left uncapped since the routing layer already passes summarized text; long ad-hoc model calls can still cap via the Logic App if desired).
  - Add `send_teams_message(input)`:
    - Mock-mode short-circuit returns a synthetic envelope `{ status: "submitted", mocked: true, tool: "send-teams-message", payload }`.
    - Live-mode calls `callInfosecLogicAppTool("send_teams_message", "send-teams-message", { taskName: title, status, summary: body })`. NO `responder` in the payload.
  - Add `send_email(input)`:
    - Same shape as above with kebab-case `send-email`.
  - Register both functions in the `executors` map.
- In `web/lib/integration-registry.ts`, append `send_teams_message` and `send_email` to the `infosec-incident-response` integration's `capabilities` array. Update the `description` from "Network-layer remediation via the Information Security Incident Response Logic App. Six destructive tools …" to mention notification dispatch alongside remediation. Reword the rest of the entry as needed for tone.
- In `web/lib/permissions.ts`, add both new tool names to admin's allowed-tool list, mirroring how the existing six Infosec tools are scoped. Do NOT grant to `reader` or `triage`.

### 3. Hoist `summarize()` into a shared module

- The runner's `summarize()` (lines 33, 73–76 in `web/lib/scheduled-task-runner.ts`) caps text at 2000 chars with a `\n…[truncated]` marker. The routing layer needs the same function so the Teams/email body matches the run-history `outputSummary`.
- Choose one of:
  - **(a)** Move `summarize` and `OUTPUT_SUMMARY_MAX` into a new tiny module `web/lib/scheduled-task-summary.ts`. Import from both `scheduled-task-runner.ts` and `scheduled-task-routing.ts`.
  - **(b)** Import `summarize` directly from `scheduled-task-runner.ts` into `scheduled-task-routing.ts`. Risks a circular import — verify by reading the existing imports in `scheduled-task-runner.ts` (it imports `routeOutput` from `scheduled-task-routing.ts`).
- Option (a) is the safer call because of (b)'s circular-import risk. Proceed with (a).

### 4. Implement `tool` routing in `scheduled-task-routing.ts`

- Import `executeTool` from `./executors` (verify the exact export name — if the entry point is different, use it).
- Import `ROUTING_ALLOWED_TOOLS` from `./scheduled-task-validators`.
- Import `summarize` from the new shared summary module.
- Identify how the runner sets log context for `runAgentLoop` today (it relies on `runAgentLoop`'s own context plumbing). For the new direct-dispatch path, the routing layer needs its own envelope. Check `web/lib/logger.ts` or `getLogContext` for the canonical `runWithLogContext`-style helper, and wrap the executor call in it with:
  - `userEmail: task.createdBy`
  - `userName: task.createdBy` (same value — for display)
  - `role: "admin"`
  - `sessionId: \`schedtask-${task.id}-routing\``
- Add a `case "tool":` arm to `sendTo`:
  - If `task.routing.toolName` is missing, throw "tool destination requires toolName" (validator should have caught this at write time — defence in depth).
  - If the tool name is no longer in `ROUTING_ALLOWED_TOOLS`, throw "tool destination toolName is not in ROUTING_ALLOWED_TOOLS" (handles the case where the allowlist shrinks after a task is persisted).
  - Build the args:
    - `title`: `task.name`
    - `status`: `"success"` (hardcoded; comment explains why and points to the future failure-path enhancement).
    - `body`: `summarize(outputText)`
  - Wrap the call in the log-context envelope (per above).
  - `await executeTool(task.routing.toolName, args)` — let any thrown error propagate so the existing fallback path kicks in.
- Update the dry-run branch in `routeOutput`: when `dryRun` AND `destination === "tool"`, the info log includes `toolName`, `titleLength`, `bodyLength` (no body content — it may contain sensitive output).
- Confirm by tracing the existing `routeOutput` error path that a `tool`-primary failure correctly chains to `fallbackDestination ?? "cosmos-log"`. No changes should be needed to that path — the new case throws on failure and the existing try/catch + fallback logic handles it.

### 5. Update the create-task UI template

- In `web/components/SettingsPage/ScheduledTasksSection.tsx`, replace `DEFAULT_NEW_TASK`'s `routing` clause with:
  - `destination: 'tool'`
  - `toolName: 'send_teams_message'`
  - `fallbackDestination: 'cosmos-log'`
- The template's surrounding fields stay the same. Confirm the JSON parses cleanly when the modal opens.
- Update the template's `description` field to reference the new pattern (e.g. "Notifies via the Logic App's Teams workflow") so an operator opening the modal sees an aligned example.

### 6. Update documentation

- In `docs/scheduled-tasks.md`:
  - In the "Routing destinations" table, add a row for `tool` documenting the auto-populated `{ taskName, status, summary }` payload and the fact that channel/recipient routing lives in the Logic App.
  - Add a "Routing destination: tool" subsection covering:
    - When to choose `tool` vs `teams-channel` (the former delegates routing logic to the Logic App).
    - The allowlist (`send_teams_message`, `send_email`) and that adding new tools requires a code change.
    - Field mapping table: Neo schema (`title`/`status`/`body`) → Logic App schema (`taskName`/`status`/`summary`).
    - That `tool` cannot be used as `fallbackDestination` and `cosmos-log` is the recommended fallback.
    - That `dryRun: true` skips the dispatch and records `routedTo: "dry-run-log"`.
  - In "Prerequisites", note that for `tool` destinations the Neo app registration does NOT need `ChannelMessage.Send` — the Logic App owns Teams posting. Leave Step 2 in place for operators who keep using `teams-channel` directly.
  - In "Troubleshooting", add a `tool` destination section: "Logic App returns 4xx/5xx → falls back to cosmos-log; check the Infosec integration's credentials in /integrations; verify `INFOSEC_LOGIC_APP_MCP_URL` is reachable; check the Logic App's run history for the workflow named `send-teams-message` or `send-email`."
  - Add an "Adding a new notification workflow" section: (a) define the workflow in the Logic App with a stable kebab-case tool name and `{ taskName, status, summary }` (or document any new schema), (b) add Neo-side tool schema + executor mapping, (c) add the Neo tool name to `ROUTING_ALLOWED_TOOLS`, (d) add to the integration's `capabilities`, (e) ship.

### 7. Tests

- New file `web/test/scheduled-task-routing.test.ts`:
  - Happy path: `destination: "tool"`, `toolName: "send_teams_message"`. Mock `executeTool` to assert it's called with `{ title: task.name, status: "success", body: <summarized output> }`. Verify `routedTo === "send_teams_message"`, `success === true`.
  - Disallowed tool: `toolName: "delete_indicator"` is rejected (defence-in-depth check inside `sendTo`); fallback to `cosmos-log` succeeds with a chained reason.
  - Tool throws: `executeTool` rejects → primary fails, fallback to `cosmos-log` succeeds with `reason: primary_failed:…`.
  - Dry-run: `dryRun: true` → `routedTo === "dry-run-log"`; `executeTool` not called.
  - Log-context envelope: spy on `getLogContext` inside the executor mock to confirm `userEmail === task.createdBy` and `role === "admin"`.
  - Output summarisation: a 4000-char output is passed in; assert `executeTool` receives a `body` capped to 2000 chars with the `…[truncated]` marker.
- New or extend `web/test/scheduled-task-validators.test.ts`:
  - `tool` without `toolName` → rejected.
  - `tool` with `toolName: "delete_indicator"` → rejected with allowlist error.
  - `tool` with `toolName: "send_teams_message"` → accepted.
  - `fallbackDestination: "tool"` → rejected.
- New file `web/test/infosec-notification-executors.test.ts`:
  - `send_teams_message` mock-mode returns synthetic fixture without hitting the network; envelope shape includes `mocked: true` and the kebab-case `tool: "send-teams-message"`.
  - `send_teams_message` live-mode (set `MOCK_MODE=false` and stub the MCP client) dispatches with payload `{ taskName: <title>, status, summary: <body> }` — verify the Neo → Logic App field mapping.
  - `send_email` mirrors the above with kebab-case `send-email`.
  - Validation rejects: empty `title`, empty `body`, control characters in `title`, oversized `title` (>200 chars), oversized `status` (>64 chars).
  - Verify no `responder` field is in the dispatched payload (regression guard — easy to add by mistake while copying from the existing block_* executors).
- Run `cd web && npm run test` after each suite to catch unintended fallout in existing tests (notably the existing Infosec executor tests — they should still pass since the changes are additive).

### 8. CLI

- In `cli/src/index.js`, update the help block around line 658 to mention `destination: "tool"` as an option. Pure docs change — the CLI sends raw JSON to the existing API and needs no schema work.

---

## Verification

1. **Type-check and lint.** `cd web && npm run typecheck && npm run lint`. The new `tool` member of the `ScheduledTaskDestination` union surfaces any unhandled `switch` arms; fix anything the compiler flags.
2. **Targeted unit tests.** `cd web && npm run test -- scheduled-task-routing scheduled-task-validators infosec-notification-executors`. All three suites green.
3. **Full suite.** `cd web && npm run test`. No regressions in scheduled-task or existing Infosec coverage.
4. **Manual smoke test (mock mode):**
   - `MOCK_MODE=true cd web && npm run dev`.
   - Settings → Scheduled Tasks → New task. The default template should now show `destination: "tool"`, `toolName: "send_teams_message"`. Save with `dryRun: true`, `enabled: true`.
   - Click "Run now". In the dev server logs confirm:
     - `scheduled_task.run_started`
     - `scheduled_task.dry_run_routed` with `destination: "tool"`, `toolName: "send_teams_message"`, `titleLength`, `bodyLength`.
     - Run history shows `routedTo: "dry-run-log"` — `executeTool` was NOT invoked.
   - Flip `dryRun: false`. Click "Run now". Confirm:
     - `tool_execution` audit event for `send_teams_message` with the mocked envelope, `userEmail` matching `task.createdBy`.
     - Run history shows `routedTo: "send_teams_message"`, `result: success`.
5. **Manual smoke test (validator rejection):** Via the CLI `neo schedule create --file rejected.json` with `destination: "tool"`, `toolName: "delete_indicator"`. Expect a 400 with the allowlist error.
6. **Manual smoke test (fallback path):** Create a task with `destination: "tool"`, `toolName: "send_teams_message"`, `fallbackDestination: "cosmos-log"`. With `MOCK_MODE=false` and an unreachable `INFOSEC_LOGIC_APP_MCP_URL`, run the task. Confirm `routedTo: "cosmos-log"`, `reason` chains the primary failure.
7. **Live-mode integration (operator-led):** With the Logic App workflows live and Infosec credentials configured, enable a real task. Confirm the message appears in the target Teams channel and inbox, that the agent's truncated summary is what shows up in both, and that the `tool_execution` audit event captures `apiManagementRequestId` and `workflowRunId`.
8. **Docs review.** Read `docs/scheduled-tasks.md` end-to-end. Confirm the new routing destination is documented, the prerequisites/troubleshooting reflect the change, and the existing `teams-channel` instructions still stand for operators who keep using them.
