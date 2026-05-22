# Scheduled Tasks Setup Guide

End-to-end guide for deploying and operating Neo's scheduled-task system —
the proactive half of Neo's SOC workflow. Tasks run autonomously on a cron
cadence against Neo's existing agent loop and deliver their findings to a
Teams channel, the Cosmos run log, or (Phase 2) email.

For the broader Neo deployment, see [`deployment.md`](./deployment.md). This
doc focuses on the additional Cosmos container, Graph permission, Azure
Function, and configuration required to turn scheduled tasks on.

## Table of Contents

- [What this gets you](#what-this-gets-you)
- [Architecture](#architecture)
- [Prerequisites](#prerequisites)
- [Step 1 — Provision the `scheduledTasks` Cosmos container](#step-1--provision-the-scheduledtasks-cosmos-container)
- [Step 2 — Grant the `ChannelMessage.Send` Graph permission](#step-2--grant-the-channelmessagesend-graph-permission)
- [Step 3 — Create the Function App with Managed Identity](#step-3--create-the-function-app-with-managed-identity)
- [Step 4 — Capture the Function App MI object ID](#step-4--capture-the-function-app-mi-object-id)
- [Step 5 — Configure the Web App](#step-5--configure-the-web-app)
- [Step 6 — Configure the Function App](#step-6--configure-the-function-app)
- [Step 7 — Build and deploy the Function](#step-7--build-and-deploy-the-function)
- [Step 8 — Smoke test in dry-run mode](#step-8--smoke-test-in-dry-run-mode)
- [Creating a scheduled task](#creating-a-scheduled-task)
- [Operating the system](#operating-the-system)
- [Local development](#local-development)
- [Troubleshooting](#troubleshooting)

---

## What this gets you

Today Neo is reactive — a human (or Logic App via the Alert Triage API) has
to send a message before Neo does anything. Scheduled tasks invert that:
Neo wakes up on its own and runs proactive workflows. Common shapes:

- **Recurring threat hunts** — e.g. weekly lateral-movement hunts across
  Sentinel + Defender XDR telemetry, posted to a SOC Teams channel.
- **Posture digests** — daily/weekly summaries of vulnerable endpoints,
  stale identities, or DLP exposures.
- **Compliance reporting** — monthly attestations of antivirus
  baseline compliance, privileged-access drift, etc.

A task definition is a Cosmos document that names a cron expression, a
prompt template (with `{{variable}}` substitution), an allowed-tool list,
and a routing destination. Admins manage tasks via the web settings page
or the `neo schedule` CLI verb. A separate Azure Function wakes up every
2 minutes and asks the Web App to run any tasks whose `nextRunTime` has
arrived — the Web App does the actual work through the same agent loop
that powers the interactive chat.

## Architecture

```
┌────────────────────────┐
│ scheduledTaskPoller    │  Timer trigger, every 2 minutes.
│ (Azure Function)       │  Authenticates to the Web App with its
└──────────┬─────────────┘  system-assigned Managed Identity token.
           │
           │ POST /api/internal/scheduled-tasks/poll
           │ Authorization: Bearer <MI-token>
           ▼
┌────────────────────────┐
│ Neo Web App            │  Verifies the MI token (aud/iss/tid/oid),
│ /api/internal/...      │  queries Cosmos for due tasks, claims each
└──────────┬─────────────┘  via etag-conditional IfMatch, runs the
           │                agent loop, routes the output.
           ▼
┌────────────────────────┐          ┌──────────────────────────┐
│ Cosmos `scheduledTasks`│          │ runAgentLoop (existing)  │
│ container              │◄─────────│ + per-task tool allowlist│
└────────────────────────┘          │ + per-task timeout       │
                                    └──────────┬───────────────┘
                                               │
                                               ▼
                                    ┌──────────────────────────┐
                                    │ Routing destination      │
                                    │ • teams-channel (Graph)  │
                                    │ • cosmos-log (run hist)  │
                                    │ • email (Phase 2)        │
                                    └──────────────────────────┘
```

**Why a poller, not one-Function-per-task:** Azure Functions Timer
Trigger cron expressions are baked into the Function at deploy time, not
at runtime. The poller pattern keeps the Function code static and lets
per-task schedules live entirely in Cosmos. Adding or removing tasks
requires no redeployment.

**Why the Function calls a Web App endpoint, not Cosmos directly:** The
agent loop, context manager, tool registry, and audit logging all live
in the Web App. Calling a privileged Web App endpoint keeps a single
source of truth; the Function is just "wake up and call home". The
endpoint authenticates the Function via its system-assigned Managed
Identity — no shared secret.

**Why etag-conditional claims:** During deployment overlap or any time
the Function App scales out, two pollers might briefly fire the same
tick. The first to write `state.status = "running"` wins via Cosmos
IfMatch; the second sees 412 and skips. The same path also blocks the
"Run now" button from racing a scheduled fire.

---

## Prerequisites

You should already have a working Neo Web App deployment per
[`deployment.md`](./deployment.md). Specifically:

- An App Service running Neo Web behind an Entra app registration.
- A Cosmos DB account with `neo-db` already provisioned (other Neo
  containers in place).
- The Entra app registration's system-assigned Managed Identity has
  Cosmos Data Contributor access.
- `pwsh` 7+, Azure CLI ≥ 2.50, Node.js 20-LTS, and **Azure Functions
  Core Tools v4** locally.

Skip ahead to [Local development](#local-development) if you want to
exercise the poller against a local web server first.

---

## Step 1 — Provision the `scheduledTasks` Cosmos container

The existing `scripts/provision-cosmos-db.ps1` script has been updated
to create the new container. Re-run it against the existing account —
it is idempotent.

```powershell
./scripts/provision-cosmos-db.ps1 `
    -AccountName "neo-cosmos-prod" `
    -WebAppName  "neo-web-prod"
```

What the script does for scheduled tasks:

- Creates the `scheduledTasks` container with `/id` partition key and
  autoscale throughput (1000 RU/s max). No TTL — task definitions are
  not auto-expired.
- Existing containers are left untouched (idempotent re-run).

Verify the container exists:

```bash
az cosmosdb sql container show \
  --account-name neo-cosmos-prod \
  --resource-group neo-rg \
  --database-name neo-db \
  --name scheduledTasks \
  --query 'name' -o tsv
# → scheduledTasks
```

On Web App boot, `web/lib/cosmos-startup-check.ts` will fail-fast with a
clear error if the container is missing.

---

## Step 2 — Grant the `ChannelMessage.Send` Graph permission

Tasks that route to a Teams channel post via Microsoft Graph
`POST /teams/{teamId}/channels/{channelId}/messages`. The existing Neo
app registration needs the `ChannelMessage.Send` **Application** permission
consented. Skip this step if every task you plan to create uses
`destination: cosmos-log` or `destination: tool` only — the `tool`
destination delegates Teams/email posting to the Information Security
Incident Response Logic App, which owns its own credentials.

Grant + consent via Azure CLI:

```bash
APP_ID=<your Neo app registration's appId>

# Add the permission (CdMnXFgWZJlEgdT — official permission GUID for
# ChannelMessage.Send on Graph)
az ad app permission add \
  --id "$APP_ID" \
  --api 00000003-0000-0000-c000-000000000000 \
  --api-permissions ebf0f66e-9fb1-49e4-a278-222f76911cf4=Role

# Grant admin consent
az ad app permission grant \
  --id "$APP_ID" \
  --api 00000003-0000-0000-c000-000000000000

az ad app permission admin-consent --id "$APP_ID"
```

Then in the Azure Portal: **Entra ID → App registrations → Neo app →
API permissions** — confirm `ChannelMessage.Send` is listed under
Microsoft Graph as **Application**, with a green "Granted for …" tick.

Other Graph permissions Neo needs (added in earlier steps): `User.ReadWrite.All`,
`Directory.ReadWrite.All`, `ThreatHunting.Read.All`. See
[the README permissions table](../README.md) for the full list.

---

## Step 3 — Create the Function App with Managed Identity

The poller is a tiny Node.js Function App that lives in
`functions/scheduledTaskPoller/`. It's deployed separately from the Web
App. There is no `provision-scheduled-task-poller.ps1` script yet — the
commands below provision it with `az` directly.

Pick names that match your environment (the values below assume the
existing `neo-rg` resource group and a storage account `neoclireleases`
created during the base deployment; reuse what you have):

```bash
RG=neo-rg
LOCATION=eastus
FUNCTION_APP=neo-scheduled-poller-prod
STORAGE_ACCT=neoclireleases       # reuse existing or create a new one
PLAN_SKU=Y1                        # Consumption — adequate for a 2-min tick

# Consumption plan (Y1) — pay-per-execution. Switch to FlexConsumption /
# Premium (EP1) if you need always-on or longer per-execution time.
az functionapp plan create \
  --resource-group "$RG" \
  --name "${FUNCTION_APP}-plan" \
  --location "$LOCATION" \
  --sku $PLAN_SKU \
  --is-linux true

# Function App itself
az functionapp create \
  --resource-group "$RG" \
  --plan "${FUNCTION_APP}-plan" \
  --name "$FUNCTION_APP" \
  --storage-account "$STORAGE_ACCT" \
  --runtime node \
  --runtime-version 20 \
  --functions-version 4 \
  --os-type Linux

# Enable system-assigned Managed Identity
az functionapp identity assign \
  --resource-group "$RG" \
  --name "$FUNCTION_APP" \
  --query principalId -o tsv
```

The last command prints the **principal ID (object ID)** of the
Function's MI. Save it — you'll need it in Step 4.

If you have a Premium/Dedicated plan you may want to enable
`functionTimeout` longer than the 5-minute Consumption default; the
poller itself returns in seconds but the Web App's downstream agent
loops can run up to `MAX_DURATION_SECONDS_CAP` (600 s) per task. See
[Troubleshooting](#troubleshooting) for the implications.

---

## Step 4 — Capture the Function App MI object ID

The Web App's internal-poll endpoint accepts requests only from the
Function App's specific Managed Identity. Capture the value:

```bash
POLLER_MI_OID=$(az functionapp identity show \
  --resource-group "$RG" \
  --name "$FUNCTION_APP" \
  --query principalId -o tsv)
echo "$POLLER_MI_OID"
```

The `principalId` is a GUID — it identifies this specific MI inside your
Entra tenant. You'll paste it into the Web App config in the next step.

---

## Step 5 — Configure the Web App

Add three new App Service settings to the Web App so it can verify
inbound poll requests:

```bash
WEB_APP=neo-web-prod
WEB_APP_ID_URI="api://<web-app-client-id>"   # same value you use for the
                                              # CLI's AUDIENCE — already
                                              # configured during base
                                              # deployment

az webapp config appsettings set \
  --resource-group "$RG" \
  --name "$WEB_APP" \
  --settings \
    SCHEDULED_TASK_POLLER_MI_OID="$POLLER_MI_OID" \
    SCHEDULED_TASK_POLLER_AUDIENCE="$WEB_APP_ID_URI"
```

| Setting | Required | Description |
|---|---|---|
| `SCHEDULED_TASK_POLLER_MI_OID` | yes | Object ID of the Function App's system-assigned Managed Identity. The internal poll endpoint rejects any token whose `oid` claim does not match this value. |
| `SCHEDULED_TASK_POLLER_AUDIENCE` | yes | The Web App's `app-id-URI` (e.g. `api://<web-app-client-id>`). The internal poll endpoint enforces this as the `aud` claim. |
| `AZURE_TENANT_ID` | already set | The endpoint verifies the token's `tid` claim against this. |

Restart the Web App so the new settings take effect:

```bash
az webapp restart --resource-group "$RG" --name "$WEB_APP"
```

If you skip these settings, the internal poll endpoint returns
`503 internal_auth_not_configured` for every poll attempt.

> **Do not set `SCHEDULED_TASK_POLLER_DEV_BYPASS=true` on a production
> Web App.** It disables MI verification entirely. The Web App's startup
> guard in `web/lib/config.ts` will refuse to boot if this env var is
> `true` outside `NODE_ENV=development`.

---

## Step 6 — Configure the Function App

The poller needs to know where the Web App lives and which audience to
mint MI tokens for:

```bash
WEB_URL=https://neo-web-prod.azurewebsites.net   # or your custom domain

az functionapp config appsettings set \
  --resource-group "$RG" \
  --name "$FUNCTION_APP" \
  --settings \
    NEO_WEB_URL="$WEB_URL" \
    NEO_WEB_AUDIENCE="$WEB_APP_ID_URI"
```

| Setting | Required | Description |
|---|---|---|
| `NEO_WEB_URL` | yes | Base URL of the Neo Web App. The poller POSTs to `${NEO_WEB_URL}/api/internal/scheduled-tasks/poll`. Trailing slashes are stripped automatically. |
| `NEO_WEB_AUDIENCE` | yes | Same value as `SCHEDULED_TASK_POLLER_AUDIENCE` on the Web App. The poller passes `${NEO_WEB_AUDIENCE}/.default` to `ManagedIdentityCredential` to mint a token bound to the Web App. |
| `FUNCTIONS_WORKER_RUNTIME` | already set by `az functionapp create` | Must be `node`. |
| `AzureWebJobsStorage` | already set | Required by the Functions runtime; not used by the poller code. |

Confirm the settings:

```bash
az functionapp config appsettings list \
  --resource-group "$RG" \
  --name "$FUNCTION_APP" \
  --query "[?name=='NEO_WEB_URL' || name=='NEO_WEB_AUDIENCE']" \
  --output table
```

---

## Step 7 — Build and deploy the Function

From the repo root:

```bash
cd functions/scheduledTaskPoller
npm install
npm run build               # tsc — writes ./dist/
func azure functionapp publish "$FUNCTION_APP"
```

`func` is the Azure Functions Core Tools CLI. Install it via
`npm i -g azure-functions-core-tools@4` if you haven't already.

After publish, confirm the timer is registered:

```bash
az functionapp function show \
  --resource-group "$RG" \
  --name "$FUNCTION_APP" \
  --function-name scheduledTaskPoller \
  --query "{name:name, isDisabled:isDisabled, config:config}" \
  --output yaml
```

You should see `isDisabled: false` and a binding entry for the timer
trigger with `schedule: 0 */2 * * * *`.

Watch the first few invocations in the live log stream:

```bash
az webapp log tail \
  --resource-group "$RG" \
  --name "$FUNCTION_APP"
```

Each tick logs either `Poll cycle ok (Nms): {"scanned":0,"claimed":0,…}`
or an error. With no enabled tasks yet, every cycle should be scanned=0.

---

## Step 8 — Smoke test in dry-run mode

Don't arm a real task as your first run. Create a dry-run task that
exercises the full pipeline without posting anything to Teams.

In the Web UI go to **Settings → Scheduled Tasks → New task** and paste:

```json
{
  "name": "Smoke test (dry-run)",
  "description": "First-time setup smoke test",
  "enabled": false,
  "dryRun": true,
  "schedule": { "cronExpression": "*/3 * * * *", "timezone": "UTC" },
  "task": {
    "promptTemplate": "Say hello and report the date.",
    "variables": {},
    "allowedTools": [],
    "maxDurationSeconds": 30
  },
  "routing": { "destination": "cosmos-log" },
  "circuitBreakerThreshold": 3
}
```

Then:

1. Click **Enable** on the new task.
2. Wait up to 2 minutes for the next poll tick.
3. Refresh — the task should show `last result: success` and a populated
   run history with `routedTo: dry-run-log`.

If you'd rather not wait, hit **Run now** in the UI or via CLI:

```bash
neo schedule run <task-id>
neo schedule show <task-id> | jq '.runHistory[-1]'
```

Once the smoke test passes, delete the task and create the real one.

---

## Creating a scheduled task

### Via the web UI

**Settings → Scheduled Tasks → New task**. The current Phase 1 UI accepts
a raw JSON definition (a form-based editor lands in Phase 2). The
template the modal pre-fills with is a sane starting point — adjust:

- **`schedule.cronExpression`** — 5-field crontab (`min hour day month dow`).
  See [crontab.guru](https://crontab.guru) for a builder. Cron fires
  closer together than the poll interval (default 2 min) are rejected
  at validation.
- **`schedule.timezone`** — IANA name (e.g. `America/New_York`,
  `Europe/London`, `UTC`). DST transitions are handled by `cron-parser`.
- **`task.promptTemplate`** — free-form text. `{{today}}` substitutes
  the run date (`YYYY-MM-DD`). Any other `{{key}}` must appear in
  `task.variables`, or the run fails with
  `reason: unknown_template_variable`.
- **`task.allowedTools`** — explicit allowlist (intersection rules below
  apply). Read-only tool names only — destructive tools are stripped
  even if listed.
- **`task.maxDurationSeconds`** — per-run timeout. Capped at 600 s.
- **`routing.destination`** — `teams-channel` | `cosmos-log` | `email`
  | `tool`. `email` is Phase 2; `tool` delegates notification dispatch
  to a named Neo tool (see [Routing destinations](#routing-destinations)
  below).
- **`routing.toolName`** — required when `destination === "tool"`. Must
  be a member of `ROUTING_ALLOWED_TOOLS` (currently `send_teams_message`,
  `send_email`). The routing layer auto-populates the tool's args from
  task context — no per-task arguments to configure here.
- **`routing.fallbackDestination`** — destination used on primary
  failure. Defaults to `cosmos-log`. May NOT be `tool` (recursion
  guard) — use `cosmos-log` as the safe fallback.
- **`dryRun`** — when `true`, the run executes the full pipeline but
  routes to a synthetic `dry-run-log` instead of posting. Recommended
  default until the prompt is validated.

New tasks start with `enabled: false`. Flip **Enable** when ready.

### Via the CLI

```bash
# List all tasks
neo schedule list

# Show one task in detail (includes recent runs)
neo schedule show <task-id>

# Trigger an out-of-band run
neo schedule run <task-id>

# Enable / disable / delete
neo schedule enable <task-id>
neo schedule disable <task-id>
neo schedule delete <task-id>

# Recent run history (newest first)
neo schedule runs <task-id>

# Create from a JSON file
neo schedule create --file my-task.json
```

The CLI talks to the same Web API the UI uses; you'll need an admin
session (`neo auth login` with an account that has the Neo Admin role)
or an admin-scoped API key.

### Tool allowlist semantics

`task.allowedTools` is enforced at two layers:

1. The **tools list announced to Claude** is filtered down to the
   intersection of `task.allowedTools` ∩ the global tool registry ∩
   (the global tool registry minus `DESTRUCTIVE_TOOLS`). So a scheduled
   task can never call `reset_user_password`, `isolate_machine`, etc.,
   even if the creator was admin.
2. The **tool dispatch site** (in `web/lib/agent.ts`) re-checks the
   allowlist on each `tool_use` block Claude returns. If Claude
   hallucinates or is influenced into emitting a tool name outside the
   allowlist, the call is rejected with an `is_error` tool result and
   the agent loop continues.

The combined effect: scheduled tasks have a hard, per-task scope that
no in-context drift can break. Add explicit tools — there's no implicit
"admin gets everything".

### Routing destinations

| Destination | Behavior |
|---|---|
| `teams-channel` | Posts via Graph `POST /teams/{teamId}/channels/{channelId}/messages` with `contentType: "text"`. Requires `teamsTeamId` (GUID) and `teamsChannelId`. Channel IDs look like `19:abc@thread.tacv2`. |
| `cosmos-log` | No-op — the durable record is the `runHistory[]` entry on the task document. Useful when you only want the result to land in Neo's audit trail. |
| `email` | **Phase 2** — current implementation throws and routes to `fallbackDestination`. |
| `tool` | Dispatches via a named Neo tool. Requires `toolName` ∈ `ROUTING_ALLOWED_TOOLS` (currently `send_teams_message`, `send_email` — both backed by the Information Security Incident Response Logic App). The routing layer auto-populates the tool's args from task context (see field mapping below) — Teams channel / email recipient routing lives in the Logic App workflow, not on the task document. Use this destination to let the operator's team iterate on notification logic without redeploying Neo. |
| `dry-run-log` | Set automatically when `task.dryRun === true`. Logs the *would-have-sent* payload via `logger.info` and records `routedTo: "dry-run-log"`. |

If the primary destination fails (HTTP 4xx/5xx, network), routing falls
back to `fallbackDestination` (default `cosmos-log`). The run is still
recorded as success from the agent's perspective — the failure reason
appears in `runHistory[].reason`. `tool` is **not** valid as a
`fallbackDestination`.

#### Routing destination: `tool`

When `destination === "tool"`, the routing layer builds a fixed three-
field envelope from task context and dispatches it through the named
Neo tool's local executor. The Neo-side schema decouples from the
Logic App's wire contract:

| Routing-layer arg (Neo schema) | Source | Logic App wire field |
|---|---|---|
| `title` | `task.name` | `taskName` |
| `status` | `"success"` (hardcoded — routing only fires on agent-loop success today) | `status` |
| `body` | `summarize(agentOutput)` (capped at 2000 chars, matching `runHistory[].outputSummary`) | `summary` |

The Logic App workflow owns the actual Teams channel or email
recipient list — `toolArgs` is **not** a field on the task document by
design. The `tool_execution` audit event for the dispatch is wrapped
in a log-context envelope using the task's `createdBy` so the audit
trail records the responsible admin.

`routedTo` on the resulting `runHistory[]` entry is set to the tool
name (e.g. `send_teams_message`), not the generic `tool` string.

##### Adding a new notification workflow

Steps for the operator's Logic App team plus the Neo developer:

1. Define a new Logic App workflow exposing an MCP tool with a stable
   kebab-case name (e.g. `send-slack-message`). The current contract
   is `{ taskName: string, status: string, summary: string }`; document
   any divergence in `_specs/infosec-incident-response-mcp.md`.
2. In Neo, add the tool schema to `web/lib/tools.ts` (Neo-side names
   `title`/`status`/`body`) and an executor in `web/lib/executors.ts`
   that maps Neo schema → Logic App wire fields.
3. Add the Neo tool name to `ROUTING_ALLOWED_TOOLS` in
   `web/lib/scheduled-task-validators.ts`.
4. Add the tool name to the integration's `capabilities` in
   `web/lib/integration-registry.ts` and to `ADMIN_ONLY_TOOLS` in
   `web/lib/permissions.ts` (notifications stay admin-only).
5. Ship.

---

## Operating the system

### Run history

Each task document carries up to 50 run-history entries embedded as an
array. When the cap is hit the oldest entries are dropped (no audit-log
spill in Phase 1 — see the type-file comment for follow-up).

Each entry has:

- `runId` (UUID) — unique per execution.
- `startTime`, `endTime` (ISO).
- `result` — `success` | `failure` | `timeout`.
- `outputSummary` — first 2000 chars of the agent's output (truncated
  with a `…[truncated]` marker).
- `routedTo` — actual destination used (`teams-channel`, `cosmos-log`,
  `dry-run-log`, `email`, or `none` for early-exit failures).
- `reason` — present when `result !== "success"`, contains the failure
  message and (for routing failures) `primary_failed:…` chaining.

### Circuit breaker

After `circuitBreakerThreshold` consecutive failures (default 3,
configurable per task, must be ≥ 1), the task auto-disables (`enabled =
false`) and `state.status` flips to `"failed"`. If the task routes to a
Teams channel, a notification is posted to that same channel naming the
last error. An admin must explicitly re-enable the task after fixing the
underlying cause.

Note: timeouts and routing-fallback failures both count toward the
breaker. If you keep hitting the breaker for benign reasons (e.g. a
known-slow tool), bump `maxDurationSeconds` or `circuitBreakerThreshold`
on the task.

### Stuck-running recovery

If the Web App is killed mid-run (process restart, OOM, etc.) or Cosmos
returns a transient error during the final persist, a task's
`state.status` may stay `"running"` even though no work is actually
happening. The poller has a watchdog: it also picks up tasks where
`status = "running"` AND `lastRunTime` is older than
`2 × MAX_DURATION_SECONDS_CAP` (20 min). The next poll tick re-claims
and re-runs them.

This means a stuck task self-heals within ~20 min without manual
intervention. The error-level log entry `scheduled_task.persist_failed`
is your signal that this happened.

### Logging and observability

Every lifecycle event lands in the structured logger:

| Event | Level | When |
|---|---|---|
| `scheduled_task.created` | info | POST /api/scheduled-tasks |
| `scheduled_task.updated` | info | PATCH /api/scheduled-tasks/{id} |
| `scheduled_task.deleted` | info | DELETE /api/scheduled-tasks/{id} |
| `scheduled_task.run_started` | info | runner begins agent loop |
| `scheduled_task.run_completed` | info | runner reaches finalize |
| `scheduled_task.run_triggered` | info | "Run now" out-of-band trigger |
| `scheduled_task.poll_cycle` | info | every poll tick (scanned/claimed/executed counts) |
| `scheduled_task.circuit_breaker_tripped` | warn | breaker fires |
| `scheduled_task.persist_failed` | **error** | recordRunResult exhausted retries — task is likely stuck and will self-heal in ~20 min |
| `scheduled_task.internal_auth_failed` | warn | bad MI token at /poll |
| `scheduled_task.internal_auth_dev_bypass` | **error** | dev bypass was honored (production should never see this) |

Wire these into Event Hub / Log Analytics / Application Insights via the
existing Neo logger pipeline (see `docs/configuration.md` →
[Structured Logging](./configuration.md#structured-logging)).

---

## Local development

For iterating on the runner / routing / Function locally:

1. Run the Web App in dev mode (`cd web && npm run dev`).
2. Set `SCHEDULED_TASK_POLLER_DEV_BYPASS=true` and `NODE_ENV=development`
   on the Web App env so the internal endpoint accepts unauthenticated
   POSTs. The startup guard refuses to boot if these are set with
   `NODE_ENV` other than `development`.
3. Either:
   - **Drive the poller manually** with curl every time you want to test:
     ```bash
     curl -X POST -d '{}' http://localhost:3000/api/internal/scheduled-tasks/poll
     ```
   - **Run the Function App locally**:
     ```bash
     cd functions/scheduledTaskPoller
     cp local.settings.json.example local.settings.json
     # edit NEO_WEB_URL = http://localhost:3000
     # edit NEO_WEB_AUDIENCE = api://<dev-app-client-id> (any value works
     # against a Web App with DEV bypass enabled)
     npm install
     npm start
     ```
     The Function fires every 2 minutes against your local Web App.

> The mock-mode path (`MOCK_MODE=true`) returns canned tool results —
> useful for testing the runner / routing layer without burning real
> tool quota. Combine it with `dryRun: true` on your task definitions
> to fully sandbox end-to-end test cycles.

---

## Troubleshooting

### Poll cycles never claim anything

Verify there is at least one task with `enabled = true` AND
`state.nextRunTime <= now()`. New tasks start disabled — they must be
explicitly enabled.

```bash
neo schedule list
# Look for enabled=yes; next-run-time should be near or in the past.
```

Also check Web App env: `SCHEDULED_TASK_POLLER_MI_OID` must equal the
Function App's MI principal ID. A mismatch produces
`scheduled_task.internal_auth_failed` (with `reason: wrong_principal`)
on every tick.

### Function gets 401 from `/api/internal/scheduled-tasks/poll`

In order of likelihood:

1. **Wrong audience.** The Function's `NEO_WEB_AUDIENCE` and the Web
   App's `SCHEDULED_TASK_POLLER_AUDIENCE` must be byte-identical.
2. **Wrong MI OID.** Recompute with `az functionapp identity show
   --query principalId -o tsv` and update the Web App setting.
3. **Tenant mismatch.** If you run the Function and Web App in different
   tenants the `tid` claim won't match. Move them under the same
   tenant or supply both tenants in `web/lib/scheduled-task-internal-auth.ts`
   (custom work).
4. **`AZURE_TENANT_ID` not set on the Web App.** Required for JWKS
   resolution.

### Tasks fire late (5+ min after schedule)

Either:
- The Function App was scaled to zero and is cold-starting. Switch from
  Consumption to a Premium plan if sub-2-minute latency matters.
- A previous tick is still running because the Web App's poll handler
  is processing 10 due tasks sequentially. See next item.

### Poll cycle takes longer than the Function timeout

DEFAULT_POLL_LIMIT is 10 tasks per cycle; `MAX_DURATION_SECONDS_CAP` is
600 s per task. Worst-case poll = 100 minutes — well past Consumption's
5-minute function timeout. The Web App finishes running the claimed
tasks, but the Function instance is terminated mid-fetch and logs an
opaque error.

Mitigations:

- Lower `MAX_DURATION_SECONDS_CAP` (requires a code change) if your
  workloads are short.
- Move to Premium / Dedicated plan and raise `functionTimeout` in
  `host.json`.
- Reduce `SCHEDULED_TASK_POLL_LIMIT` (env var on the Web App, default
  10) so each cycle handles fewer tasks.

The stuck-running watchdog ensures tasks stranded by a killed cycle
self-heal within ~20 minutes, so this is a UX/observability problem,
not a correctness one.

### Teams post fails 403 with "Required permission ChannelMessage.Send not granted"

Re-run Step 2. The app registration needs the **Application** variant
(not Delegated) consented by an administrator. Confirm with:

```bash
az ad app permission list-grants --id "$APP_ID" --show-resource-name \
  | jq '.[] | select(.resourceDisplayName == "Microsoft Graph")'
```

`ChannelMessage.Send` must appear in the `scope` field.

### Task auto-disables after 3 runs (circuit breaker trips)

Inspect the last few runs:

```bash
neo schedule runs <task-id>
```

Look at `reason`. Common causes:

- `unknown_template_variable: foo` — your `promptTemplate` references
  `{{foo}}` but `task.variables` doesn't include it.
- `no_allowed_tools` — `task.allowedTools` was empty, all-destructive,
  or all-misnamed.
- `Teams channel post failed (4xx)` — fix the Graph permission, team
  ID, channel ID, or whatever the body says.
- `aborted_or_timeout` — increase `maxDurationSeconds` or narrow the
  query.
- `system_prompt_unavailable` — transient Cosmos/Key Vault issue;
  usually self-resolves on the next attempt.

Fix the underlying cause, then re-enable the task (`neo schedule enable
<id>` or the UI toggle). The breaker counter resets on the next
successful run.

### Stuck-running task that didn't self-heal

The watchdog reclaims tasks where `state.status == "running"` AND
`lastRunTime < now - 1200s`. If your task has been "running" for over
~25 minutes and is still stuck:

- Confirm the poller is healthy: check Function App logs for the most
  recent `Poll cycle ok` message.
- Check `lastRunTime` on the task document:
  ```bash
  neo schedule show <task-id> | jq '.state'
  ```
  If `lastRunTime` is very recent, the watchdog correctly skips it
  (the task is genuinely running). Wait it out.
- If you must intervene: delete and recreate the task. There is
  intentionally no admin-API to write `state` directly — the watchdog
  is the supported recovery mechanism.

### `tool` destination falls back to `cosmos-log` every run

The `tool` destination invokes the named Neo tool's executor — for the
two notification tools, that's a JSON-RPC call to the Information
Security Incident Response Logic App. If the Logic App returns a 4xx
or 5xx, or the MCP handshake fails, the executor throws and the
routing layer falls back to whatever `fallbackDestination` is set
(default `cosmos-log`). To diagnose:

1. Confirm `INFOSEC_LOGIC_APP_MCP_URL` is set on the Web App and is
   in `INFOSEC_LOGIC_APP_URL_ALLOWLIST` (see `web/lib/mcp-client.ts`).
2. Confirm `AGENT_CLIENT_ID`, `AGENT_CLIENT_SECRET`, and
   `INFOSEC_LOGIC_APP_API_ID` are configured under **Settings →
   Integrations → Information Security Incident Response**.
3. Hit the integration probe at
   `/api/integrations/infosec-incident-response/test` — distinct
   errors for token-mint vs handshake.
4. Open the Logic App's run history in the Azure portal and find the
   workflow run named `send-teams-message` / `send-email` matching the
   `workflowRunId` from the Neo audit event.
5. If `routedTo` shows the tool name (e.g. `send_teams_message`) but
   `reason` says "is not in ROUTING_ALLOWED_TOOLS", the task document
   has a stale tool name — likely the allowlist shrank after the task
   was persisted. Update the task or extend the allowlist.

### `cron-parser` install fails

If `npm install` in `web/` complains about cache permissions, fix the
user-level cache before retrying:

```bash
sudo chown -R "$(id -u):$(id -g)" "$HOME/.npm" web/node_modules
cd web && npm install
```

This is a one-time fix for environments where a previous root-owned
install poisoned the cache.
