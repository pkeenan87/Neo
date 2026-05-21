# Scheduled Tasks

## Context

Add a poller-based execution engine that lets Neo wake up on its own and run agent-loop jobs on a cron schedule. Tasks live in a new Cosmos container, are claimed via etag-conditional writes (to prevent double-fire across Function instances), and are managed from both a new Web UI page (`/settings/scheduled-tasks`) and a new CLI verb (`neo schedule …`). Execution reuses the existing `runAgentLoop` in `web/lib/agent.ts`; the Azure Function calls a privileged internal Web API endpoint rather than duplicating the agent code into the Function project. Spec lives at `_specs/scheduled-tasks.md`.

---

## Key Design Decisions

- **Single Cosmos container `scheduledTasks` with embedded `runHistory[]` (cap 50).** Mirrors the existing pattern of self-contained Cosmos documents (e.g. `conversations`). Full historical runs beyond the 50-entry cap fall off into the existing audit log via `logger.ts` — separate "runs" container is not needed for Phase 1.
- **Azure Function calls a Neo Web API endpoint, not Cosmos directly.** A new private endpoint `POST /api/internal/scheduled-tasks/poll` does one polling pass: query Cosmos for due tasks, claim, run agent loop in-process, route output. This keeps `runAgentLoop`, `permissions.ts`, `context-manager.ts`, etc. as a single source of truth and avoids a parallel implementation in the Function. The Function is a thin "wake up every 2 min and POST to /poll" wrapper.
- **Internal endpoint authenticated by Managed Identity bearer (Function → Web App).** No new shared secret. The Function's system-assigned MI gets an AAD token for the Web App's `api://<app-id>/.default` audience; the endpoint verifies the token's `oid` matches the Function's MI principal. This sidesteps the "where do we store a static shared secret" question and aligns with how the existing infra authenticates Cosmos.
- **`runAgentLoop` already accepts `signal?: AbortSignal` and `systemPromptOverride?: string`** (`web/lib/agent.ts:553`). We pass an `AbortSignal.timeout(maxDurationSeconds * 1000)` per run, and use `systemPromptOverride` to inject a scheduled-task-specific prefix that tells the model "you are running headless on a cadence — produce a written summary; do not ask the user follow-up questions". No agent-loop changes required.
- **Tool allowlist enforced as the intersection of (`task.allowedTools`) ∩ (`getToolsForRole(role)`).** The role baseline is `permissions.ts:getToolsForRole`. The intersection is computed at run-time, not stored, so role changes propagate without rewriting task documents. Destructive tools are *never* available to scheduled tasks (even if the creator was admin) — scheduled execution can't satisfy the human confirmation gate.
- **One new Cron parser dependency: `cron-parser`.** Maintained, supports IANA timezones, ~30 KB. Validation of cron expressions, computation of `nextRunTime` after each run, and the "preview next 5 fires" UI all go through one helper module `web/lib/cron-helpers.ts`.
- **Teams output uses Microsoft Graph `POST /teams/{teamId}/channels/{channelId}/messages`** (Application permission `ChannelMessage.Send.Group` consented per channel via Resource-Specific Consent, or `ChannelMessage.Send` tenant-wide). New helper `web/lib/teams-channel.ts`. No existing Teams-posting code in the repo to reuse.
- **Out-of-band "Run now" executes in-process on the Web API** (faster feedback), but follows the same etag-claim path so it can't double-fire alongside a scheduled run.
- **CLI talks to the Web API, never to Cosmos.** Existing CLI auth (`cli/src/auth-entra.js`) already provides a bearer token; reuse it for new endpoints.
- **Phase 1 minimum to ship**: poller Function, Cosmos schema, CRUD API, basic Web UI, CLI list/show/enable/disable/delete, Teams + Cosmos routing, dry-run, etag-claim, audit logging, timeout enforcement, circuit breaker. Phase 2: natural-language skill and email routing. Phase 3: dashboard tiles and App Insights queries. The plan covers Phase 1 in full and stubs Phase 2/3 as follow-up steps at the end.

---

## Files to Change

### New files

| File | Purpose |
|------|---------|
| `web/lib/scheduled-task-store.ts` | Cosmos CRUD + etag-conditional claim, mirrors `triage-store.ts` and `conversation-store.ts` patterns. |
| `web/lib/scheduled-task-runner.ts` | Builds prompt from template + variables, invokes `runAgentLoop` with the task's allowlist and timeout, captures output, records run history, computes next `nextRunTime`. |
| `web/lib/scheduled-task-routing.ts` | Routes output to `teams-channel` \| `cosmos-log` \| `email`; falls back to `fallbackDestination` on primary failure. |
| `web/lib/teams-channel.ts` | New: Microsoft Graph helper to post to a Teams channel via `POST /teams/{teamId}/channels/{channelId}/messages`. |
| `web/lib/cron-helpers.ts` | Wraps `cron-parser`. Validates expressions, computes next-N fires for a given timezone, rejects expressions whose interval is faster than the poll interval. |
| `web/lib/scheduled-task-types.ts` | (Or extend `web/lib/types.ts`.) TS types for `ScheduledTask`, `ScheduledTaskRunHistoryEntry`, `ScheduledTaskRouting`, `ScheduledTaskAuth`, `ScheduledTaskState`. |
| `web/app/api/scheduled-tasks/route.ts` | `GET` (list) + `POST` (create). Admin-only via `getAuthContext()`. |
| `web/app/api/scheduled-tasks/[id]/route.ts` | `GET`, `PATCH`, `DELETE`. Admin-only. |
| `web/app/api/scheduled-tasks/[id]/run/route.ts` | `POST` — "Run now" out-of-band trigger. Admin-only. |
| `web/app/api/scheduled-tasks/[id]/runs/route.ts` | `GET` — paginated run history. Admin-only. |
| `web/app/api/internal/scheduled-tasks/poll/route.ts` | `POST` — invoked only by the Azure Function. Verifies caller's Managed Identity bearer token; performs one polling pass. |
| `web/app/settings/scheduled-tasks/page.tsx` | List view + create/edit form + detail view + run-history pane. Uses existing `SettingsPage` shell. |
| `web/components/ScheduledTasks/ScheduledTaskList.tsx` | List table with status pills. |
| `web/components/ScheduledTasks/ScheduledTaskForm.tsx` | Create / edit form (cron, timezone, prompt template, variables, tools, routing, dry-run). |
| `web/components/ScheduledTasks/ScheduledTaskDetail.tsx` | Detail panel with run history. |
| `web/components/ScheduledTasks/index.ts` | Barrel export. |
| `functions/host.json` | Azure Function App config. |
| `functions/package.json` | Function App dependencies (just `@azure/identity` for the MI token + `node-fetch` if needed). |
| `functions/local.settings.json.example` | Example local settings (no secrets). |
| `functions/scheduledTaskPoller/index.ts` | Timer-triggered handler. Reads `NEO_WEB_URL` and `NEO_API_AUDIENCE` from env, gets an MI token, POSTs to `/api/internal/scheduled-tasks/poll`. Logs success/failure to App Insights. |
| `functions/scheduledTaskPoller/function.json` | Timer trigger schedule `0 */2 * * * *`. |
| `functions/.funcignore` | Standard exclusions. |
| `functions/README.md` | How to run locally + deploy. |
| `web/lib/scheduled-task-internal-auth.ts` | Verifies the inbound bearer on `/api/internal/scheduled-tasks/poll` (audience + `oid` allowlist of the Function App's MI principal). |
| `test/scheduled-task-store.test.js` | Etag-claim race, container provisioning sanity. |
| `test/scheduled-task-runner.test.js` | Prompt-template substitution, allowed-tool intersection, timeout abort, dry-run, circuit breaker. |
| `test/cron-helpers.test.js` | Cron validation (reject too-frequent), DST boundary, next-N preview. |
| `test/scheduled-task-routing.test.js` | Teams primary OK; Teams 4xx → fallback to `cosmos-log`. |
| `test/scheduled-tasks-api.test.js` | API authz (non-admin 403); CRUD happy path against in-memory Cosmos. |

### Existing files to modify

| File | Change |
|------|--------|
| `web/lib/cosmos-startup-check.ts` | Add `"scheduledTasks"` to `REQUIRED_CONTAINERS`. |
| `scripts/provision-cosmos-db.ps1` | Add a step `12/12 Creating scheduledTasks container...` with `--partition-key-path "/id"` and `--max-throughput 1000` (autoscale, like `triageRuns`). Update existing step numbering. |
| `web/lib/permissions.ts` | (No change to roles.) Confirm `canUseTool` denies `DESTRUCTIVE_TOOLS` regardless of role — already true. Add a comment in `scheduled-task-runner.ts` referencing this. |
| `web/lib/agent.ts` | (No change.) `runAgentLoop` already accepts `signal`, `systemPromptOverride`, and `tools` filtering downstream. Confirm by tracing. |
| `web/lib/get-auth-context.ts` | (No change.) Existing helper is reused by every new route. |
| `web/lib/logger.ts` | (No change.) Reuse for audit-log emission. |
| `cli/src/index.js` | Add `schedule` sub-command dispatch alongside `auth`, `config`, `update`, `prompt`. Routes through `cli/src/server-client.js` to the new Web API endpoints. |
| `cli/src/server-client.js` | Add wrapper methods: `listSchedules`, `getSchedule`, `createSchedule`, `patchSchedule`, `deleteSchedule`, `runScheduleNow`. |
| `cli/package.json` | (Likely no new dep; uses existing fetch.) |
| `web/package.json` | Add `cron-parser` runtime dependency. Pin to a recent major version. |
| `web/app/settings/layout.tsx` or sidebar component | Add a "Scheduled Tasks" nav entry, admin-only. |
| `web/components/index.ts` | Re-export new `ScheduledTasks/*` barrel. |
| `web/tailwind.config.ts` | (No change expected — new components use existing tokens.) |
| `web/lib/types.ts` | (Optional.) If `scheduled-task-types.ts` is folded in here, add the new interfaces. Plan keeps them separate for clarity. |
| `README.md` | New section under "Required Azure App Registration Permissions": add `Microsoft Graph / ChannelMessage.Send` (Application). Plus a note that the Function App needs system-assigned Managed Identity. |

---

## Implementation Steps

### 1. Cosmos schema + provisioning

- Edit `scripts/provision-cosmos-db.ps1`. After the `triageRuns` step, add a new idempotent step that creates the `scheduledTasks` container with `--partition-key-path "/id"`, autoscale `--max-throughput 1000`, no TTL (tasks are not auto-expired). Bump the step labels (`12/12`).
- Edit `web/lib/cosmos-startup-check.ts`: append `"scheduledTasks"` to `REQUIRED_CONTAINERS`.
- Operators must re-run `provision-cosmos-db.ps1` before deploying this change. Document in the PR description.

### 2. Types

- Create `web/lib/scheduled-task-types.ts` (or section in `web/lib/types.ts`). Define interfaces matching the spec's data model exactly: `ScheduledTask`, `ScheduledTaskSchedule`, `ScheduledTaskTask`, `ScheduledTaskRouting`, `ScheduledTaskAuth`, `ScheduledTaskState`, `ScheduledTaskRunHistoryEntry`. Include literal unions for `state.status` (`"idle" | "running" | "failed"`), `state.lastRunResult` (`"success" | "failure" | "timeout"`), and `routing.destination` (`"teams-channel" | "cosmos-log" | "email"`).
- Add `circuitBreakerThreshold?: number` to the task root (default 3 at runtime if absent) and `dryRun: boolean`.
- Export everything for reuse by routes, store, runner, and UI.

### 3. Cron helpers

- Add `cron-parser` to `web/package.json` (server-only — UI imports through a server action or via the create-form API, not directly).
- Create `web/lib/cron-helpers.ts` exposing:
  - `validateCronExpression(expr, timezone, pollIntervalSeconds)` — throws on syntax errors, IANA timezone errors, or expressions whose two adjacent fires are less than `pollIntervalSeconds` apart.
  - `computeNextRunTime(expr, timezone, fromIso)` — returns ISO UTC string for the next fire after `fromIso`.
  - `previewNextNFires(expr, timezone, n)` — returns `n` upcoming ISO UTC strings (used by the UI form helper).

### 4. Store (Cosmos CRUD + etag claim)

- Create `web/lib/scheduled-task-store.ts`. Lazy-initialize the container the same way `triage-store.ts` does (`getContainer()` singleton).
- Exports:
  - `createTask(input, createdBy)` — generates `id`, sets initial `state.status = "idle"`, `state.consecutiveFailures = 0`, computes initial `nextRunTime` from cron, writes via `items.create`. Returns the persisted task.
  - `listTasks()` — returns all tasks (admin scope; no per-user filtering in Phase 1).
  - `getTask(id)` — reads by id (cross-partition since pk is `/id`).
  - `patchTask(id, patch, expectedEtag)` — PATCH with `accessCondition: { type: "IfMatch", condition: expectedEtag }`. Throws a typed error on 412 so callers can decide whether to retry.
  - `deleteTask(id)` — hard delete.
  - `findDueTasks(nowIso, limit)` — Cosmos SQL: `SELECT * FROM c WHERE c.enabled = true AND c.state.nextRunTime <= @now AND c.state.status != 'running' ORDER BY c.state.nextRunTime ASC OFFSET 0 LIMIT @limit`. Limit defaults to 10 per cycle (soft cap; configurable via env).
  - `claimTask(task)` — writes `state.status = "running"`, `state.lastRunTime = now`, with `IfMatch: task._etag`. Returns the new etag, or throws `ScheduledTaskClaimConflict` on 412.
  - `recordRunResult(taskId, expectedEtag, runEntry, newState)` — writes the run-history entry (with cap-50 truncation) and the new `state` (next run time, lastRunResult, etc.) in one PATCH. Used by the runner after the agent loop completes.

### 5. Runner (one execution)

- Create `web/lib/scheduled-task-runner.ts`. Single entry: `executeTask(task: ScheduledTask): Promise<RunOutcome>`.
- Inside `executeTask`:
  1. Resolve `effectiveAllowedTools`: intersect `task.task.allowedTools` with `getToolsForRole("admin")` minus everything in `DESTRUCTIVE_TOOLS`. If the intersection is empty, record `"failure"` with reason `"no_allowed_tools"` and return.
  2. Resolve `effectivePromptTemplate`: substitute `{{today}}` (ISO date) and any `task.task.variables` keys. Unknown `{{...}}` placeholders cause a `"failure"` with reason `"unknown_template_variable"`.
  3. Build the scheduled-task system prompt prefix: a short block stating "you are running headless on a cadence; produce a concise written summary at the end; do not ask follow-up questions; do not call destructive tools (they are unavailable here anyway)."
  4. Invoke `runAgentLoop` with:
     - `messages = [{ role: "user", content: <effectivePromptTemplate> }]`
     - `callbacks = { onAssistantText, onToolUse, onToolResult }` accumulating into a local transcript
     - `role = "admin"` (the task creator's role at creation time)
     - `sessionId = "schedtask-<task.id>-<runId>"`
     - `model` from existing default config
     - `systemPromptOverride` = base prompt + scheduled-task prefix
     - `options.signal = AbortSignal.timeout(task.task.maxDurationSeconds * 1000)`
  5. On agent-loop completion: capture the last assistant message as `outputText`, summarize to ≤ N chars for `outputSummary`.
  6. Pass to `routeOutput(task, outputText)` (see step 6). Get back `{ routedTo, success }`.
  7. Compute `nextRunTime` via `cron-helpers.computeNextRunTime`.
  8. Build `runEntry` and updated `state`. If outcome was failure, `state.consecutiveFailures += 1`; on success, reset to 0.
  9. If `state.consecutiveFailures >= circuitBreakerThreshold` → flip `enabled: false`, set `state.status = "failed"`, and emit a Teams notification to the admin channel (via the same `teams-channel.ts` helper).
  10. Call `recordRunResult(task.id, task._etag-after-claim, runEntry, newState)`.
- Distinguish `"timeout"` from generic `"failure"` based on whether the `AbortSignal.timeout` fired (catch `DOMException` with `name === "TimeoutError"` from the agent loop's propagated error).

### 6. Output routing

- Create `web/lib/scheduled-task-routing.ts`. Single entry: `routeOutput(task, outputText): Promise<{ routedTo, success }>`.
- For `routing.destination === "teams-channel"`: call `teams-channel.ts:postToChannel({ teamId, channelId, text })`.
- For `routing.destination === "email"`: stub in Phase 1 — throw `"email_routing_not_yet_implemented"` and let the fallback kick in. (Real implementation: Phase 2, via Graph `/users/{id}/sendMail`.)
- For `routing.destination === "cosmos-log"`: write an entry to a new lightweight log in `runHistory[]` (always true — this is the no-op routing).
- On `task.dryRun === true`: skip the primary destination and record `routedTo: "dry-run-log"` with the would-have-sent payload.
- On primary failure: try `routing.fallbackDestination` (default `"cosmos-log"`). If that also fails, return `{ success: false }`.

### 7. Teams helper

- Create `web/lib/teams-channel.ts`. Exposes `postToChannel({ teamId, channelId, text })`.
- Auth: uses `getMSGraphToken()` from `web/lib/auth.ts` (the existing Graph app reg). Sends a `POST` to `https://graph.microsoft.com/v1.0/teams/{teamId}/channels/{channelId}/messages` with `{ body: { content: text, contentType: "text" } }`.
- Add a comment that the app registration needs `ChannelMessage.Send` (Application) consented. Update `README.md` permissions table.

### 8. Web API routes

- `web/app/api/scheduled-tasks/route.ts`:
  - `GET` — `getAuthContext()`, require `admin`, return `listTasks()` with `_etag` stripped.
  - `POST` — body schema validated; call `scheduled-task-store.createTask`. Emit audit log entry.
- `web/app/api/scheduled-tasks/[id]/route.ts`:
  - `GET` — return one task.
  - `PATCH` — body must include `expectedEtag`; pass to `patchTask`; on 412 return 409 to caller.
  - `DELETE` — hard delete, emit audit log.
- `web/app/api/scheduled-tasks/[id]/run/route.ts`:
  - `POST` — load task, attempt `claimTask`. If claim succeeds, call `executeTask` in-process (do not block the HTTP response too long: stream a 202 "accepted" and run in the background, or block up to a configured cap — Phase 1 picks "block up to 30s, then return 202 with run-in-progress; the runner continues in the background via `waitUntil` on Vercel-style or a fire-and-forget Promise on Node"). Reuse existing patterns in `triage-wrapper.ts` if present.
- `web/app/api/scheduled-tasks/[id]/runs/route.ts`:
  - `GET` — return `task.runHistory` paginated (default 20 per page, max 50 since that's the cap).
- `web/app/api/internal/scheduled-tasks/poll/route.ts`:
  - `POST` — verify the inbound `Authorization: Bearer <token>` via `scheduled-task-internal-auth.ts` (expected audience = the Web App's app-id-URI; expected `oid` = the Function App's MI principal-id, configured via env `SCHEDULED_TASK_POLLER_MI_OID`). Reject otherwise.
  - After auth: call `findDueTasks(now, pollLimit)`. For each task: `claimTask` (skip on 412), then `executeTask` *sequentially* (no parallel runs within a single poll cycle in Phase 1 — keeps RU cost predictable). Return a JSON summary `{ scanned, claimed, executed, durations: [...] }`.

### 9. Internal-poll authentication

- Create `web/lib/scheduled-task-internal-auth.ts`. Verifies an AAD-issued JWT: signature (via JWKs from `https://login.microsoftonline.com/{tenant}/discovery/v2.0/keys`), `aud`, `iss`, `tid`, and `oid` matches the configured MI principal id (env `SCHEDULED_TASK_POLLER_MI_OID`).
- If `process.env.NODE_ENV !== "production"` and `SCHEDULED_TASK_POLLER_DEV_BYPASS === "true"`, accept without verification (so local dev can hit the endpoint). Otherwise fail-closed.

### 10. Azure Function project

- Create new top-level `functions/` directory (sibling of `web/` and `cli/`).
- `functions/package.json`: dependencies `@azure/identity`, `@azure/functions`. Type `module`.
- `functions/host.json`: standard v4 programming model config; logging routed to App Insights via instrumentation key.
- `functions/scheduledTaskPoller/function.json`: timer trigger with `schedule: "0 */2 * * * *"` (every 2 minutes).
- `functions/scheduledTaskPoller/index.ts`: entry handler. On each invocation:
  1. Read `NEO_WEB_URL` and `NEO_WEB_AUDIENCE` env (e.g. `https://neo.example.com` and `api://<web-app-id>`).
  2. Use `ManagedIdentityCredential` to get a token for `${NEO_WEB_AUDIENCE}/.default`.
  3. `POST ${NEO_WEB_URL}/api/internal/scheduled-tasks/poll` with `Authorization: Bearer <token>`.
  4. Log response summary to App Insights (count of claimed/executed tasks, duration).
  5. Swallow per-call errors so a 5xx from Web doesn't break the next tick — log and exit.
- `functions/.funcignore`: standard.
- `functions/README.md`: local dev (`func start`), deploying (Azure Functions Core Tools + GitHub Actions workflow stub).
- **Deferred**: GitHub Actions workflow to publish the Function App on tag — Phase 2.

### 11. Web UI

- Add a new sidebar nav entry "Scheduled Tasks" in the existing settings layout. Admin-only.
- `web/app/settings/scheduled-tasks/page.tsx` — Server Component that does the initial fetch via the API; render `<ScheduledTaskList>` and the create-task button. Form opens a modal or routes to `/settings/scheduled-tasks/new`.
- `web/components/ScheduledTasks/ScheduledTaskList.tsx` — table with columns: name, schedule (humanized), next run countdown, last run status pill, failure count, enabled toggle, actions (edit/delete/run-now). Sortable by next-run-time. Adheres to the 3-class inline rule from CLAUDE.md (CSS Modules with `@reference "../../app/globals.css"`).
- `web/components/ScheduledTasks/ScheduledTaskForm.tsx` — full create/edit form. Cron field has a "preview next 5 fires" helper calling a server action wrapping `previewNextNFires`. Timezone is a select (IANA list). Prompt template is a textarea with helper text describing `{{today}}` / `{{lookbackDays}}`. Tool allowlist is a multi-select sourced from `getToolsForRole("admin")` filtered to read-only tools. Destination is a select with conditional sub-fields per destination.
- `web/components/ScheduledTasks/ScheduledTaskDetail.tsx` — read-only detail view + paginated run history + "Run now" button.
- `web/components/ScheduledTasks/index.ts` — barrel.
- `web/components/index.ts` — re-export the barrel.
- All hover/focus/dark-mode styling per the project conventions in CLAUDE.md.

### 12. CLI

- Edit `cli/src/index.js`. After the existing `process.argv[2] === "prompt"` handler, add `process.argv[2] === "schedule"` dispatch. Sub-commands: `list`, `show <id>`, `create` (interactive prompts for cron/timezone/prompt/tools/routing), `enable <id>`, `disable <id>`, `delete <id>`, `run <id>`.
- Each sub-command calls the corresponding method in `cli/src/server-client.js`, which is extended with: `listSchedules()`, `getSchedule(id)`, `createSchedule(payload)`, `patchSchedule(id, payload, etag)`, `deleteSchedule(id)`, `runScheduleNow(id)`. Reuse existing fetch + auth-header plumbing.
- Output uses the existing `format-terminal.js` for table rendering.

### 13. Audit logging

- In every store + route + runner write site, emit a structured `logger.info` (or `logger.warn` on failure) with a stable `eventType` field: `scheduled_task.created`, `.updated`, `.deleted`, `.enabled`, `.disabled`, `.run_started`, `.run_completed`, `.circuit_breaker_tripped`, `.run_failed`, `.poll_cycle`. Include `taskId`, `runId`, `createdBy`, `result`, `durationMs` where applicable. Existing `logger.ts` already fans out to the right sink.

### 14. Tests

Create the following Node test files. All use `node:test` and `node:assert/strict`. Replicate the small in-process helpers needed (per the project pattern from `defender-xdr-indicators.test.js` and `defender-xdr-advanced-hunting.test.js`):

- `test/cron-helpers.test.js`
  - Cron validation: `* * * * *` rejected against a 2-minute poll interval.
  - DST spring-forward: a cron at "2:30am America/New_York" on the missing-hour day produces the next valid time without throwing.
  - Next-N preview returns N items in chronological order.
- `test/scheduled-task-store.test.js`
  - Etag-claim race: two concurrent claimers against an in-memory fake; exactly one wins, the loser sees a 412 → throws `ScheduledTaskClaimConflict`.
  - Run-history cap-50: writing entry #51 drops the oldest.
- `test/scheduled-task-runner.test.js`
  - Variable substitution: `{{today}}`, `{{lookbackDays}}`, custom vars; unknown placeholder → failure with reason `unknown_template_variable`.
  - Allowed-tool intersection: a task with `allowedTools: ["run_sentinel_kql", "reset_user_password"]` strips `reset_user_password` (destructive) and runs with just `run_sentinel_kql`.
  - Timeout: a mock agent loop that exceeds the configured `maxDurationSeconds` returns `"timeout"`.
  - Dry-run: routing is skipped; `routedTo === "dry-run-log"`.
  - Circuit breaker: after 3 consecutive failures, task `enabled` flips to `false` and a Teams notification is emitted (assert via mock `postToChannel`).
- `test/scheduled-task-routing.test.js`
  - Teams primary OK → `success: true, routedTo: "teams-channel"`.
  - Teams returns 429 → falls back to `cosmos-log`; `success: true`.
  - Both fail → `success: false`.
- `test/scheduled-tasks-api.test.js`
  - GET / POST / PATCH / DELETE happy paths.
  - Non-admin role receives 403 on every endpoint.
  - PATCH without `expectedEtag` is rejected.
  - Internal `/poll` endpoint: missing bearer → 401; bad audience → 401; valid token + wrong `oid` → 403.

### 15. Typecheck / lint / test

- From `web/`: `npm run typecheck` and `npm run lint`.
- From repo root: `node --test "test/*.test.js"`.
- All existing tests must still pass. The 3 pre-existing failures from `main` (Wiz registry, chalk missing in cli, abnormal `.ts` import) are unrelated.

### 16. Deferred — Phase 2 follow-ups (not in this plan's scope)

- Natural-language task creation via a new agent skill `/schedule-create` parsed by the existing skill framework. Adds a tool-call confirmation gate that displays the parsed cron/timezone/destination/tools and asks the user to confirm before writing.
- Email routing via Graph `/users/{id}/sendMail`.
- Dashboard tiles (sparkline, average duration) on the Scheduled Tasks list page.
- App Insights workbook for per-task duration / failure histograms.
- GitHub Actions workflow to build + deploy the Function App on tag (`functions-v0.1.0`).

---

## Verification

1. `cd web && npm run typecheck` — clean.
2. `cd web && npm run lint` — clean.
3. From repo root: `node --test "test/*.test.js"` — all new tests pass; pre-existing failures unchanged.
4. Cosmos provisioning re-run on a dev account: `pwsh scripts/provision-cosmos-db.ps1 -AccountName ... -WebAppName ...` succeeds and creates the new `scheduledTasks` container idempotently. Re-running is a no-op.
5. Boot the web app (`cd web && npm run dev`): `assertCosmosContainers` does not flag a missing container.
6. Manual mock-mode smoke test:
   - Create a task via the UI with cron `* * * * *` — verify the form rejects it.
   - Create a task with cron `*/3 * * * *` and a simple prompt — verify it lands in Cosmos, starts disabled.
   - Enable the task — verify `nextRunTime` is set and ≤ 3 min in the future.
   - Wait for the next poll cycle (or invoke `POST /api/internal/scheduled-tasks/poll` directly with the dev-bypass header) — verify the task runs, output is routed to the configured destination, and the next `nextRunTime` is updated.
   - Set `dryRun: true` — verify `routedTo: "dry-run-log"` and no actual post.
   - Patch the task with a syntactically-broken prompt → trigger 3 runs → verify the task auto-disables and the admin channel gets a notification.
7. CLI smoke: `neo schedule list`, `neo schedule show <id>`, `neo schedule disable <id>`, `neo schedule run <id>` against the dev server.
8. Manual concurrency check: hit `POST /api/internal/scheduled-tasks/poll` twice in quick succession with two different curl invocations — verify the second one sees zero claimed (everything was already running or claimed).
9. Function locally: `cd functions && func start` — verify it ticks every 2 min and successfully calls the Web app endpoint when the Web app is also running.
10. Audit log sink (existing — wherever `logger.ts` writes): verify `scheduled_task.*` event types appear.
