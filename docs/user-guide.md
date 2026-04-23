# User Guide

This guide covers day-to-day usage of Neo for both regular users (readers) and administrators.

## Table of Contents

- [Getting Started](#getting-started)
  - [Prerequisites](#prerequisites)
  - [Downloading the CLI](#downloading-the-cli)
  - [First-Time Setup (CLI)](#first-time-setup-cli)
  - [First-Time Setup (Web Server)](#first-time-setup-web-server)
- [Using the CLI](#using-the-cli)
  - [Starting the REPL](#starting-the-repl)
  - [Updating the CLI](#updating-the-cli)
  - [Running Investigations](#running-investigations)
  - [Understanding Tool Calls](#understanding-tool-calls)
  - [Confirming Destructive Actions](#confirming-destructive-actions)
  - [Managing Sessions](#managing-sessions)
  - [One-Shot Prompts (Agent-to-Agent Composition)](#one-shot-prompts-agent-to-agent-composition)
    - [Security considerations for agent-to-agent use](#security-considerations-for-agent-to-agent-use)
  - [Settings](#settings)
  - [Debugging](#debugging)
- [Common Tasks — Reader](#common-tasks--reader)
  - [Triage Incidents](#triage-incidents)
  - [Investigate a User](#investigate-a-user)
  - [Investigate a Host](#investigate-a-host)
  - [Look Up an Asset](#look-up-an-asset)
  - [Search Email Threats](#search-email-threats)
  - [Run a Custom KQL Query](#run-a-custom-kql-query)
  - [Multi-Step Investigation](#multi-step-investigation)
- [Common Tasks — Admin](#common-tasks--admin)
  - [Contain a Compromised Account](#contain-a-compromised-account)
  - [Isolate a Machine](#isolate-a-machine)
  - [Release an Isolated Machine](#release-an-isolated-machine)
  - [Remediate Email Threats](#remediate-email-threats)
  - [Full Incident Response Workflow](#full-incident-response-workflow)
- [Skills](#skills)
  - [Using Skills](#using-skills)
  - [Managing Skills (Admin)](#managing-skills-admin)
- [Administration](#administration)
  - [Managing API Keys](#managing-api-keys)
  - [Managing Sessions (Admin)](#managing-sessions-admin)
  - [Starting the Server](#starting-the-server)
  - [Going Live with Azure](#going-live-with-azure)
  - [Monitoring](#monitoring)
  - [Prompt Injection Guard](#prompt-injection-guard)
- [Reference](#reference)
  - [CLI Commands](#cli-commands)
  - [Tool Reference](#tool-reference)
  - [Role Permissions](#role-permissions)
  - [Rate Limits](#rate-limits)
  - [API Endpoints](#api-endpoints)

---

## Getting Started

### Prerequisites

- Access to the Neo web server (URL and API key or Entra ID credentials)
- For admins: access to the server filesystem or deployment pipeline
- **Windows installer**: No prerequisites — just run the MSI installer
- **From source**: Node.js 18 or later

### Downloading the CLI

The CLI installer is available from the downloads page on your Neo web server at `/downloads`. The page auto-detects your operating system and recommends the correct installer.

**Currently available**:
- **Windows** — standalone `.exe` installer (no Node.js required)

**Coming soon**:
- macOS
- Linux

The downloads page also includes step-by-step install instructions and a quick-start guide.

### First-Time Setup (CLI)

**Option A — Windows Installer (recommended)**:

1. Visit your Neo server's downloads page (`https://<your-server>/downloads`) and download the Windows installer, or run `NeoSetup-<version>.exe` if provided directly.
2. The installer places `neo.exe` in `Program Files\Neo` and adds it to your system PATH.
3. Open a new terminal and proceed to step 2 below (authentication), replacing `node src/index.js` with `neo`.

**Option B — From source**:

1. **Install dependencies**:
   ```bash
   cd cli
   npm install
   ```

2. **Authenticate** (choose one):

   **API Key** (simplest):
   ```bash
   node src/index.js auth login --api-key <your-key>
   ```

   **Entra ID** (browser login — auto-discovers config from the server):
   ```bash
   node src/index.js auth login
   ```

3. **Verify your connection**:
   ```bash
   node src/index.js auth status
   ```

   You should see:
   ```
   Neo CLI Status

   Server:      http://localhost:3000
   Auth method: api-key
   API key:     [ok] configured
   ```

4. **Start the REPL**:
   ```bash
   npm start
   ```

### First-Time Setup (Web Server)

1. **Install dependencies**:
   ```bash
   cd web
   npm install
   ```

2. **Create environment file**:
   ```bash
   cp .env.example .env
   # Edit .env and set ANTHROPIC_API_KEY and AUTH_SECRET
   ```

3. **Create API keys** (copy from example and edit):
   ```bash
   cp api-keys.example.json api-keys.json
   # Edit api-keys.json — replace example keys with real ones
   ```

   Generate secure keys:
   ```bash
   openssl rand -base64 24
   ```

4. **Start the server**:
   ```bash
   npm run dev
   ```

---

## Using the CLI

### Starting the REPL

```bash
cd cli
npm start
```

You will see the Neo banner and a prompt:

```
    ███╗   ██╗███████╗ ██████╗
    ████╗  ██║██╔════╝██╔═══██╗
    ██╔██╗ ██║█████╗  ██║   ██║
    ██║╚██╗██║██╔══╝  ██║   ██║
    ██║ ╚████║███████╗╚██████╔╝
    ╚═╝  ╚═══╝╚══════╝ ╚═════╝
    [ S E C U R I T Y  A G E N T  v2.0 ]

    Connected to http://localhost:3000

🔐 You:
```

Type your question or investigation request and press Enter.

### Updating the CLI

The CLI automatically checks for updates each time it starts. If a newer version is available, you will see a notice:

```
    [UPDATE] v1.0.0 -> v1.1.0
    Run neo update to install the latest version.
```

To update, run:

```bash
neo update
```

On Windows, this downloads the latest installer and launches it automatically. The CLI will exit and the installer will replace the existing version. Open a new terminal after the installer completes.

If you are already on the latest version:

```
  [OK] You're up to date (v1.0.0).
```

The update check is non-blocking — if the server is unreachable, the CLI starts normally without any error.

> Note: Auto-update is currently supported on Windows only. On other platforms, `neo update` will direct you to the downloads page.

### Running Investigations

Neo works like a conversation with a senior SOC analyst. You describe what you want to investigate, and the agent gathers evidence by calling tools autonomously.

```
🔐 You: Are there any high severity incidents from the past week?
```

The agent will:
1. Call `get_sentinel_incidents` to fetch incidents.
2. Analyze the results.
3. Return a summary with recommendations.

You can ask follow-up questions in the same session — the agent remembers the full conversation context. For long investigations with many tool calls, the agent automatically compresses older context to stay within the model's token limit while preserving key findings.

### Understanding Tool Calls

When the agent calls a tool, you will see it in the output:

```
[tool] run_sentinel_kql
   description: Search for failed logins from TOR exit nodes
   query: SigninLogs | where TimeGenerated > ago(24h) | where IPAddress in (...)...
```

Destructive tools are marked differently:

```
[DESTRUCTIVE] reset_user_password
   upn: jsmith@contoso.com
   justification: Confirmed credential compromise via TOR login
```

### Confirming Destructive Actions

When the agent wants to execute a destructive action (password reset, machine isolation), it pauses and asks for confirmation:

```
╔══════════ CONFIRMATION REQUIRED ══════════╗
   Action:       Reset password for jsmith@contoso.com + revoke all sessions
   Justification: Confirmed credential compromise via TOR login
╚════════════════════════════════════════════╝

Type 'yes' to confirm, anything else to cancel:
  >
```

- Type `yes` and press Enter to execute the action.
- Type anything else (or just press Enter) to cancel.

After confirmation, the agent continues its investigation with the result of the action.

> Note: Only `admin` users can confirm destructive actions. If you have the `reader` role, the agent will not attempt destructive actions.

### Managing Sessions

Each conversation creates a server-side session that maintains your message history.

- **Continue a session**: Just keep typing in the same REPL session.
- **Start fresh**: Type `clear` to reset the session. This starts a new conversation with no prior context.
- **Quit**: Type `exit` to leave the REPL.

Sessions persist on the server between CLI restarts. If you restart the CLI without typing `clear`, a new session is created.

### One-Shot Prompts (Agent-to-Agent Composition)

For piping Neo into another tool — Claude Code, a CI step, a shell script — use the non-interactive `neo prompt` subcommand. It sends one message, streams the response, and exits. No banner, no REPL, no ANSI noise in piped output.

**Basic usage:**

```bash
# Message as an argument
neo prompt "who signed in from outside the US in the last 24h?"

# Message from stdin (good for long prompts)
cat investigation-brief.txt | neo prompt -

# Override the server for this invocation only
neo prompt "..." --server https://neo-web.yourdomain.com
```

**Structured output for parsing:**

```bash
neo prompt "..." --json
```

In `--json` mode, stdout emits the server's raw NDJSON stream — one JSON event per line, matching the wire format (`{ "type": "thinking" }`, `{ "type": "tool_call", ... }`, `{ "type": "tool_result", ... }`, `{ "type": "response", "text": "..." }`). This is the format agents like Claude Code should prefer when they want to reason about Neo's tool calls, not just the final answer.

**Session continuity:**

Each `neo prompt` call is stateless by default — a fresh session per invocation. To chain calls across prompts:

```bash
# Start a conversation and save the minted session id
neo prompt "look up alice@corp.com" --session-out 2>session.txt
SESSION=$(grep -oP 'session: \K.*' session.txt)

# Continue the same conversation
neo prompt "now check her recent sign-ins" --session "$SESSION"
```

`--session-out` writes `session: conv_abc-uuid` to **stderr** after the response completes so it doesn't pollute the stdout channel a caller is parsing.

**Output channels:**

| Channel | Plain mode | `--json` mode |
|---|---|---|
| stdout | Final assistant text, one trailing newline. | Raw NDJSON stream, one event per line. |
| stderr | Tool calls and skill invocations (informational prefix `[tool]` / `[skill]`), errors. | Errors only. |

**Exit codes:**

| Code | Meaning |
|---|---|
| `0` | Response delivered. |
| `1` | Agent error (tool failure, bad request, confirmation paused mid-stream), or no auth configured. |
| `2` | Bad CLI usage (missing message, mid-request auth failure). |
| `3` | Server / network error — the HTTP round-trip itself failed. |

**Destructive-tool pause:**

If Neo needs to confirm a destructive action (password reset, machine isolation), `neo prompt` can't resolve that in one shot. It exits `1` with a message to stderr pointing at the sticky session id, and you can resume interactively:

```
neo prompt: agent paused for confirmation of destructive tool "reset_user_password".
Resume interactively with:  neo --session conv_abc-uuid
```

The REPL honors `--session <id>` at startup, so the resume command drops you into an interactive conversation already bound to the paused session — you'll see Neo's pending prompt and can approve or cancel at the confirmation gate.

#### Security considerations for agent-to-agent use

The `neo prompt` subcommand is designed to be invoked by other agents and CI systems. Two channel behaviors are worth making explicit before you wire it into a pipeline:

- **`--json` stdout contains tool inputs, not just the final answer.** The stream passes through the server's full event set — including `tool_call` events whose `input` field carries the raw arguments the agent supplied (UPNs, KQL queries, indicator values, destructive-action justifications, etc.). That is deliberate: agents like Claude Code need to reason about Neo's tool calls, not only its prose reply. It also means **`--json` stdout must not be redirected to untrusted log collectors or shared storage**. If a caller routes stdout to a SIEM, build-log service, or chat channel, it will ship operational detail and PII there. Route stdout to an in-memory buffer in the calling agent, or use plain mode (no `--json`) if only the final answer is needed.

- **stderr may contain session ids.** With `--session-out`, and always when a destructive-tool pause fires, the minted session id is written to stderr. Session ids are not credentials — the server enforces auth independently on every `/api/agent` and `/api/agent/confirm` call — but they are opaque correlation identifiers. Treat stderr as internal to the calling agent.

- **Prefer `NEO_API_KEY` over `--api-key` for non-interactive callers.** The `--api-key` flag is visible in `ps aux` and often captured by container / CI audit logs. The env-var path avoids process-table exposure entirely. `neo prompt` emits a one-line stderr warning when invoked with `--api-key` to flag this at runtime.

- **stdin is capped at 1 MB.** `neo prompt -` reads from stdin until EOF or the 1 MB limit; above that the stream is destroyed and the process exits `2`. This prevents an accidental `neo prompt - < /dev/urandom` or a misbehaving upstream from OOMing the CLI host, and doubles as a coarse upper bound on prompt-injection payload size for untrusted callers.

### Model Selection

Neo supports two Claude models. You can choose between them per-session:

- **Sonnet** (default) — Fast, cost-effective, and capable for most investigations.
- **Opus** — Most capable model for complex multi-step reasoning.

In the web UI, select your preferred model before starting a conversation (model selection UI coming soon). Via the API, pass `"model": "claude-opus-4-6"` in the request body to use Opus; omit it to use Sonnet (the default). You can check your current token usage on the [Settings](#settings) page under the Usage tab.

The model preference applies for the duration of the session and does not affect other users.

### File Uploads (Web)

The web interface accepts image, PDF, and CSV attachments. Click the paper-clip icon next to the message input to attach one or more files (up to 5 per message).

**Supported types and limits**

| Type | Extensions | Maximum size |
|---|---|---|
| Images | `.jpg`, `.jpeg`, `.png`, `.gif`, `.webp` | 20 MB |
| Documents | `.pdf` | 32 MB |
| CSV data | `.csv` | 50 MB |

**How CSVs are handled**

Neo uses a hybrid strategy for CSVs so you don't have to think about file size:

- **Small CSVs (≤ 500 rows AND ≤ 100 KB)** are inlined directly into the conversation as text. Claude can read individual rows, quote cells, and answer questions without any extra round-trip. This is the right mode for alert lists, short exports, and anything small enough to fit in context.
- **Larger CSVs** are uploaded to blob storage and exposed through a `query_csv` tool. Claude sees only the column schema and a 5-row preview in the prompt, then runs SQL queries on demand (SELECT / WITH / PRAGMA) against an in-memory SQLite copy. The table name is always `csv`. Query results are capped at 100 rows per call; prefer aggregations (`COUNT`, `GROUP BY`, `AVG`) over raw dumps. Common examples:

  ```text
  Which source IPs accounted for the most failed sign-ins?
  What's the 95th percentile of response time in this CSV?
  Show me the 10 users with the highest alert counts.
  ```

**Limits and caveats**

- Up to **10 reference-mode CSVs** per conversation. Uploading an 11th returns an error asking you to start a new conversation.
- CSV column count is capped at **200**. Wider files are rejected at upload time.
- Binary files renamed with a `.csv` extension are rejected before parsing.
- CSVs are processed server-side with `csv-parse`; malformed rows (unterminated quotes, ragged rows) surface a validation error before the file reaches Claude.
- Reference-mode blobs live in the `neo-csv-uploads` container and are tied to the conversation document for TTL cleanup. See [configuration.md](configuration.md#csv-uploads) for deployment details.

### Conversation History (Web)

When Azure Cosmos DB is configured, the web interface persists conversations across sessions and server restarts. The sidebar shows your recent conversations, and you can:

- **Resume a conversation**: Click any conversation in the sidebar to reload its full message history.
- **Rename a conversation**: Hover over a conversation and click the edit icon. Titles are auto-generated after the first exchange but can be changed at any time (max 200 characters).
- **Delete a conversation**: Hover over a conversation and click the delete icon. Deletion waits for server confirmation before removing the conversation from the sidebar.
- **Start a new conversation**: Click "New Operation" in the sidebar.

Conversations idle for 30 minutes are treated as expired for active session purposes, but the full message history is retained in Cosmos DB for 90 days.

Without Cosmos DB configured (or in mock mode), sessions are stored in-memory and do not persist across server restarts.

### Settings

Click the gear icon in the chat sidebar footer to open the Settings page (`/settings`). The page has the following tabs:

**General**

- **Profile**: Shows your full name (from your Entra ID account, read-only) and a "What should Neo call you?" field where you can set a display name. The display name is stored in your browser's local storage and persists across sessions.
- **Appearance**: Choose between Light, Auto, or Dark color mode. Auto follows your operating system's preference. Your choice is saved in local storage and persists across sessions.

**Usage**

- **Current session**: A progress bar showing your token usage in the current 2-hour rolling window.
- **Weekly limits**: A progress bar showing your token usage in the 1-week rolling window.
- **Estimated monthly cost**: A projected cost based on your weekly usage.
- **Refresh**: Click the refresh button to re-fetch the latest usage data from the server.

Progress bars change color as you approach limits: blue for normal usage, amber at 80%, red at 95%.

**Organization** (admin-only)

- **Organization Name**: Read-only display of the `ORG_NAME` environment variable (appears in the system prompt, e.g., "for Acme Corp's security team"). Requires a server restart to change.
- **Organizational Context**: Free-text textarea for adding SOC-relevant knowledge that helps Neo investigate — domain names, SAM account formats, VPN IP ranges, critical assets, escalation contacts. This is injected into the system prompt for every conversation. Maximum 5,000 characters. Changes take effect within 60 seconds.

**Usage Limits** (admin-only)

- **Per-user usage**: View all users' token usage across both the 2-hour and weekly rolling windows, displayed as progress bars.
- **Configured limits**: Shows the current token caps (configurable via `USAGE_LIMIT_2H_INPUT_TOKENS` and `USAGE_LIMIT_WEEKLY_INPUT_TOKENS` environment variables).
- **Reset**: Reset a specific user's usage for a specific window with inline confirmation. Useful when a user hits a limit during a legitimate investigation.

**API Keys** (admin-only)

- **Create key**: Generate API keys with a label, role, and optional expiration (max 2 years). The raw key is shown once on creation.
- **Key table**: View all your keys with label, role, creation date, expiration, last used timestamp, and status (Active/Expired/Revoked).
- **Revoke**: Immediately invalidate a key with inline confirmation.
- Super-admins (configured via `SUPER_ADMIN_IDS`) can view and manage all keys.

### Debugging

Set the `DEBUG` environment variable for verbose output:

```bash
DEBUG=1 npm start
```

This shows:
- Full error stack traces
- NDJSON stream parsing details
- Entra ID token exchange details

---

## Common Tasks — Reader

These tasks are available to all users (both `reader` and `admin` roles).

### Triage Incidents

**List recent high-severity incidents**:
```
🔐 You: Show me high severity incidents from the last 24 hours
```

**Get details on a specific incident**:
```
🔐 You: Tell me more about incident INC-2024-1234
```

**Daily triage summary**:
```
🔐 You: Give me a triage summary of all new incidents since yesterday morning
```

### Investigate a User

**Basic user lookup**:
```
🔐 You: Look up the user jsmith@contoso.com
```

The agent will call `get_user_info` to retrieve:
- Account status and details
- MFA registration status
- Group memberships
- Recent devices
- Risk level

**Suspicious login investigation**:
```
🔐 You: Investigate suspicious logins for jsmith@contoso.com in the past 7 days
```

The agent will typically:
1. Look up the user's profile.
2. Query `SigninLogs` for recent authentication events.
3. Check for impossible travel, TOR/VPN usage, or off-hours access.
4. Correlate with `AuditLogs` for privilege changes.
5. Provide a risk assessment.

**Check for compromised credentials**:
```
🔐 You: Has jsmith@contoso.com had any sign-ins from anonymized networks or impossible travel?
```

### Investigate a Host

**Search for alerts on a machine**:
```
🔐 You: Search for alerts on LAPTOP-JS4729 in Defender
```

**Deep host investigation**:
```
🔐 You: LAPTOP-JS4729 triggered a malware alert. Investigate the full timeline and tell me if it's compromised.
```

The agent will:
1. Search XDR alerts for the hostname.
2. Query Sentinel for related events.
3. Look for lateral movement indicators.
4. Check which user was logged in.
5. Assess severity and recommend containment if needed.

### Look Up an Asset

**Basic asset lookup**:
```
🔐 You: Look up asset YOURPC01 in Lansweeper
```

The agent will call `lookup_asset` to retrieve:
- Asset identity (name, type, IP, MAC, OS, manufacturer/model)
- Ownership tags (Business Owner, BIA Tier, Role, Technology Owner)
- Primary user (most frequently logged-in)
- Vulnerability summary (count, severity breakdown, top CVEs)

**Lookup by IP**:
```
🔐 You: Who owns the device at 10.0.1.42?
```

**Lookup by serial number**:
```
🔐 You: Look up serial number DLAT5540-X9K2M in Lansweeper
```

### Search Email Threats

**Search for phishing messages**:
```
🔐 You: Search Abnormal Security for attack messages from sender security-alert@evil-domain.com in the last 48 hours
```

The agent will call `search_abnormal_messages` and return a paginated list of matching messages with sender, recipient, subject, judgement, and timestamps.

**Search by attachment hash**:
```
🔐 You: Search Abnormal for messages with attachment MD5 hash d41d8cd98f00b204e9800998ecf8427e
```

### Run a Custom KQL Query

You can ask the agent to run specific KQL queries:

```
🔐 You: Run this KQL query: SigninLogs | where TimeGenerated > ago(1h) | where ResultType != 0 | summarize count() by UserPrincipalName
```

Or describe what you want and let the agent write the query:

```
🔐 You: Show me all failed MFA challenges in the past 6 hours
```

### Multi-Step Investigation

The agent excels at chained investigations. Give it a scenario and let it work:

```
🔐 You: Our MDR provider flagged jsmith@contoso.com for a login from a TOR exit node at 3am. Investigate and tell me what happened.
```

The agent will autonomously:
1. Look up the user account and risk level.
2. Query sign-in logs for the flagged time window.
3. Check if the IP is a known TOR exit node.
4. Look for additional suspicious activity around that time.
5. Check for any privilege escalation or data access.
6. Provide a confidence-rated assessment and recommended actions.

---

## Common Tasks — Admin

These tasks require the `admin` role. They include all reader capabilities plus destructive containment actions.

### Contain a Compromised Account

**Reset password and revoke sessions**:
```
🔐 You: Reset the password for jsmith@contoso.com and revoke all their sessions. There is confirmed credential compromise from a TOR login.
```

The agent will:
1. Explain what it's about to do.
2. Call `reset_user_password` with a justification.
3. Pause for your confirmation.
4. Execute the reset and report the result.

```
╔══════════ CONFIRMATION REQUIRED ══════════╗
   Action:       Reset password for jsmith@contoso.com + revoke all sessions
   Justification: Confirmed credential compromise from TOR login
╚════════════════════════════════════════════╝

Type 'yes' to confirm, anything else to cancel:
  > yes
  [CONFIRMED] reset_user_password — executing
```

### Isolate a Machine

**Network-isolate a compromised endpoint**:
```
🔐 You: Isolate LAPTOP-JS4729 from the network. It has an active malware infection.
```

The agent will request confirmation before isolating:

```
╔══════════ CONFIRMATION REQUIRED ══════════╗
   Action:       Network-isolate LAPTOP-JS4729 on defender (Full)
   Justification: Active malware infection detected
╚════════════════════════════════════════════╝

Type 'yes' to confirm, anything else to cancel:
  > yes
  [CONFIRMED] isolate_machine — executing
```

Full isolation blocks all network traffic except the XDR management channel.

### Release an Isolated Machine

After remediation:
```
🔐 You: Release LAPTOP-JS4729 from isolation. Remediation is complete.
```

### Remediate Email Threats

**Search and delete phishing messages**:
```
🔐 You: Find all messages from security-alert@evil-domain.com and delete them
```

The agent will:
1. Search Abnormal Security for matching messages.
2. Show you the results and total count.
3. Call `remediate_abnormal_messages` with the delete action.
4. Pause for your confirmation before executing.
5. Return the activity log ID for tracking.

**Check remediation status**:
```
🔐 You: Check the status of remediation act-d4e5f6a7-b8c9-0123-def4-567890abcdef
```

### Full Incident Response Workflow

For a complete incident response, you can guide the agent through the entire workflow:

```
🔐 You: We received an alert that jsmith@contoso.com logged in from a suspicious IP and downloaded 50 files from SharePoint. Investigate, contain, and give me an IR summary.
```

The agent will typically:
1. **Gather evidence**: Query sign-in logs, check the IP reputation, review audit logs.
2. **Assess the user**: Check account status, MFA, risk level, group memberships.
3. **Check the endpoint**: Look for alerts on the user's devices.
4. **Assess severity**: Rate confidence as HIGH/MEDIUM/LOW.
5. **Recommend containment**: If evidence is strong, propose password reset and/or machine isolation.
6. **Execute containment**: After your confirmation, reset the password and/or isolate machines.
7. **Summarize**: Provide a structured IR summary with timeline, evidence, actions taken, and next steps.

---

## Skills

Skills are admin-defined investigation runbooks (markdown files) that guide the agent through multi-step workflows. When a user's request matches a skill, the agent follows its steps precisely.

### Using Skills

Skills are automatically available based on your role. Ask the agent what skills are available:

```
🔐 You: What skills are available?
```

To invoke a skill, describe the scenario naturally:

```
🔐 You: Investigate a TOR login for jsmith@contoso.com in the past 48 hours
```

If a matching skill exists (e.g., "TOR Login Investigation"), the agent will follow its defined steps — gathering user context, confirming the TOR login via KQL, checking for impossible travel, and so on.

Skills that require destructive tools (password reset, isolation) are only available to `admin` users.

### Managing Skills (Admin)

Skills are stored as markdown files in `web/skills/` and can be managed via the API or by editing files directly.

**List all skills**:
```bash
curl -H "Authorization: Bearer <api-key>" \
  http://localhost:3000/api/skills
```

**Get a specific skill**:
```bash
curl -H "Authorization: Bearer <api-key>" \
  http://localhost:3000/api/skills/tor-login-investigation
```

**Create a new skill**:
```bash
curl -X POST -H "Authorization: Bearer <admin-api-key>" \
  -H "Content-Type: application/json" \
  -d '{"id": "my-new-skill", "content": "# Skill: My New Skill\n\n## Description\n..."}' \
  http://localhost:3000/api/skills
```

**Update a skill**:
```bash
curl -X PUT -H "Authorization: Bearer <admin-api-key>" \
  -H "Content-Type: application/json" \
  -d '{"content": "# Skill: Updated Skill\n\n## Description\n..."}' \
  http://localhost:3000/api/skills/my-new-skill
```

**Delete a skill**:
```bash
curl -X DELETE -H "Authorization: Bearer <admin-api-key>" \
  http://localhost:3000/api/skills/my-new-skill
```

You can also create skills by placing `.md` files directly in the `web/skills/` directory. The server watches this directory and loads changes automatically (no restart needed).

---

## Administration

### Managing API Keys

When Azure Cosmos DB and Key Vault are configured, API keys are managed through the Settings page in the web UI. Navigate to `/settings` and select the **API Keys** tab (admin-only).

**Creating a key**:

1. Enter a label (e.g., "CI Pipeline"), select a role (admin or reader), and optionally set an expiration date (maximum 2 years).
2. Click **Create Key**.
3. The raw key is displayed exactly once in a modal. Copy it immediately — it cannot be retrieved again.
4. Distribute the key securely to the user or system that needs it.

**Revoking a key**: Click **Revoke** next to any active key in the table. Confirm the inline prompt. The key is immediately invalidated — the next API call using it will receive a 401 response.

**Key limits**: Each admin can have up to 20 active keys. Keys can have a maximum lifetime of 2 years.

**Super-admin**: Users whose owner ID is listed in the `SUPER_ADMIN_IDS` environment variable can view and revoke all keys across all admins. Regular admins can only manage their own keys.

**Last used tracking**: The key table shows when each key was last used for authentication, helping identify stale keys.

**Fallback (JSON file)**: For deployments without Cosmos DB, API keys can still be managed via `web/api-keys.json` (the legacy approach). The server watches this file and reloads automatically. See the [Configuration Guide](configuration.md#api-key-management) for the JSON file format.

### Managing Sessions (Admin)

Admins can view and delete any session via the API:

**List all sessions**:
```bash
curl -H "Authorization: Bearer <admin-api-key>" \
  http://localhost:3000/api/agent/sessions
```

**Delete a session**:
```bash
curl -X DELETE -H "Authorization: Bearer <admin-api-key>" \
  -H "Content-Type: application/json" \
  -d '{"sessionId": "<session-id>"}' \
  http://localhost:3000/api/agent/sessions
```

Readers can only see and delete their own sessions.

### Starting the Server

**Development**:
```bash
cd web
npm run dev
```

**Production build**:
```bash
cd web
npm run build
npm start
```

The server runs on port 3000 by default. Set the `PORT` environment variable to change it.

### Going Live with Azure

1. **Set `MOCK_MODE=false`** in `.env`.

2. **Add Azure credentials** to `.env`:
   ```bash
   AZURE_TENANT_ID=<your-tenant-id>
   AZURE_CLIENT_ID=<your-client-id>
   AZURE_CLIENT_SECRET=<your-client-secret>
   AZURE_SUBSCRIPTION_ID=<your-subscription-id>
   SENTINEL_WORKSPACE_ID=<workspace-guid>
   SENTINEL_WORKSPACE_NAME=<workspace-name>
   SENTINEL_RESOURCE_GROUP=<resource-group-name>
   ```

3. **Ensure the app registration has the required permissions** (see [Configuration Guide](configuration.md#azure-app-registration)).

4. **Implement real tool executors** in `web/lib/executors.ts`. Each function has a mock path and a commented `REAL IMPLEMENTATION` block showing the actual Azure API calls.

5. **Restart the server**.

### Monitoring

- **Debug logging**: Set `DEBUG=1` when running the CLI for verbose output.
- **Server logs**: Next.js logs requests to stdout. Check the terminal running `npm run dev`. Set `LOG_LEVEL=debug` for detailed output including tool execution and session lifecycle events.
- **Structured audit logs**: When configured, all events (auth, tool calls, confirmations, errors) are sent to Azure Event Hub as JSON. See [Configuration Guide — Structured Logging](configuration.md#structured-logging).
- **Injection detection logs**: Prompt injection detections appear as `warn`-level log entries with component `injection-guard`. In monitor mode, these are informational. Review them to calibrate false-positive rates before enabling block mode.
- **Session inspection**: Use the sessions API endpoint to monitor active sessions and message counts.

### Prompt Injection Guard

Neo includes built-in protection against prompt injection attacks. This is transparent to normal users — legitimate SOC queries are not affected.

**What happens when an injection is detected:**

- In **monitor mode** (default): The detection is logged and the request proceeds normally. The agent may also flag the attempt in its response.
- In **block mode**: Messages with 2 or more pattern matches are rejected with a generic error. Single-pattern matches are allowed through to avoid false positives.

**If the agent flags your message as a potential injection attempt**, it means your message matched one of the detection patterns. This can occasionally happen with legitimate queries. If you receive an injection warning, rephrase your request. If it happens frequently with normal queries, ask your admin to review the injection guard logs and consider adjusting the configuration.

**For admins**: Set `INJECTION_GUARD_MODE` in `.env`. Start with `monitor` (the default) and review the injection guard logs in your Event Hub or console output. Switch to `block` only after confirming that false-positive rates are acceptable for your team's query patterns. See [Configuration Guide — Prompt Injection Guard](configuration.md#prompt-injection-guard).

---

## Reference

### CLI Commands

| Command | Description |
|---------|-------------|
| `npm start` | Start the CLI REPL (from source) |
| `npm run dev` | Start with auto-reload (development) |
| `neo` | Start the CLI REPL (Windows installer) |
| `neo auth login --api-key <key>` | Save an API key |
| `neo auth login` | Browser-based Entra ID login (auto-discovers config from server) |
| `neo auth logout` | Clear Entra ID credentials |
| `neo auth status` | Show connection and auth status |
| `neo update` | Check for updates and install the latest CLI version (Windows) |

**REPL commands**:

| Command | Description |
|---------|-------------|
| `clear` | Reset conversation (starts a new server session) |
| `exit` | Quit the CLI |

**Flags** (can be combined with `npm start --`):

| Flag | Description |
|------|-------------|
| `--server <url>` | Override the server URL |
| `--api-key <key>` | Override the API key (dev-only) |

### Tool Reference

| Tool | Description | Role |
|------|-------------|------|
| `run_sentinel_kql` | Execute KQL queries against Microsoft Sentinel Log Analytics. Supports any table: `SigninLogs`, `SecurityAlert`, `SecurityIncident`, `AuditLogs`, `DeviceEvents`, etc. | All |
| `get_sentinel_incidents` | List recent Sentinel incidents. Filterable by severity (`High`, `Medium`, `Low`, `Informational`) and status (`New`, `Active`, `Closed`). | All |
| `get_xdr_alert` | Retrieve full alert details from Defender for Endpoint or CrowdStrike. Includes process tree, file hashes, network connections. | All |
| `search_xdr_by_host` | Search for all recent alerts on a hostname or IP. Useful for host-based investigations. | All |
| `get_machine_isolation_status` | Check real-time network isolation status and health of a machine via Defender for Endpoint. Returns isolation state, last action details, health status, and risk score. | All |
| `search_user_messages` | Search a user's Exchange Online mailbox for messages by sender, subject, body content, or date range. Returns message IDs needed for reporting. | All |
| `get_user_info` | Look up an Entra ID user: account status, MFA, groups, devices, risk level. | All |
| `get_full_tool_result` | Retrieve the full, untruncated content of a previous tool result that was truncated to fit the context window. | All |
| `reset_user_password` | Force password reset. Optionally revokes all sessions and refresh tokens. Requires confirmation and justification. | Admin |
| `dismiss_user_risk` | Dismiss risk state for a user in Entra ID Identity Protection. Re-enables login for users blocked by conditional access risk policies. Requires confirmation. | Admin |
| `list_ca_policies` | List all Conditional Access policies with states, conditions, and grant controls. Optional GUID-to-name resolution. | All |
| `get_ca_policy` | Get full details of a specific Conditional Access policy by ID. | All |
| `list_named_locations` | List named locations (IP ranges and countries) used in Conditional Access policies. | All |
| `isolate_machine` | Network-isolate a machine via Defender or CrowdStrike. Requires confirmation and justification. | Admin |
| `unisolate_machine` | Release a previously isolated machine. Requires confirmation and justification. | Admin |
| `report_message_as_phishing` | Report a message in a user's mailbox as phishing or junk via Microsoft Graph. Requires confirmation and justification. | Admin |
| `list_threatlocker_approvals` | List ThreatLocker application approval requests with optional status and search filters. | All |
| `get_threatlocker_approval` | Get full details of a specific ThreatLocker approval request by ID. | All |
| `approve_threatlocker_request` | Approve a ThreatLocker application approval request. Requires confirmation and justification. | Admin |
| `deny_threatlocker_request` | Deny (ignore) a ThreatLocker application approval request. Requires confirmation and justification. | Admin |
| `search_threatlocker_computers` | Search for ThreatLocker computers by hostname, username, or IP. | All |
| `get_threatlocker_computer` | Get full details of a ThreatLocker computer including current maintenance mode. | All |
| `set_maintenance_mode` | Set a computer's ThreatLocker maintenance mode (learning, installation, monitor, secured). Requires confirmation. | Admin |
| `schedule_bulk_maintenance` | Schedule maintenance mode on multiple ThreatLocker computers. Requires confirmation. | Admin |
| `enable_secured_mode` | Return ThreatLocker computers to secured mode. Requires confirmation. | Admin |
| `block_indicator` | Create a custom indicator in Defender for Endpoint to block, warn, or audit a domain, IP, URL, or file hash. Requires confirmation. | Admin |
| `import_indicators` | Batch import up to 500 custom indicators into Defender for Endpoint. Requires confirmation. | Admin |
| `list_indicators` | List current custom indicators in Defender for Endpoint, filterable by type. | All |
| `delete_indicator` | Delete a custom indicator from Defender for Endpoint by ID. Requires confirmation. | Admin |
| `lookup_asset` | Look up an IT asset in Lansweeper by hostname, IP address, or serial number. Returns asset identity, ownership tags, primary user, and vulnerability summary. | All |
| `search_abnormal_messages` | Search messages across the Abnormal Security platform by sender, recipient, subject, attachment, judgement, and time range. Returns paginated message list. | All |
| `remediate_abnormal_messages` | Bulk remediate messages via Abnormal Security: delete, move to inbox, or submit to Detection360. Requires confirmation. | Admin |
| `get_abnormal_remediation_status` | Check the status of a previously submitted Abnormal Security remediation action. | All |
| `get_vendor_risk` | Assess vendor email compromise (VEC) risk for a domain using Abnormal Security. | All |
| `list_vendors` | List all known vendors with risk levels from Abnormal Security. | All |
| `get_vendor_activity` | Get the event timeline for a vendor domain from Abnormal Security. | All |
| `list_vendor_cases` | List vendor compromise cases with insights from Abnormal Security. | All |
| `get_vendor_case` | Get full details of a vendor compromise case including insights and message timeline. | All |
| `get_employee_profile` | Get an employee's organizational context and behavioral baseline (Genome) from Abnormal Security. | All |
| `get_employee_login_history` | Get an employee's 30-day login history from Abnormal Security with IPs, locations, and devices. | All |
| `list_abnormal_threats` | List recent email threats from Abnormal Security with time-based filtering. Defaults to last 24 hours. | All |
| `get_abnormal_threat` | Get full details of an email threat including attack type, sender analysis, attachments, URLs, and remediation status. | All |
| `list_ato_cases` | List Account Takeover cases from Abnormal Security, filterable by last modified time. | All |
| `get_ato_case` | Get full ATO case details with analysis timeline (impossible travel, mail rules, sign-ins, lateral phishing). | All |
| `action_ato_case` | Take action on an ATO case (acknowledge or mark as action required). Requires confirmation. | Admin |
| `list_appomni_services` | List monitored SaaS services with posture scores, user counts, and connection status. | All |
| `get_appomni_service` | Get detailed metadata, sync status, and policy posture for a monitored service. | All |
| `list_appomni_findings` | List posture findings (policy violations + insights) across the SaaS estate. | All |
| `get_appomni_finding` | Get full finding details with compliance controls and occurrence counts. | All |
| `list_appomni_finding_occurrences` | List individual violation instances with user/resource context. | All |
| `list_appomni_insights` | List data exposure and risk insights from AppOmni. | All |
| `list_appomni_policy_issues` | List open policy issues (rule violations) from posture scans. | All |
| `list_appomni_identities` | List unified identities across SaaS services with permission levels. | All |
| `get_appomni_identity` | Get unified identity profile with all linked SaaS accounts. | All |
| `list_appomni_discovered_apps` | List discovered SaaS apps with review status and criticality. | All |
| `get_appomni_audit_logs` | Retrieve AppOmni platform audit logs. | All |
| `action_appomni_finding` | Update finding occurrence status or close by exception. Requires confirmation. | Admin |

### Role Permissions

| Capability | `admin` | `reader` |
|------------|---------|----------|
| Read-only tools | Yes | Yes |
| Destructive tools | Yes (with confirmation) | No |
| View all sessions | Yes | No |
| View own sessions | Yes | Yes |
| Delete any session | Yes | No |
| Delete own sessions | Yes | Yes |
| View skills | Yes | Yes |
| Create/update/delete skills | Yes | No |
| Use admin-only skills | Yes | No |
| Create/revoke API keys | Yes | No |
| Message limit per session | 200 | 100 |

### Rate Limits

Each session has a per-role message limit:

| Role | Messages per session |
|------|---------------------|
| `admin` | 200 |
| `reader` | 100 |

When the limit is reached, start a new session by typing `clear` in the CLI.

**Token usage budgets**: In addition to message limits, each user has token-based budgets:

| Window | Default Limit | Env Var |
|--------|--------------|---------|
| 2-hour rolling window | 670,000 input tokens (~$10 Opus) | `USAGE_LIMIT_2H_INPUT_TOKENS` |
| Weekly rolling window | 6,700,000 input tokens (~$100 Opus) | `USAGE_LIMIT_WEEKLY_INPUT_TOKENS` |

These limits are safety guardrails. Adjust them via environment variables without rebuilding. When a budget is exceeded, you will receive a 429 error indicating which limit was hit. The 2-hour window resets as older usage ages out; the weekly window works the same way. An 80% usage warning is sent in the response stream before the hard limit is reached. Admins can view per-user usage and reset limits in Settings > Usage Limits.

You can check your current usage via the `/api/usage` endpoint.

### API Endpoints

All endpoints require authentication via `Authorization: Bearer <api-key>` header or Auth.js session cookie, except the discovery endpoint.

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/auth/discover` | Unauthenticated. Returns `{ tenantId, clientId }` for CLI Entra ID login. |
| `POST` | `/api/agent` | Send a message to the agent. Returns NDJSON stream. Body: `{ "message": "...", "sessionId?": "..." }` |
| `POST` | `/api/agent/confirm` | Confirm or cancel a pending destructive tool. Body: `{ "sessionId": "...", "toolId": "...", "confirmed": true }` |
| `GET` | `/api/agent/sessions` | List sessions. Admins see all; readers see own. |
| `DELETE` | `/api/agent/sessions` | Delete a session. Body: `{ "sessionId": "..." }` |
| `GET` | `/api/conversations` | List conversations for the authenticated user (requires Cosmos DB). |
| `GET` | `/api/conversations/{id}` | Get a conversation by ID, including full message history. |
| `PATCH` | `/api/conversations/{id}` | Rename a conversation. Body: `{ "title": "..." }` (max 200 chars). |
| `DELETE` | `/api/conversations/{id}` | Delete a conversation permanently. |
| `GET` | `/api/skills` | List all skills (metadata only). All authenticated users. |
| `POST` | `/api/skills` | Create a skill. Admin only. Body: `{ "id": "...", "content": "..." }` |
| `GET` | `/api/skills/{id}` | Get full skill by ID. All authenticated users. |
| `PUT` | `/api/skills/{id}` | Update a skill. Admin only. Body: `{ "content": "..." }` |
| `DELETE` | `/api/skills/{id}` | Delete a skill. Admin only. |
| `GET` | `/api/usage` | Get token usage summary for the authenticated user (two-hour and weekly windows). |
| `GET` | `/api/admin/usage` | List all users' token usage (admin only). Supports `?page=0&pageSize=50`. |
| `POST` | `/api/admin/usage/reset` | Reset a user's usage window (admin only). Body: `{ "userId": "...", "window": "two-hour\|weekly" }` |
| `GET` | `/api/admin/org-context` | Get organizational context and org name (admin only). |
| `PUT` | `/api/admin/org-context` | Update organizational context (admin only). Body: `{ "orgContext": "..." }` |
| `GET` | `/api/api-keys` | List API keys for the authenticated admin (super-admins see all keys). |
| `POST` | `/api/api-keys` | Create an API key. Admin only. Body: `{ "label": "...", "role": "admin|reader", "expiresAt?": "..." }` |
| `DELETE` | `/api/api-keys/{id}` | Revoke an API key by hash ID. Admin only (ownership enforced, super-admin bypass). |
| `GET` | `/downloads` | Public (no auth). CLI installer downloads page with OS detection and install guide. |
| `GET` | `/api/downloads/[filename]` | Public (no auth). Streams an installer file from Azure Blob Storage. |
| `GET` | `/api/cli/version` | Public (no auth). Returns latest CLI version, download URL, platform, and SHA-256 hash. |
| `POST` | `/api/triage` | Submit a security alert for automated triage. Returns a structured verdict JSON. Requires Entra service-principal auth. |
| `POST` | `/api/admin/triage/circuit-breaker/reset` | Manually reset the triage circuit breaker (admin only). |

**NDJSON stream events** (returned by `/api/agent` and `/api/agent/confirm`):

| Event type | Fields | Description |
|------------|--------|-------------|
| `session` | `sessionId` | Emitted first with the session ID |
| `thinking` | (none) | Agent is processing |
| `tool_call` | `tool`, `input` | Agent is calling a tool |
| `confirmation_required` | `tool: { id, name, input }` | Destructive tool needs user confirmation |
| `response` | `text` | Final agent response |
| `context_trimmed` | `originalTokens`, `newTokens`, `method` | Context window was trimmed to stay within token limits. `method` is `"truncation"` (per-result cap) or `"summary"` (conversation compression). |
| `usage` | `usage: { input_tokens, output_tokens, cache_read_input_tokens }`, `model` | Per-turn token usage summary |
| `error` | `message`, `code` | An error occurred |

## Alert Triage API

The triage API enables automated tier-1 alert investigation. External orchestrators (primarily Azure Logic Apps) submit security alerts to Neo, which runs them through investigation skills and returns a structured verdict that the caller uses to auto-close benign alerts or escalate to analysts with Neo's reasoning attached.

### How It Works

1. A Logic App fires on a Sentinel incident (or Defender XDR alert, Entra risky sign-in, etc.).
2. The Logic App extracts a standardized payload and `POST`s it to `https://neo.companyname.com/api/triage` (or your `*.azurewebsites.net` fallback domain) with a Managed Identity bearer token.
3. Neo resolves the matching triage skill (or the generic catch-all), runs a full investigation using its read-only tools, and returns a JSON verdict.
4. The Logic App branches: if `verdict == "benign"` and `confidence >= 0.80`, close the incident in Sentinel with Neo's reasoning as a comment; otherwise, assign to the analyst queue.

### Verdict Response

```json
{
  "verdict": "benign",
  "confidence": 0.92,
  "reasoning": "The alert was triggered by SCCM running a scheduled software inventory scan...",
  "evidence": [
    { "source": "DefenderXDR", "finding": "Process tree shows sccm-client.exe as parent" },
    { "source": "SentinelKQL", "query": "SigninLogs | where ...", "finding": "No anomalous sign-ins" }
  ],
  "recommendedActions": [
    { "action": "close", "reason": "Known-good IT tooling activity" }
  ],
  "neoRunId": "triage_a1b2c3d4-...",
  "skillUsed": "defender-endpoint-triage",
  "durationMs": 8400
}
```

Possible `verdict` values: `benign` (safe to auto-close), `escalate` (needs analyst review), `inconclusive` (not enough data to determine).

### Guardrails

- **Confidence threshold** (default 0.80): verdicts below this threshold are coerced to `escalate` regardless of Neo's assessment. Configurable via `TRIAGE_CONFIDENCE_THRESHOLD`.
- **Severity allowlist** (default: all severities): alerts whose severity is not in the allowlist are coerced to `escalate`. Configurable via `TRIAGE_SEVERITY_ALLOWLIST`.
- **Dry-run mode**: set `context.dryRun: true` in the request to run the full pipeline without the caller acting on the verdict. Use this for shadow-mode validation.
- **Circuit breaker**: if the failure rate exceeds 30% over 15 minutes, all requests return `escalate` until the breaker auto-resets (30 min) or is manually reset via `POST /api/admin/triage/circuit-breaker/reset`.
- **Per-caller rate limit**: 100 requests per 15-minute window per service principal. Returns 429 if exceeded.

### Example: Logic App on Sentinel Incident Creation

**Trigger**: "When a new Microsoft Sentinel incident is created"

**HTTP action** (calls Neo triage API):
```
Method: POST
URI: https://neo.companyname.com/api/triage
Authentication: Managed Identity
Audience: api://<your-neo-app-client-id>
Headers:
  Content-Type: application/json
Body:
{
  "source": {
    "product": "Sentinel",
    "alertType": "@{triggerBody()?['properties']?['additionalData']?['alertProductNames']?[0]}",
    "severity": "@{triggerBody()?['properties']?['severity']}",
    "tenantId": "@{triggerBody()?['properties']?['additionalData']?['tenantId']}",
    "alertId": "@{triggerBody()?['properties']?['incidentNumber']}",
    "detectionTime": "@{triggerBody()?['properties']?['createdTimeUtc']}"
  },
  "payload": {
    "essentials": {
      "title": "@{triggerBody()?['properties']?['title']}",
      "description": "@{triggerBody()?['properties']?['description']}",
      "entities": {
        "users": ["@{join(triggerBody()?['properties']?['relatedEntities']?['accounts'], ',')}"],
        "devices": ["@{join(triggerBody()?['properties']?['relatedEntities']?['hosts'], ',')}"],
        "ips": ["@{join(triggerBody()?['properties']?['relatedEntities']?['ips'], ',')}"]
      },
      "mitreTactics": "@{triggerBody()?['properties']?['additionalData']?['tactics']}"
    },
    "raw": @{triggerBody()}
  },
  "context": {
    "requesterId": "logic-app-sentinel-triage",
    "dryRun": false
  }
}
```

**Condition**: `verdict == "benign"` AND `confidence >= 0.80`
- **True**: Close the incident via the Sentinel API, append Neo's `reasoning` as a comment.
- **False**: Assign to the SOC analyst queue, attach Neo's `reasoning` and `evidence` as a comment.

### Configuring the Logic App HTTP Action Step-by-Step

This section walks through configuring the HTTP action in the Logic App designer to call the Neo triage API.

#### 1. Add an HTTP action after the trigger

In the Logic App designer, after the "When a new Microsoft Sentinel incident is created" trigger, add an **HTTP** action.

#### 2. Configure the HTTP action

Set the following fields in the action:

| Field | Value |
|-------|-------|
| **Method** | `POST` |
| **URI** | `https://neo.companyname.com/api/triage` |
| **Headers** | `Content-Type`: `application/json` |

> **Note**: Use your custom domain (`neo.companyname.com`) if the Logic App runs on the internal network. If the Logic App runs in Azure and cannot reach the internal domain, use the fallback: `https://app-neo-prod-001.azurewebsites.net/api/triage`.

#### 3. Configure authentication

In the HTTP action, expand **Authentication** and set:

| Field | Value |
|-------|-------|
| **Authentication type** | Managed Identity |
| **Managed Identity** | System-assigned |
| **Audience** | `api://<your-neo-app-client-id>` |

Replace `<your-neo-app-client-id>` with the Application (client) ID from Neo's Entra ID app registration (the same value as `AUTH_MICROSOFT_ENTRA_ID_ID`).

#### 4. Set the request body

In the **Body** field, switch to code view and paste the following JSON. The `@{...}` expressions are Logic App dynamic content references that pull values from the Sentinel trigger.

```json
{
  "source": {
    "product": "Sentinel",
    "alertType": "@{triggerBody()?['properties']?['additionalData']?['alertProductNames']?[0]}",
    "severity": "@{triggerBody()?['properties']?['severity']}",
    "tenantId": "@{triggerBody()?['properties']?['additionalData']?['tenantId']}",
    "alertId": "@{triggerBody()?['properties']?['incidentNumber']}",
    "detectionTime": "@{triggerBody()?['properties']?['createdTimeUtc']}"
  },
  "payload": {
    "essentials": {
      "title": "@{triggerBody()?['properties']?['title']}",
      "description": "@{triggerBody()?['properties']?['description']}",
      "entities": {
        "users": ["@{join(triggerBody()?['properties']?['relatedEntities']?['accounts'], ',')}"],
        "devices": ["@{join(triggerBody()?['properties']?['relatedEntities']?['hosts'], ',')}"],
        "ips": ["@{join(triggerBody()?['properties']?['relatedEntities']?['ips'], ',')}"]
      },
      "mitreTactics": "@{triggerBody()?['properties']?['additionalData']?['tactics']}"
    },
    "raw": @{triggerBody()}
  },
  "context": {
    "requesterId": "logic-app-sentinel-triage",
    "dryRun": false
  }
}
```

**Field reference**:

| Field | Required | Description |
|-------|----------|-------------|
| `source.product` | Yes | One of: `Sentinel`, `DefenderXDR`, `EntraIDProtection`, `Purview`, `DefenderForCloudApps` |
| `source.alertType` | Yes | The alert product name (e.g., "Microsoft Defender for Endpoint") |
| `source.severity` | Yes | One of: `Informational`, `Low`, `Medium`, `High` |
| `source.alertId` | Yes | Unique alert identifier (max 255 chars). Used for idempotency dedup |
| `source.tenantId` | No | Azure tenant ID (used for multi-tenant disambiguation) |
| `source.detectionTime` | No | ISO 8601 timestamp. Defaults to current time if omitted |
| `payload.essentials.title` | Yes | Alert title displayed to analysts |
| `payload.essentials.description` | No | Detailed description of the alert |
| `payload.essentials.entities` | No | Related users, devices, IPs, and files for investigation |
| `payload.raw` | No | Full original alert body (max 1 MB). Stored for audit but not sent to Claude |
| `payload.links.portalUrl` | No | HTTPS link to the alert in the source portal |
| `context.requesterId` | Yes | Identifier for the calling Logic App (used in logging) |
| `context.dryRun` | No | Set to `true` to run the investigation without the caller acting on the verdict |
| `context.analystNotes` | No | Free-text notes to include in the investigation prompt (max 10,000 chars) |

#### 5. Add a condition to branch on the verdict

After the HTTP action, add a **Condition** action:

- **Left operand**: `body('HTTP')?['verdict']`
- **Operator**: `is equal to`
- **Right operand**: `benign`

Add a second condition (nested or parallel) to check confidence:

- **Left operand**: `body('HTTP')?['confidence']`
- **Operator**: `is greater than or equal to`
- **Right operand**: `0.80`

#### 6. Handle the True/False branches

**True branch** (benign + high confidence) — close the incident:
- Add a "Microsoft Sentinel — Update incident" action
- Set **Status** to `Closed`
- Set **Classification** to `BenignPositive`
- Set **Comment** to: `[Neo Auto-Triage] @{body('HTTP')?['reasoning']}`

**False branch** (escalate or low confidence) — assign to analysts:
- Add a "Microsoft Sentinel — Update incident" action
- Set **Owner** to your SOC analyst group
- Set **Comment** to: `[Neo Auto-Triage] Verdict: @{body('HTTP')?['verdict']} (confidence: @{body('HTTP')?['confidence']}). Reasoning: @{body('HTTP')?['reasoning']}`

#### 7. Test with dry-run mode

Before enabling auto-close, set `"dryRun": true` in the request body. This runs the full investigation pipeline but signals the Logic App not to act on the verdict. Review the responses in Neo's audit logs (Event Hub, filter by `channel: "triage"`) to validate accuracy before enabling live mode.

### Authentication Setup

The Logic App authenticates to Neo via Managed Identity:

1. Enable a system-assigned Managed Identity on the Logic App.
2. In Neo's Entra app registration, add an app role (e.g., `Triage.Run`) and assign it to the Logic App's managed identity.
3. The Logic App acquires a token for `api://<neo-app-client-id>` and sends it as `Authorization: Bearer <token>`.
4. Neo validates the token's `idtyp === "app"` claim and assigns the `triage` role (read-only investigation tools only).

See [configuration.md](configuration.md#triage-api) for full deployment and configuration steps.

### Alert Type to Skill Routing

Neo routes each triage request to a skill based on the `source.product` and `source.alertType` fields in the request body. The routing works as follows:

1. Neo constructs a lookup key: `"${product}:${alertType}"` (e.g., `"DefenderXDR:DefenderEndpoint.SuspiciousProcess"`)
2. If the key matches an entry in the dispatch table (`web/lib/triage-dispatch.ts`), the corresponding skill is used
3. If no match, the **generic-alert-triage** catch-all skill is used (conservative — leans toward `escalate`)

**Built-in skills**:

| Skill | ID | Triggered by | What it does |
|-------|----|-------------|--------------|
| Defender Endpoint Triage | `defender-endpoint-triage` | `DefenderXDR:DefenderEndpoint.SuspiciousProcess` | Retrieves the XDR alert, analyzes the process tree (LOLBins, obfuscation, parent chain), checks host and user context, queries Sentinel for corroborating evidence |
| Generic Alert Triage | `generic-alert-triage` | Any unmapped `product:alertType` | Identifies pivot points (users, devices, IPs), runs broad Sentinel queries, assesses the alert in context. Leans toward escalation when uncertain |

**Tips for maximizing auto-close rates**:

- Create dedicated triage skills for your highest-volume alert types. Generic triage is conservative by design — specialized skills that know what "normal" looks like for a specific alert type will produce higher-confidence `benign` verdicts.
- Set `source.alertType` in the Logic App to a consistent value that matches the dispatch table. For Sentinel, use the analytics rule name or alert product name.
- Use dry-run mode (`"dryRun": true`) to evaluate skill accuracy before enabling live auto-close.
- Review the `skillUsed` field in triage responses to confirm alerts are routing to the expected skill.

See [configuration.md — Mapping Alert Types to Triage Skills](configuration.md#mapping-alert-types-to-triage-skills) for how to add new mappings and create custom triage skills.

---

## Observability & Logging

Neo emits structured log events to Azure Event Hubs for dashboarding, analytics, and alerting. Every event includes an identity envelope with the user's display name, role, provider, channel, and session ID.

### Event Types

| Event Type | Description | Key Fields |
|------------|-------------|------------|
| `operational` | Standard application logs (info, warn, error) | `level`, `component`, `message` |
| `tool_execution` | Emitted after every tool call completes | `toolName`, `toolCategory`, `isDestructive`, `durationMs`, `status` |
| `token_usage` | Emitted after each Claude API call | `model`, `inputTokens`, `outputTokens`, `cacheCreationTokens`, `cacheReadTokens` |
| `skill_invocation` | Emitted when a slash-command skill is triggered | `skillId`, `skillName` |
| `destructive_action` | Emitted when a destructive tool is confirmed or cancelled | `toolName`, `confirmed`, `justification`, `toolInput` |
| `budget_alert` | Emitted when a user approaches (80%) or exceeds token budget | `windowType`, `budgetLimit`, `currentUsage`, `percentUsed`, `action` |
| `session_started` | Emitted when a new session begins | `sessionId`, `conversationId` |
| `session_ended` | Emitted when a session expires or is deleted | `sessionId`, `messageCount` |

### Dual Event Hub Topics

By default, all events go to a single Event Hub topic (`EVENT_HUB_NAME`). Optionally, configure a second topic for high-volume analytics events:

- **`neo-logs`** (primary): `operational`, `destructive_action`, `budget_alert`
- **`neo-analytics`** (optional): `tool_execution`, `token_usage`, `skill_invocation`, `session_started`, `session_ended`

Set `EVENT_HUB_ANALYTICS_CONNECTION_STRING` and `EVENT_HUB_ANALYTICS_NAME` in `.env` to enable dual routing. If not configured, all events flow to the primary topic.
