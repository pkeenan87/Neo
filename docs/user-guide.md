# User Guide

This guide covers day-to-day usage of Neo for both regular users (readers) and administrators.

## Table of Contents

- [Getting Started](#getting-started)
  - [Prerequisites](#prerequisites)
  - [First-Time Setup (CLI)](#first-time-setup-cli)
  - [First-Time Setup (Web Server)](#first-time-setup-web-server)
- [Using the CLI](#using-the-cli)
  - [Starting the REPL](#starting-the-repl)
  - [Running Investigations](#running-investigations)
  - [Understanding Tool Calls](#understanding-tool-calls)
  - [Confirming Destructive Actions](#confirming-destructive-actions)
  - [Managing Sessions](#managing-sessions)
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
- [Administration](#administration)
  - [Managing API Keys](#managing-api-keys)
  - [Managing Sessions (Admin)](#managing-sessions-admin)
  - [Starting the Server](#starting-the-server)
  - [Going Live with Azure](#going-live-with-azure)
  - [Monitoring](#monitoring)
- [Reference](#reference)
  - [CLI Commands](#cli-commands)
  - [Tool Reference](#tool-reference)
  - [Role Permissions](#role-permissions)
  - [Rate Limits](#rate-limits)
  - [API Endpoints](#api-endpoints)

---

## Getting Started

### Prerequisites

- Node.js 18 or later
- Access to the Neo web server (URL and API key or Entra ID credentials)
- For admins: access to the server filesystem or deployment pipeline

### First-Time Setup (CLI)

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

### Running Investigations

Neo works like a conversation with a senior SOC analyst. You describe what you want to investigate, and the agent gathers evidence by calling tools autonomously.

```
🔐 You: Are there any high severity incidents from the past week?
```

The agent will:
1. Call `get_sentinel_incidents` to fetch incidents.
2. Analyze the results.
3. Return a summary with recommendations.

You can ask follow-up questions in the same session — the agent remembers the full conversation context.

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

## Administration

### Managing API Keys

API keys are stored in `web/api-keys.json`. The server watches this file and reloads automatically.

**Add a new key**:

1. Generate a secure key:
   ```bash
   openssl rand -base64 24
   ```

2. Edit `web/api-keys.json`:
   ```json
   {
     "keys": [
       {
         "key": "existing-key...",
         "role": "admin",
         "label": "SOC Team Admin"
       },
       {
         "key": "newly-generated-key",
         "role": "reader",
         "label": "Analyst - Jane Doe"
       }
     ]
   }
   ```

3. Save the file. The server picks up changes immediately (no restart needed).

**Revoke a key**: Remove its entry from `api-keys.json` and save.

**Rotate a key**: Replace the `key` value with a new one and distribute the new key to the user.

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
- **Server logs**: Next.js logs requests to stdout. Check the terminal running `npm run dev`.
- **Session inspection**: Use the sessions API endpoint to monitor active sessions and message counts.

---

## Reference

### CLI Commands

| Command | Description |
|---------|-------------|
| `npm start` | Start the CLI REPL |
| `npm run dev` | Start with auto-reload (development) |
| `node src/index.js auth login --api-key <key>` | Save an API key |
| `node src/index.js auth login` | Browser-based Entra ID login (auto-discovers config from server) |
| `node src/index.js auth logout` | Clear Entra ID credentials |
| `node src/index.js auth status` | Show connection and auth status |

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
| `get_user_info` | Look up an Entra ID user: account status, MFA, groups, devices, risk level. | All |
| `reset_user_password` | Force password reset. Optionally revokes all sessions and refresh tokens. Requires confirmation and justification. | Admin |
| `isolate_machine` | Network-isolate a machine via Defender or CrowdStrike. Requires confirmation and justification. | Admin |
| `unisolate_machine` | Release a previously isolated machine. Requires confirmation and justification. | Admin |

### Role Permissions

| Capability | `admin` | `reader` |
|------------|---------|----------|
| Read-only tools | Yes | Yes |
| Destructive tools | Yes (with confirmation) | No |
| View all sessions | Yes | No |
| View own sessions | Yes | Yes |
| Delete any session | Yes | No |
| Delete own sessions | Yes | Yes |
| Message limit per session | 200 | 100 |

### Rate Limits

Each session has a per-role message limit:

| Role | Messages per session |
|------|---------------------|
| `admin` | 200 |
| `reader` | 100 |

When the limit is reached, start a new session by typing `clear` in the CLI.

### API Endpoints

All endpoints require authentication via `Authorization: Bearer <api-key>` header or Auth.js session cookie, except the discovery endpoint.

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/auth/discover` | Unauthenticated. Returns `{ tenantId, clientId }` for CLI Entra ID login. |
| `POST` | `/api/agent` | Send a message to the agent. Returns NDJSON stream. Body: `{ "message": "...", "sessionId?": "..." }` |
| `POST` | `/api/agent/confirm` | Confirm or cancel a pending destructive tool. Body: `{ "sessionId": "...", "toolId": "...", "confirmed": true }` |
| `GET` | `/api/agent/sessions` | List sessions. Admins see all; readers see own. |
| `DELETE` | `/api/agent/sessions` | Delete a session. Body: `{ "sessionId": "..." }` |

**NDJSON stream events** (returned by `/api/agent` and `/api/agent/confirm`):

| Event type | Fields | Description |
|------------|--------|-------------|
| `session` | `sessionId` | Emitted first with the session ID |
| `thinking` | (none) | Agent is processing |
| `tool_call` | `tool`, `input` | Agent is calling a tool |
| `confirmation_required` | `tool: { id, name, input }` | Destructive tool needs user confirmation |
| `response` | `text` | Final agent response |
| `error` | `message`, `code` | An error occurred |
