# Scheduled Tasks — User Guide

A guide for the SOC team on using Neo's scheduled tasks. Pair this
with the setup guide ([`scheduled-tasks.md`](./scheduled-tasks.md))
only if you're deploying the infrastructure — for day-to-day creation,
testing, and operation of tasks, this doc is what you need.

> **Who this is for:** admins creating proactive workflows in Neo.
> Scheduled tasks are admin-only by design. You'll need the **admin**
> role in Neo to see the Scheduled Tasks settings page.

## Table of Contents

- [What scheduled tasks do](#what-scheduled-tasks-do)
- [Anatomy of a task](#anatomy-of-a-task)
- [Creating a task](#creating-a-task)
- [Cron schedule cheatsheet](#cron-schedule-cheatsheet)
- [Routing destinations — picking the right one](#routing-destinations--picking-the-right-one)
- [Allowed tools — what to put in `allowedTools`](#allowed-tools--what-to-put-in-allowedtools)
- [Variables and templating](#variables-and-templating)
- [Testing safely with `dryRun`](#testing-safely-with-dryrun)
- [Reading the run history](#reading-the-run-history)
- [Circuit breaker — what it does and how to recover](#circuit-breaker--what-it-does-and-how-to-recover)
- [Recipes](#recipes)
- [Troubleshooting (user-facing)](#troubleshooting-user-facing)
- [Tool reference (commonly used)](#tool-reference-commonly-used)
- [Quick reference card](#quick-reference-card)

---

## What scheduled tasks do

Most of Neo is reactive — you (or a Logic App) ask it something, it
investigates. Scheduled tasks flip that around. Neo wakes up on its
own cadence and runs an investigation autonomously, then ships the
result somewhere useful.

Common shapes:

- **Recurring threat hunts.** "Every Monday at 8am, scan
  Sentinel + Defender for lateral-movement patterns from the last
  7 days and post a summary to our SOC Teams channel."
- **Posture digests.** "Daily at 9am, list vulnerable endpoints
  above CVSS 8.0 and email the report to the team."
- **Compliance checks.** "First of the month, confirm AV baseline
  compliance for all servers and log the result."

Tasks are admin-only — only admins can create, enable, disable, or
delete them. The poller runs them on a fixed cadence (every 2
minutes); each task fires when its cron schedule says it's due.

---

## Anatomy of a task

A task is a JSON document. Here's a complete annotated example:

```json
{
  "name": "Weekly lateral movement hunt",
  "description": "Cross-tenant lateral movement hunt over the last 7 days.",

  "enabled": false,
  "dryRun": true,

  "schedule": {
    "cronExpression": "0 8 * * 1",
    "timezone": "America/New_York"
  },

  "task": {
    "promptTemplate": "Hunt for lateral movement across Defender XDR and Sentinel for the last {{lookbackDays}} days. Today is {{today}}. Summarize suspicious patterns grouped by user and device. Lead with the most important finding.",
    "variables": { "lookbackDays": 7 },
    "allowedTools": ["run_sentinel_kql", "run_defender_hunting_query"],
    "maxDurationSeconds": 180
  },

  "routing": {
    "destination": "tool",
    "toolName": "send_teams_message",
    "fallbackDestination": "cosmos-log"
  },

  "circuitBreakerThreshold": 3
}
```

Field by field:

| Field | What it does |
|---|---|
| `name` | Display name in the Scheduled Tasks list. 1–200 chars, no control characters. |
| `description` | Short explanation for your future self / teammates. |
| `enabled` | `false` keeps the task in the list but doesn't run it. Flip to `true` when you're ready. New tasks default to `false`. |
| `dryRun` | `true` runs the full agent loop but skips the real notification — the run history shows `routedTo: dry-run-log` instead. Use this until your prompt is dialed in. |
| `schedule.cronExpression` | Standard 5-field cron (`min hour day month dow`). See [cheatsheet](#cron-schedule-cheatsheet) below. |
| `schedule.timezone` | IANA timezone (`America/New_York`, `Europe/London`, `UTC`). DST is handled. |
| `task.promptTemplate` | Free-form instructions for the agent. Supports `{{variable}}` substitution. |
| `task.variables` | Map of variables referenced by `{{name}}` placeholders in the template. `{{today}}` is auto-provided as `YYYY-MM-DD`. |
| `task.allowedTools` | Explicit list of tool names the agent may call during this run. **Must be non-empty.** Read-only tools only — destructive tools are stripped automatically. |
| `task.maxDurationSeconds` | Hard timeout per run. Max 600 (10 min). |
| `routing.destination` | Where to send the result. `tool` / `teams-channel` / `cosmos-log` / `email`. See [routing](#routing-destinations--picking-the-right-one). |
| `routing.toolName` | Required when `destination: "tool"`. Currently `send_teams_message` or `send_email`. |
| `routing.teamsTeamId` + `routing.teamsChannelId` | Required when `destination: "teams-channel"` (direct Graph posting). |
| `routing.fallbackDestination` | Where to route if the primary destination fails. Defaults to `cosmos-log`. Cannot be `tool`. |
| `circuitBreakerThreshold` | After this many consecutive failures, the task auto-disables. Default 3. Bump for known-flaky workloads. |

---

## Creating a task

### From the web UI

1. Sign in to Neo as an admin.
2. Go to **Settings → Scheduled Tasks → New task**.
3. The modal pre-fills with a template. Edit the JSON to match your needs.
4. Click **Save**. The task lands in the list with `enabled: false`.
5. Verify the row looks right, then click **Enable** when you want it to run.

### From the CLI

```powershell
# Create from a file
neo schedule create --file my-task.json

# List all tasks
neo schedule list

# Show one task with its recent runs
neo schedule show <task-id>

# Trigger an out-of-band run (doesn't wait for next schedule)
neo schedule run <task-id>

# Enable / disable / delete
neo schedule enable <task-id>
neo schedule disable <task-id>
neo schedule delete <task-id>

# Recent run history (newest first)
neo schedule runs <task-id>
```

You'll need to be signed into the CLI as an admin (`neo auth login`)
or use an admin-scoped API key.

---

## Cron schedule cheatsheet

5 fields, separated by spaces: `minute hour day-of-month month day-of-week`.

| Schedule | When |
|---|---|
| `*/15 * * * *` | Every 15 minutes |
| `0 * * * *` | Every hour, on the hour |
| `0 8 * * *` | Daily at 8:00 |
| `0 8 * * 1` | Mondays at 8:00 |
| `0 8 * * 1-5` | Weekdays at 8:00 |
| `0 8,17 * * *` | Daily at 8:00 and 17:00 |
| `0 9 1 * *` | First of the month at 9:00 |
| `30 9 1,15 * *` | 1st and 15th of the month at 9:30 |

For anything more complex, [crontab.guru](https://crontab.guru) is a
visual builder — paste your expression there to confirm it fires when
you expect.

> **Watch the poll interval.** The poller wakes up every 2 minutes,
> so cron expressions firing closer than that get rejected at
> validation. `*/1 * * * *` won't work — use `*/3 * * * *` or longer.

---

## Routing destinations — picking the right one

| Destination | Use it when… | Setup needed |
|---|---|---|
| `tool` (preferred) | You want to send a notification with rich formatting and the routing logic should live in the Logic App (so the SOC team can iterate on it without Neo redeploys). | Logic App workflows must be deployed; the Information Security Incident Response integration must be configured. |
| `teams-channel` | You want Neo to post directly into a specific Teams channel via Graph. | Neo's app registration needs `ChannelMessage.Send` Application permission. You also need the team GUID and channel ID. |
| `cosmos-log` | You only want the result in the audit trail — no Teams post, no email. Useful for compliance jobs whose value is the durable log. | None. |
| `email` | _Not yet implemented._ Will fall back to `fallbackDestination`. |

**Field shape per destination:**

```jsonc
// tool — current best default
"routing": {
  "destination": "tool",
  "toolName": "send_teams_message",        // or "send_email"
  "fallbackDestination": "cosmos-log"
}

// teams-channel — direct Graph posting
"routing": {
  "destination": "teams-channel",
  "teamsTeamId": "00000000-0000-0000-0000-000000000000",
  "teamsChannelId": "19:abc@thread.tacv2",
  "fallbackDestination": "cosmos-log"
}

// cosmos-log — audit trail only
"routing": {
  "destination": "cosmos-log"
}
```

For `destination: "tool"`, you don't pass a channel or recipient list
— the Logic App workflow owns that routing. To change where
notifications go, ask the team that owns the Logic App to update the
workflow.

---

## Allowed tools — what to put in `allowedTools`

This is an explicit allowlist. The agent can ONLY call tools listed
here during the run. Two rules to internalise:

1. **Must be non-empty.** A task with `"allowedTools": []` fails
   immediately with `no_allowed_tools`. If your prompt doesn't need
   any tool, include a benign read-only one like `searchKnowledgeBase`
   to satisfy the check.
2. **Destructive tools are stripped automatically.** Even if you
   accidentally list `reset_user_password` or `isolate_machine`,
   they're filtered out — scheduled tasks can never trigger
   destructive actions.

**Safe defaults for hunts and digests:**

| Tool | What it does |
|---|---|
| `run_sentinel_kql` | Run a KQL query against Microsoft Sentinel. |
| `run_defender_hunting_query` | Run a KQL query against Defender XDR. |
| `get_sentinel_incidents` | List Sentinel incidents with filters. |
| `get_xdr_alert` | Fetch a specific Defender XDR alert by ID. |
| `search_xdr_by_host` | Cross-table host search in Defender XDR. |
| `get_user_info` | Pull an Entra user record. |
| `list_ca_policies` | Enumerate Conditional Access policies. |
| `lookup_asset` | Asset lookup against the inventory. |
| `list_indicators` | List TI indicators currently deployed. |
| `searchKnowledgeBase` | Search Neo's knowledge base / runbooks. |

For the full tool reference, see the main [user guide](./user-guide.md#tool-reference).

**Don't bother listing:** any tool whose name starts with `block_`,
`reset_`, `isolate_`, `unisolate_`, `delete_`, `approve_`, `deny_`,
`remediate_`, or `action_` — they're destructive and stripped.

---

## Variables and templating

`promptTemplate` supports `{{name}}` placeholder substitution.

- **`{{today}}`** is auto-provided as the current date in `YYYY-MM-DD`.
  You don't need to include it in `variables`.
- **All other placeholders** must appear in `task.variables`. A
  missing variable fails the run with
  `unknown_template_variable: <name>`.

Example:

```json
"task": {
  "promptTemplate": "Pull all sign-ins from {{country}} for users in the {{department}} group between {{startDate}} and {{today}}.",
  "variables": {
    "country": "Russia",
    "department": "Finance",
    "startDate": "2026-05-01"
  },
  "allowedTools": ["run_sentinel_kql"],
  "maxDurationSeconds": 120
}
```

Variables can be strings, numbers, or booleans. Nested objects aren't
supported.

---

## Testing safely with `dryRun`

Always start with `dryRun: true` and `enabled: true`. Here's the
recommended dance:

1. Create the task with `dryRun: true, enabled: false`.
2. Flip to `enabled: true`.
3. Click **Run now** in the UI — don't wait for the cron schedule.
4. Watch the run history. It should show `routedTo: dry-run-log`
   and `result: success`.
5. Inspect the `outputSummary` field in the run history — is the
   agent saying what you want? If not, iterate on the prompt.
6. When happy, flip `dryRun` back to `false`. Run again. Confirm
   the real Teams message / email arrives.

In dry-run mode the agent loop runs end-to-end (including all tool
calls), but the routing step is replaced with a log entry — so no
Teams cards, no emails, no Logic App workflow invocation.

---

## Reading the run history

Each task keeps the **last 50 runs** embedded in the document. The
Scheduled Tasks UI shows these under "Recent runs". Per-row fields:

| Field | What it tells you |
|---|---|
| `result` | `success` / `failure` / `timeout` |
| `routedTo` | Where the output actually went. For `tool` destination, this is the tool name (e.g. `send_teams_message`). On a fallback, this is the fallback destination. |
| `outputSummary` | First 2000 chars of the agent's final text. Truncated with `…[truncated]` if longer. |
| `reason` | Present on non-success. Common values are listed in [Troubleshooting](#troubleshooting-user-facing). For routing failures, you'll see `primary_failed: <reason>` chaining. |
| `startTime` / `endTime` | When the run happened (UTC ISO). |

To inspect from the CLI:

```powershell
neo schedule runs <task-id> | jq '.[0:5]'   # last 5 runs
neo schedule show <task-id> | jq '.runHistory[-1]'   # most recent run
```

---

## Circuit breaker — what it does and how to recover

If a task fails `circuitBreakerThreshold` times in a row (default
**3**), Neo automatically disables it:

- `state.status` flips to `failed`.
- `enabled` is set to `false`.
- A notification is posted to the same destination (Teams or routing
  tool) explaining the auto-disable.
- The task does NOT poll until you re-enable it.

**Recovery:**

1. Open the task in **Settings → Scheduled Tasks**.
2. Look at the recent runs' `reason` field to understand the cause
   (see Troubleshooting below).
3. Fix the underlying issue — edit the prompt, fix a variable, bump
   `maxDurationSeconds`, etc.
4. Click **Enable** to re-arm. The consecutive-failure counter
   resets on the next successful run.

For known-flaky workloads (e.g. a slow Sentinel query that
occasionally hits a transient timeout), bump `circuitBreakerThreshold`
to 5 or 10. Just don't set it higher than your tolerance for noise —
the breaker is what protects you from a stuck workflow firing
notifications forever.

---

## Recipes

### Weekly threat hunt → Teams notification

```json
{
  "name": "Weekly lateral movement hunt",
  "description": "Cross-tenant lateral movement hunt across Defender XDR and Sentinel.",
  "enabled": true,
  "dryRun": false,
  "schedule": { "cronExpression": "0 8 * * 1", "timezone": "America/New_York" },
  "task": {
    "promptTemplate": "Hunt for lateral movement signals across Defender XDR and Sentinel for the last {{lookbackDays}} days (since {{today}} minus {{lookbackDays}}). Group findings by user and device. Lead with the highest-risk finding. If nothing notable was found, say so explicitly.",
    "variables": { "lookbackDays": 7 },
    "allowedTools": ["run_sentinel_kql", "run_defender_hunting_query"],
    "maxDurationSeconds": 240
  },
  "routing": {
    "destination": "tool",
    "toolName": "send_teams_message",
    "fallbackDestination": "cosmos-log"
  },
  "circuitBreakerThreshold": 5
}
```

### Daily vulnerable-endpoint digest → email

```json
{
  "name": "Daily vulnerable endpoint digest",
  "description": "Top 20 endpoints by CVSS over 8.0 with active vulnerabilities.",
  "enabled": true,
  "dryRun": false,
  "schedule": { "cronExpression": "30 7 * * 1-5", "timezone": "America/New_York" },
  "task": {
    "promptTemplate": "List the top 20 endpoints by highest CVSS score that have unpatched vulnerabilities ≥ 8.0 as of {{today}}. Group by business unit if possible. Include only servers and production workstations.",
    "variables": {},
    "allowedTools": ["lookup_asset", "run_defender_hunting_query", "list_indicators"],
    "maxDurationSeconds": 180
  },
  "routing": {
    "destination": "tool",
    "toolName": "send_email",
    "fallbackDestination": "cosmos-log"
  },
  "circuitBreakerThreshold": 3
}
```

### Monthly CA-drift report → audit log only

```json
{
  "name": "Monthly CA policy drift report",
  "description": "Snapshots Conditional Access policies for monthly compliance review.",
  "enabled": true,
  "dryRun": false,
  "schedule": { "cronExpression": "0 9 1 * *", "timezone": "America/New_York" },
  "task": {
    "promptTemplate": "Enumerate all Conditional Access policies. For each, capture the name, state (enabled/disabled/report), included users, included applications, and grant controls. Today is {{today}}. Highlight any policy in 'reportOnly' state that's older than 30 days.",
    "variables": {},
    "allowedTools": ["list_ca_policies", "get_ca_policy", "list_named_locations"],
    "maxDurationSeconds": 240
  },
  "routing": { "destination": "cosmos-log" },
  "circuitBreakerThreshold": 3
}
```

### Smoke test (use this first when you're new)

```json
{
  "name": "Smoke test (dry-run)",
  "description": "First-time setup smoke test",
  "enabled": false,
  "dryRun": true,
  "schedule": { "cronExpression": "*/3 * * * *", "timezone": "UTC" },
  "task": {
    "promptTemplate": "Say hello and report today's date ({{today}}).",
    "variables": {},
    "allowedTools": ["searchKnowledgeBase"],
    "maxDurationSeconds": 30
  },
  "routing": { "destination": "cosmos-log" },
  "circuitBreakerThreshold": 3
}
```

---

## Troubleshooting (user-facing)

### My task says `no_allowed_tools` and won't run

`allowedTools` is empty. Add at least one read-only tool name. If the
prompt genuinely doesn't need any tool, include `searchKnowledgeBase`
as a placeholder.

### `unknown_template_variable: foo`

Your `promptTemplate` uses `{{foo}}` but `task.variables.foo` isn't
defined. Either add it under `variables` or remove the placeholder.
`{{today}}` is the one exception — it's always auto-provided.

### `aborted_or_timeout`

The agent loop ran out of time before producing a final answer.
Either:

- Bump `maxDurationSeconds` (max is 600).
- Narrow your prompt — fewer tool calls, smaller time windows in KQL.

### `name must be 200 characters or fewer`

Task names are capped at 200 characters and can't contain control or
formatting characters (newlines, tabs, BiDi overrides, etc.). Shorten
the name or strip the offending characters.

### `system_prompt_unavailable`

Transient — usually a Cosmos or Key Vault hiccup. The next attempt
typically clears it. If it persists, flag to whoever owns
infrastructure.

### Run shows `result: success` but no Teams message arrived

Check `routedTo` in the run-history entry:

- If it says the tool name (e.g. `send_teams_message`) → the
  dispatch reached the Logic App. Check the Logic App's workflow
  run history in Azure to see where the message actually landed.
- If it says `cosmos-log` → the primary destination failed and
  fell back. The `reason` field will start with `primary_failed:
  …` and explain what went wrong (usually a Logic App / Graph
  permission issue — flag to your admin).

### The task circuit-broke. Now what?

See [Circuit breaker — what it does and how to recover](#circuit-breaker--what-it-does-and-how-to-recover).
Read the most recent `reason` values, fix the cause, re-enable.

### I edited a task but my changes don't seem to take effect

The task is etag-protected. If you saved while another tab also had
the task open and saved first, your save would have returned a 409.
Refresh the page and re-edit from the current state.

### Notifications stopped arriving even though the task says `success`

Look at `routedTo` over the last several runs:

- If it's been showing `cosmos-log` (the fallback) for a while,
  routing has been silently failing. Inspect `reason` —
  `primary_failed: …` is the explanation. Flag to whoever maintains
  the Information Security Incident Response Logic App.

---

## Tool reference (commonly used)

A condensed list of safe-for-scheduled-task tools. For the
authoritative inventory, see [`user-guide.md`](./user-guide.md#tool-reference).

| Tool | Purpose |
|---|---|
| `run_sentinel_kql` | Run KQL against Microsoft Sentinel. |
| `run_defender_hunting_query` | Run KQL against Defender XDR Advanced Hunting. |
| `get_sentinel_incidents` | List Sentinel incidents with status / severity filters. |
| `get_xdr_alert` | Fetch a specific Defender XDR alert. |
| `search_xdr_by_host` | Pivot across Defender XDR tables by host. |
| `get_user_info` | Read an Entra user record. |
| `list_ca_policies` | List Conditional Access policies. |
| `get_ca_policy` | Fetch one CA policy in detail. |
| `list_named_locations` | List CA named locations. |
| `list_indicators` | List threat indicators currently deployed. |
| `lookup_asset` | Asset lookup against the inventory. |
| `search_user_messages` | Search a user's mailbox (read-only). |
| `search_abnormal_messages` | Search Abnormal Security's message catalog. |
| `list_abnormal_threats` | List Abnormal threats. |
| `list_ato_cases` | List Abnormal ATO cases. |
| `list_appomni_findings` | List AppOmni findings. |
| `get_employee_profile` | Abnormal employee profile lookup. |
| `searchKnowledgeBase` | Search Neo's knowledge base / runbooks. |

---

## Quick reference card

For pinning over a desk:

```
• Tasks are admin-only. Create from Settings → Scheduled Tasks.
• Start with dryRun: true, enabled: false. Click "Run now" to test.
• allowedTools MUST be non-empty. Destructive tools auto-stripped.
• cron is 5 fields: min hour day month dow. Poller ticks every 2 min.
• {{today}} is auto-provided. Other {{vars}} live in task.variables.
• Routing destinations: tool > teams-channel > cosmos-log > email (n/a).
• Default destination: tool, toolName: send_teams_message.
• Fallback defaults to cosmos-log. Cannot be "tool".
• maxDurationSeconds cap is 600 (10 min).
• Circuit breaker trips at 3 consecutive failures (configurable).
• Run history keeps last 50 entries.
• CLI: neo schedule {list, show, run, enable, disable, delete, create, runs}
```
