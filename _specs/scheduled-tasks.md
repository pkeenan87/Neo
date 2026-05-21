# Spec for scheduled-tasks

branch: claude/feature/scheduled-tasks
figma_component (if used): n/a

## Summary

Add a scheduled-task system that lets Neo wake up on its own and run jobs against the existing Claude pipeline on a cadence (cron). Today Neo is purely reactive — a human sends a message and Neo responds. Scheduled tasks flip that model: Neo runs proactive workflows like threat hunts across Sentinel/Defender telemetry, anomaly baselining, stale-account/stale-indicator sweeps, privileged-access drift checks, DLP posture digests, and compliance reporting — and delivers the result to a configured destination (Teams channel, Cosmos log, email).

Scope is **proactive cadence-driven workflows only**. Reactive, alert-driven investigation (Sentinel / Defender XDR / Entra ID Protection / Purview alerts) belongs to the separate Alert Triage API and is not in scope here.

Execution is a single Azure Function (Timer Trigger, poller pattern) that scans Cosmos every ~2 minutes for due tasks, claims each one via etag-conditional write, runs the existing Neo agent loop with the task's prompt template, and routes the output. Tasks are managed from both the web UI (new "Scheduled Tasks" page under `/settings`) and the CLI (`neo schedule …`), and can be created either via a form or via natural language ("Every Monday at 8am, run the lateral movement hunt and post findings to the SOC channel").

## Functional requirements

### Data model
- New Cosmos DB container `scheduledTasks` (separate from `conversations`) with one document per task. Partition key: `/createdBy` (or `/id` if cross-tenant queries dominate — TBD during planning).
- Document shape covers: `id`, `name`, `description`, `createdBy`, `enabled`, `dryRun`, `schedule { cronExpression, timezone }`, `task { promptTemplate, variables, allowedTools, maxDurationSeconds, skillSlug? }`, `routing { destination, teamsChannelId?, emailTo?, fallbackDestination }`, `auth { executionIdentity, scopedPermissions, keyVaultSecretRefs? }`, `state { status, nextRunTime, lastRunTime, lastRunResult, lastRunDurationMs, consecutiveFailures }`, `runHistory[]` (capped — see edge cases), `_etag`.
- Cron expressions evaluated against the task's `schedule.timezone` (IANA names). `nextRunTime` is always stored in UTC.

### Execution engine
- A single Azure Function with a Timer Trigger (every 2 minutes, configurable in `host.json` or via env). Function code is static — task schedules live in Cosmos, not in `function.json`.
- Each invocation:
  1. Query Cosmos for tasks where `enabled === true` AND `nextRunTime <= now()` AND `state.status !== "running"`.
  2. For each due task, attempt to claim via an etag-conditional PATCH that flips `state.status` to `"running"` and records `lastRunTime`. On etag conflict, skip — another instance got there first.
  3. Build the prompt from `task.promptTemplate` with variable substitution (`{{today}}`, `{{lookbackDays}}`, anything in `task.variables`).
  4. Run the existing Neo agent loop with `task.allowedTools` as the tool allowlist and `task.maxDurationSeconds` as the cap.
  5. Route the output per `routing.destination`. On routing failure, fall back to `routing.fallbackDestination` (default: `cosmos-log`).
  6. Write the run result: a new `runHistory[]` entry, updated `state.{lastRunResult, lastRunDurationMs, consecutiveFailures, nextRunTime, status}`. Use `cron-parser` to compute `nextRunTime`.
- Task timeout: if a task exceeds `task.maxDurationSeconds`, the agent loop is aborted and the result is recorded as `"timeout"`.
- Catch-up: if the Function App was down, the next poll picks up all tasks where `nextRunTime <= now`. They run sequentially within the poll cycle; if more are due than fit in one cycle, remaining ones get picked up next cycle (still claimed by `nextRunTime` order).

### Web UI
- New `/settings/scheduled-tasks` route. Admin-only (role check via existing `permissions.ts`).
- List view: name, schedule (human-readable), last run status, next scheduled run, failure count, enabled toggle. Sortable columns.
- Detail view: full configuration, run history (paginated), per-run output expandable.
- Create / edit form: name, description, cron expression (with a "preview next 5 runs" helper), timezone, prompt template (textarea with `{{variable}}` syntax), variable map (key/value pairs), allowed tools (multi-select from current tool registry), max duration, routing config, dry-run flag.
- Single-action buttons: enable / disable, delete (with confirmation), "Run now" (out of band trigger that bypasses the cron but still goes through the same execution path).
- Navigation entry: new sidebar item under `/settings`.

### CLI
- `neo schedule list` — table of tasks for the calling user (or all if admin).
- `neo schedule create` — interactive or flag-driven creation; same fields as the web form.
- `neo schedule show <id>` — full task detail + last N run results.
- `neo schedule enable <id>` / `disable <id>` — flip `enabled`.
- `neo schedule delete <id>` — hard delete (with confirmation).
- `neo schedule run <id>` — trigger an immediate out-of-band run (same as the UI "Run now" button).
- All commands go through the web server API; CLI does not talk to Cosmos directly.

### Natural-language task creation
- When a user types something like *"Every Monday at 8am, run the lateral movement hunt across Defender and Sentinel for the last 7 days and post findings to the SOC channel"* in chat, Neo parses it into a structured draft, confirms cron/timezone/destination/tools/dry-run with the user, and writes to Cosmos on confirmation. The confirmation gate reuses the existing destructive-action confirmation pattern.

### Auth & identity
- Azure-native integrations (Sentinel, Defender, Graph) authenticate via the existing Managed Identity / app registration that the agent uses today.
- Third-party tools (Tenable, Abnormal, ThreatLocker, etc.) use scoped credentials referenced from Key Vault `kv-neovault-prod-001` (or whichever vault is wired via the existing `secrets.ts` path).
- `task.auth.scopedPermissions` is the source of truth for least-privilege enforcement: the agent loop runs with a tool allowlist that's the intersection of `task.allowedTools` and the user's role-allowed tools at task-creation time.

### Guardrails
- Approval gate: creating or editing a task requires the `admin` role. Newly created tasks start with `enabled: false`. Enabling is a deliberate second step.
- Dry-run mode: `task.dryRun === true` runs the full pipeline but the routing layer logs the message it *would* have sent instead of actually sending it. Useful for validating prompt templates and tool selection.
- Output validation: optional `task.outputRules { maxLength?, requiredSections?[] }` that the routing layer enforces before posting. Validation failures route to `fallbackDestination` and increment `consecutiveFailures`.
- Failure circuit breaker: when `state.consecutiveFailures >= task.circuitBreakerThreshold` (default 3, configurable per task), the task auto-disables (`enabled: false`) and an alert is posted to the configured Neo admin channel.

### Observability
- Every run produces a new `runHistory[]` entry. History is capped at the most recent 50 entries per task (older entries roll off — old run records are preserved separately in the existing audit log).
- Application Insights telemetry: per-run duration, success/failure/timeout count, queue depth (number of due tasks per poll cycle), Function execution time.
- Teams admin channel notification on circuit-breaker trip.
- Web UI dashboard tile per task: last-run status pill, next-run countdown, 30-day success rate sparkline, average duration.

### Audit logging
- Every task lifecycle event (create / enable / disable / edit / delete / run-start / run-complete / circuit-breaker-trip) emits a structured log entry through the existing `logger.ts` pipeline so it flows to whatever sink the rest of Neo's audit log uses (Event Hub, etc.).

## Figma Design Reference (only if referenced)

n/a — UI uses the existing settings-page layout and design tokens (`web/components/SettingsPage/*`, `tailwind.config.ts`). Implementer should pattern-match against the existing `UsageSection` / `ProfileSection` components.

## Possible Edge Cases

- **Double-fire under concurrent Function instances** — already addressed by etag-conditional `status: "running"` claim. Need an integration test that simulates two concurrent claimers and asserts exactly one wins.
- **Function App down for hours** — on restart, the catch-up poll may find dozens of overdue tasks. They run sequentially in the same poll cycle until the cycle hits a soft cap (e.g. 10 tasks/cycle); remaining ones wait for the next cycle. Don't let a backlog explode tool quotas (Defender 45/min, etc.).
- **Cron expressions that fire faster than the 2-minute poll interval** — reject at creation time. A task with `* * * * *` (every minute) is incompatible with a 2-minute poller. Validate `cron-parser` output: next two fires must be ≥ poll interval apart, or reject.
- **Timezone with DST transitions** — `cron-parser` with timezone support handles this, but verify the "skipped hour" case (spring forward) and "doubled hour" case (fall back). Test with `America/New_York` around DST boundaries.
- **Tasks that block forever** — `task.maxDurationSeconds` enforced via `AbortSignal.timeout` around the agent loop. On timeout, the in-flight tool call is aborted (where supported) and `lastRunResult: "timeout"` is recorded.
- **Tool quota exhaustion during a scheduled run** — agent loop sees a 429 from Defender / Sentinel / etc. The task should record `"failure"` with the quota error in the run-history entry, and not consider it a circuit-breaker-eligible failure unless quota errors keep happening.
- **Stale `runHistory[]` bloat** — cap at 50 entries (oldest dropped). Older history is in the audit log.
- **Cosmos throttling under a large fleet of tasks** — poller batches queries with a reasonable page size and respects 429s.
- **Tasks created by an admin who later loses the admin role** — they keep running until explicitly disabled by a current admin. Document this.
- **Tasks referencing a tool that's later removed from the registry** — execution surfaces "tool not available" as a failure result and increments `consecutiveFailures`. The task is not auto-disabled solely on this, but it'll trip the circuit breaker if persistent.
- **Cron `0 0 1 1 *` (once a year)** — `nextRunTime` may be very far in the future; the poll query just skips it. Verify Cosmos query plan handles this efficiently with an index on `nextRunTime`.
- **A task whose `promptTemplate` reaches the model's context window** — caught by existing context-manager truncation; record `"failure"` with the context-overflow reason if the pre-prompt is itself too large.
- **Dry-run task that posts no output** — should still record a `"success"` run with `routedTo: "dry-run-log"` so observability tiles aren't blank.
- **Natural-language task creation that produces an ambiguous cron** — Neo must ask before writing. No silent guessing on schedule details.
- **Variables with template-injection content** (e.g. user supplies `{{lookbackDays}}` = `7 | rm -rf /`) — the template engine substitutes verbatim into a prompt string; KQL/SQL is not built from it directly, so injection risk is bounded to the prompt. Still: document that `variables` values are treated as untrusted text and sanitize anything that flows into tool arguments downstream.
- **Out-of-band "Run now" while a scheduled run is already in flight** — should be rejected (or queued) rather than producing two concurrent runs for the same task. Reuse the same etag-claim logic.
- **Multi-region / multi-instance deployment** — if more than one Function App instance is ever running (e.g. region failover), the etag-claim is the only safety net. Add a `claimedBy: <instance-id>` field to the running state for diagnostics.

## Acceptance Criteria

- Cosmos `scheduledTasks` container is provisioned (idempotent at startup, mirroring the existing `conversations` container pattern).
- A single Azure Function with a Timer Trigger polls Cosmos every 2 minutes, claims due tasks via etag conditional writes, runs the agent loop, and routes output.
- Concurrent claimers cannot double-fire a task (asserted by an integration test).
- The agent loop honours `task.allowedTools` and `task.maxDurationSeconds`.
- Routing supports `teams-channel`, `cosmos-log`, and `email` destinations, with `fallbackDestination` triggered on primary failure.
- Web UI `/settings/scheduled-tasks` supports list, create, edit, enable/disable, delete, "Run now", and shows run history. Admin-only.
- CLI `neo schedule {create,list,show,enable,disable,delete,run}` works against the same API the UI uses.
- Natural-language creation lands a draft, confirms with the user, and writes on confirmation. Ambiguity must trigger a question, not a guess.
- Dry-run mode logs intended output instead of sending it.
- Circuit breaker trips after `circuitBreakerThreshold` consecutive failures and posts to the admin Teams channel.
- Every lifecycle and run event lands in the existing audit-log pipeline.
- App Insights surfaces per-task duration, success/failure/timeout counts, and queue depth.
- All CI checks pass (typecheck, lint, tests, CodeQL, secret scan).

## Open Questions

- Should the poll interval be tunable per environment, or hardcoded at 2 minutes for now? (Lean: env-var with 2-minute default.) env var with 2 minute default.
- Should "Run now" use the same Function (queue it for the next poll) or invoke the agent loop directly in-process from the web API? In-process is faster for the user but spreads execution across two surfaces. (Lean: in-process for "Run now", Function-only for cadence runs.) agreed.
- Where do the destination secrets live for `teams-channel` and `email`? Are these per-task in Cosmos (referencing Key Vault), or environment-wide? (Lean: per-task references to Key Vault secrets so different tasks can post to different channels.) environment wide for now
- Do we surface a "preview the rendered prompt" step in the UI before saving, or only via dry-run? (Lean: both — a static preview in the form, plus the dry-run for end-to-end validation.) both
- Should `runHistory[]` cap at 50 or be configurable per task? (Lean: hardcoded 50 in Phase 1, configurable later if needed.) hardocded at 50
- Phase 1 deliverable per the brief is "single hardcoded task" — is that literal (one document seeded by code) or do we want generic-but-empty UI plus a seeded sample task? (Lean: seeded sample.) sample
- Does the natural-language creator reuse the existing `triage-dispatch` pattern, or land as a new agent skill (`/schedule-create`)? (Lean: new skill so the parsing logic is testable and discoverable.) new skill
- Are scheduled tasks visible to the user who created them only, or to all admins? (Lean: all admins can see/manage all tasks; `createdBy` is informational only.) all admins
- Should we cap the global number of active tasks per tenant, to avoid runaway proliferation? (Lean: yes, soft-cap with a warning at e.g. 100, hard-cap configurable.) agreed

## Testing Guidelines

Create test files in the `./test` folder for the new feature, and create meaningful tests for the following cases, without going too heavy:

- **Etag claim race**: simulate two concurrent claimers against an in-memory Cosmos mock and assert exactly one wins; the loser sees an etag conflict and skips.
- **Cron evaluation**: given a cron + timezone + a "now" value, assert `nextRunTime` is computed correctly across DST boundaries (use `America/New_York` spring-forward and fall-back).
- **Cron interval rejection**: a `* * * * *` cron is rejected at task creation.
- **Variable substitution**: `{{today}}`, `{{lookbackDays}}`, and arbitrary keys from `task.variables` are substituted into `promptTemplate`. Unknown placeholders surface as a validation error, not as the literal `{{foo}}` in the prompt.
- **Allowed-tool enforcement**: a task with `allowedTools: ["sentinel-kql"]` cannot invoke `reset_user_password` even if the prompt asks for it — agent loop refuses.
- **Timeout**: a task whose agent loop exceeds `maxDurationSeconds` is aborted and recorded as `"timeout"`.
- **Routing fallback**: a Teams post that 4xx's falls back to `cosmos-log` and the run is still marked `"success"` from the agent's perspective.
- **Circuit breaker**: after 3 consecutive failures, the task flips `enabled: false` and emits an admin Teams notification.
- **Dry-run**: a `dryRun: true` task does not post to Teams but records a run with `routedTo: "dry-run-log"`.
- **Run history cap**: writing a 51st run-history entry drops the oldest.
- **Web API authz**: non-admin role gets 403 on every `/api/scheduled-tasks/*` endpoint.
- **CLI smoke**: `neo schedule list` against a mocked API returns the table; `neo schedule disable <id>` flips the flag.
- **Natural-language parse**: a known-good sentence parses into the right cron + timezone + tools; an ambiguous sentence triggers a clarifying question instead of writing to Cosmos.
- **"Run now" with concurrent scheduled run**: out-of-band trigger is rejected (or queued) — must not produce two concurrent runs.
