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
  - [Settings](#settings)
  - [Debugging](#debugging)
- [Common Tasks — Reader](#common-tasks--reader)
  - [Triage Incidents](#triage-incidents)
  - [Investigate a User](#investigate-a-user)
  - [Investigate a Host](#investigate-a-host)
  - [Run a Custom KQL Query](#run-a-custom-kql-query)
  - [Multi-Step Investigation](#multi-step-investigation)
- [Common Tasks — Admin](#common-tasks--admin)
  - [Contain a Compromised Account](#contain-a-compromised-account)
  - [Isolate a Machine](#isolate-a-machine)
  - [Release an Isolated Machine](#release-an-isolated-machine)
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

### Model Selection

Neo supports two Claude models. You can choose between them per-session:

- **Sonnet** (default) — Fast, cost-effective, and capable for most investigations.
- **Opus** — Most capable model for complex multi-step reasoning.

In the web UI, select your preferred model before starting a conversation (model selection UI coming soon). Via the API, pass `"model": "claude-opus-4-6"` in the request body to use Opus; omit it to use Sonnet (the default). You can check your current token usage on the [Settings](#settings) page under the Usage tab.

The model preference applies for the duration of the session and does not affect other users.

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
| `search_user_messages` | Search a user's Exchange Online mailbox for messages by sender, subject, body content, or date range. Returns message IDs needed for reporting. Requires confirmation. | Admin |
| `get_user_info` | Look up an Entra ID user: account status, MFA, groups, devices, risk level. | All |
| `get_full_tool_result` | Retrieve the full, untruncated content of a previous tool result that was truncated to fit the context window. | All |
| `reset_user_password` | Force password reset. Optionally revokes all sessions and refresh tokens. Requires confirmation and justification. | Admin |
| `dismiss_user_risk` | Dismiss risk state for a user in Entra ID Identity Protection. Re-enables login for users blocked by conditional access risk policies. Requires confirmation. | Admin |
| `isolate_machine` | Network-isolate a machine via Defender or CrowdStrike. Requires confirmation and justification. | Admin |
| `unisolate_machine` | Release a previously isolated machine. Requires confirmation and justification. | Admin |
| `report_message_as_phishing` | Report a message in a user's mailbox as phishing or junk via Microsoft Graph. Requires confirmation and justification. | Admin |
| `list_threatlocker_approvals` | List ThreatLocker application approval requests with optional status and search filters. | All |
| `get_threatlocker_approval` | Get full details of a specific ThreatLocker approval request by ID. | All |
| `approve_threatlocker_request` | Approve a ThreatLocker application approval request. Requires confirmation and justification. | Admin |
| `deny_threatlocker_request` | Deny (ignore) a ThreatLocker application approval request. Requires confirmation and justification. | Admin |

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
