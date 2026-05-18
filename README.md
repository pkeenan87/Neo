```
    ███╗   ██╗███████╗ ██████╗
    ████╗  ██║██╔════╝██╔═══██╗
    ██╔██╗ ██║█████╗  ██║   ██║
    ██║╚██╗██║██╔══╝  ██║   ██║
    ██║ ╚████║███████╗╚██████╔╝
    ╚═╝  ╚═══╝╚══════╝ ╚═════╝
    [ S E C U R I T Y   A G E N T ]
```

# Neo — AI Security Operations Agent

[![CI](https://github.com/pkeenan87/Neo/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/pkeenan87/Neo/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![CodeQL: security-extended](https://img.shields.io/badge/CodeQL-security--extended-blue)](.github/workflows/ci.yml)
[![Status: active development](https://img.shields.io/badge/status-active%20development-brightgreen)](https://github.com/pkeenan87/Neo/releases)
[![Node >=20](https://img.shields.io/badge/node-%E2%89%A520-339933?logo=node.js&logoColor=white)](https://nodejs.org/en/about/previous-releases)

A Claude-powered SOC analyst agent that investigates security incidents via Microsoft Sentinel, Defender XDR, and Entra ID. It can execute containment actions (password reset, machine isolation) with human confirmation gates.

> **Project status:** Active development. APIs and tool schemas may change between releases. Production deployments should pin to a tagged release.

Neo ships as two independent components:

- **Web Server** — Next.js API backend that runs the Claude agent, manages sessions, and enforces authentication and RBAC.
- **CLI Client** — Terminal REPL that connects to the web server over HTTPS and streams results in real time.

## Project Structure

```
neo/
├── cli/                    # Terminal REPL client
│   ├── package.json
│   └── src/
│       ├── index.js        # CLI entrypoint, REPL loop, auth commands
│       ├── agent.js        # Thin wrapper over server-client
│       ├── server-client.js # HTTP + NDJSON stream reader
│       ├── config.js       # Server URL + auth resolution
│       ├── config-store.js # Encrypted credential store (~/.neo/)
│       └── auth-entra.js   # OAuth2 PKCE login flow
├── web/                    # Next.js API server
│   ├── package.json
│   ├── auth.ts             # Auth.js config (Entra ID + API key)
│   ├── api-keys.json       # API key registry
│   ├── app/
│   │   └── api/
│   │       ├── agent/      # POST /api/agent — agent loop
│   │       │   ├── confirm/ # POST /api/agent/confirm — confirmation gate
│   │       │   └── sessions/ # GET/DELETE /api/agent/sessions
│   │       └── auth/       # Auth.js routes
│   └── lib/
│       ├── agent.ts        # Claude agentic loop
│       ├── tools.ts        # Tool schemas for Claude
│       ├── executors.ts    # Tool implementations (mock + real)
│       ├── permissions.ts  # RBAC roles and tool access
│       ├── session-store.ts # In-memory session management
│       ├── stream.ts       # NDJSON streaming helpers
│       ├── auth-helpers.ts # Request authentication resolver
│       ├── api-key-store.ts # API key lookup with hot-reload
│       ├── context-manager.ts # Context window management (truncation + compression)
│       ├── injection-guard.ts # Prompt injection scanner + trust boundary wrapper
│       ├── logger.ts       # Structured logger (console + Azure Event Hub)
│       └── config.ts       # Server environment config
├── docs/                   # Documentation
│   ├── configuration.md    # Configuration guide
│   └── user-guide.md       # User and admin guide
├── .env                    # Environment variables
└── CLAUDE.md               # AI assistant instructions
```

## Quick Start

### 1. Start the Web Server

```bash
cd web
npm install
cp .env.example .env       # Or create .env with your ANTHROPIC_API_KEY
npm run dev                 # Starts on http://localhost:3000
```

Set `MOCK_MODE=true` (default) to test without Azure credentials.

### 2. Connect the CLI

```bash
cd cli
npm install

# Authenticate with an API key
node src/index.js auth login --api-key <your-api-key>

# Or set it as an environment variable
export NEO_API_KEY=<your-api-key>

# Start the REPL
npm start
```

See [docs/configuration.md](docs/configuration.md) for Entra ID setup and all configuration options.

## Example Prompts

```
"Show me any high severity incidents from the last 24 hours"

"Investigate suspicious logins for jsmith@contoso.com"

"Search for alerts on LAPTOP-JS4729 in Defender"

"The MDR team flagged jsmith@contoso.com for a TOR login — investigate and contain if confirmed"

"Isolate LAPTOP-JS4729 from the network, it looks compromised"

"Reset the password for bwilliams@contoso.com and revoke their sessions"
```

## Available Tools

| Tool | Type | Description |
|------|------|-------------|
| `run_sentinel_kql` | Read-only | Execute KQL queries against Sentinel |
| `get_sentinel_incidents` | Read-only | List recent incidents with filters |
| `get_xdr_alert` | Read-only | Get full alert details from Defender/CrowdStrike |
| `search_xdr_by_host` | Read-only | Search alerts by hostname |
| `get_machine_isolation_status` | Read-only | Check real-time isolation status and health of a machine via Defender |
| `search_user_messages` | Read-only | Search a user's Exchange mailbox for messages by sender, subject, or content |
| `get_user_info` | Read-only | Look up Entra ID user details and risk |
| `get_full_tool_result` | Read-only | Retrieve full content of a previously truncated tool result |
| `reset_user_password` | Destructive | Force password reset + session revocation |
| `dismiss_user_risk` | Destructive | Dismiss user risk in Entra ID Identity Protection |
| `list_ca_policies` | Read-only | List all Conditional Access policies |
| `get_ca_policy` | Read-only | Get CA policy details by ID |
| `list_named_locations` | Read-only | List named locations (IP ranges, countries) for CA |
| `isolate_machine` | Destructive | Network-isolate an endpoint |
| `unisolate_machine` | Destructive | Release an isolated machine |
| `report_message_as_phishing` | Destructive | Report a message as phishing/junk in a user's mailbox |
| `list_threatlocker_approvals` | Read-only | List ThreatLocker application approval requests |
| `get_threatlocker_approval` | Read-only | Get full details of a ThreatLocker approval request |
| `approve_threatlocker_request` | Destructive | Approve a ThreatLocker application approval request |
| `deny_threatlocker_request` | Destructive | Deny a ThreatLocker application approval request |
| `search_threatlocker_computers` | Read-only | Search ThreatLocker computers by hostname/username/IP |
| `get_threatlocker_computer` | Read-only | Get ThreatLocker computer details and current mode |
| `set_maintenance_mode` | Destructive | Set a computer's ThreatLocker maintenance mode |
| `schedule_bulk_maintenance` | Destructive | Schedule maintenance on multiple ThreatLocker computers |
| `enable_secured_mode` | Destructive | Return ThreatLocker computers to secured mode |
| `block_indicator` | Destructive | Block a domain, IP, URL, or file hash in Defender for Endpoint |
| `import_indicators` | Destructive | Batch import up to 500 indicators into Defender |
| `list_indicators` | Read-only | List current custom indicators in Defender |
| `delete_indicator` | Destructive | Delete a custom indicator from Defender by ID |
| `get_vendor_risk` | Read-only | Assess vendor email compromise risk via Abnormal Security |
| `list_vendors` | Read-only | List all vendors with risk levels |
| `get_vendor_activity` | Read-only | Get vendor event timeline with suspicious activity |
| `list_vendor_cases` | Read-only | List vendor compromise cases |
| `get_vendor_case` | Read-only | Get full vendor case details with insights |
| `get_employee_profile` | Read-only | Get employee org context and behavioral baseline (Genome) |
| `get_employee_login_history` | Read-only | Get employee 30-day login history |
| `list_abnormal_threats` | Read-only | List recent email threats from Abnormal Security |
| `get_abnormal_threat` | Read-only | Get full email threat details with attack analysis |
| `list_ato_cases` | Read-only | List Account Takeover cases from Abnormal Security |
| `get_ato_case` | Read-only | Get full ATO case with analysis timeline |
| `action_ato_case` | Destructive | Take action on an ATO case (acknowledge/action required) |
| `list_appomni_services` | Read-only | List monitored SaaS services with posture scores and user counts |
| `get_appomni_service` | Read-only | Get detailed metadata and policy posture for a monitored service |
| `list_appomni_findings` | Read-only | List posture findings (policy violations + insights) across SaaS estate |
| `get_appomni_finding` | Read-only | Get full finding details with compliance controls and occurrences |
| `list_appomni_finding_occurrences` | Read-only | List individual violation instances with user/resource context |
| `list_appomni_insights` | Read-only | List data exposure and risk insights from AppOmni |
| `list_appomni_policy_issues` | Read-only | List open policy issues (rule violations) from posture scans |
| `list_appomni_identities` | Read-only | List unified identities across SaaS services with permission levels |
| `get_appomni_identity` | Read-only | Get unified identity profile with all linked SaaS accounts |
| `list_appomni_discovered_apps` | Read-only | List discovered SaaS apps with review status and criticality |
| `get_appomni_audit_logs` | Read-only | Retrieve AppOmni platform audit logs |
| `action_appomni_finding` | Destructive | Update finding occurrence status or close by exception |

Read-only tools execute automatically. Destructive tools pause for human confirmation before executing.

## Context Window Management

Neo automatically manages the Claude API's 200K token context window to prevent failures during long investigations:

- **Per-tool-result cap**: Individual tool results exceeding 50K tokens are truncated with a notice. The agent can retrieve the full result via `get_full_tool_result`.
- **Rolling compression**: When the conversation approaches 160K tokens, older messages are summarized by Claude Haiku and replaced with a compact summary, preserving the most recent messages.
- **Token tracking**: Uses the API's `usage.input_tokens` field for accurate context size tracking after each turn, with a character-count heuristic as fallback for the first call.

## Roles

| Role | Read-only tools | Destructive tools | Session visibility |
|------|----------------|-------------------|--------------------|
| `admin` | All | All (with confirmation) | All sessions |
| `reader` | All | Blocked | Own sessions only |

## Security

Neo includes defense-in-depth protections against prompt injection — attempts to manipulate the agent via message content or adversarial data in external API responses.

- **Input scanning** — All user messages (web API and Teams) are scanned against regex patterns that detect instruction overrides, persona reassignment, privilege claims, gate bypass attempts, and jailbreak phrases. In `monitor` mode (default) detections are logged; in `block` mode messages with 2+ pattern matches are rejected.
- **Tool result wrapping** — Every tool response is wrapped in a `_neo_trust_boundary` envelope that instructs the model to treat the data as untrusted. A separate pattern scan detects injected directives in API responses and flags them.
- **System prompt hardening** — The system prompt includes explicit security principles that instruct the model to reject social engineering, never skip the confirmation gate, and flag injection attempts in its response.
- **Structured audit logging** — All injection detections are logged to the Event Hub audit trail with session, role, and pattern metadata (never raw message content).

Set `INJECTION_GUARD_MODE=monitor` (default) or `block` in `.env`. See [Configuration Guide](docs/configuration.md#prompt-injection-guard) for details.

## Authentication

The web server supports two authentication methods:

- **API Key** — Bearer token in the `Authorization` header. Keys and roles are defined in `web/api-keys.json`.
- **Microsoft Entra ID** — OAuth2 via Auth.js. Role is determined by Entra ID app roles.

The CLI supports both methods and stores credentials encrypted at `~/.neo/config.json`.

See [docs/configuration.md](docs/configuration.md) for setup instructions.

## Architecture

![Neo architecture: a User Interface layer (CLI client and web dashboard) talks NDJSON over HTTPS to a Core Agent Backend on Next.js App Router (agent loop, context manager, tool execution engine, integration registry) that persists conversation state, custom skills, and usage telemetry to Azure Cosmos DB and dispatches to Microsoft Sentinel, Defender XDR, Entra ID, Abnormal Security, Lansweeper, ThreatLocker, and AppOmni — with the agent loop calling the Anthropic Claude API for inference](docs/images/architecture.png)

Neo is organised into four layers:

- **User interface** — a Node.js CLI client (Entra ID auth, terminal streaming) and a Next.js admin dashboard (admin tasks, session management). Both speak HTTPS + NDJSON to the backend.
- **Core agent backend** — Next.js App Router hosting the iterative reasoning API: the **agent loop** (Claude orchestrator that determines intent), the **context manager** (rolling history compression + token-window optimisation), the **tool execution engine** (translates agent intents into KQL / REST / Graph calls), and the **integration registry** (API keys and secrets for multi-platform support).
- **Persistence** — Azure Cosmos DB stores conversation state (v2 schema), custom skills, and per-user usage telemetry. Pessimistic budget reservations enforce 2-hour and weekly token windows before each agent loop runs.
- **Integrations** — the Microsoft stack (Sentinel SIEM/KQL, Defender XDR, Entra ID / Graph) plus security vendors (Abnormal Security email, Lansweeper assets, ThreatLocker zero-trust, AppOmni SaaS). The agent loop calls the Anthropic Claude API directly for inference.

The CLI is a thin client. All agent logic, tool execution, credential management, and prompt-injection guarding happen server-side.

## Documentation

- [Configuration Guide](docs/configuration.md) — Environment variables, API keys, Entra ID setup, CLI config
- [User Guide](docs/user-guide.md) — Step-by-step instructions for users and admins
- [Architecture](ARCHITECTURE.md) — System design and component responsibilities
- [Security Policy](SECURITY.md) — How to report vulnerabilities

## Releases

Releases are tagged independently per surface:

- **CLI** releases will use the `cli-vMAJOR.MINOR.PATCH` tag prefix. Signed Windows installers are produced today by running `npm run release` locally on Windows (see [CLAUDE.md](CLAUDE.md#commands)); automated build + upload to GitHub Releases is planned.
- **Web** releases will use the `web-vMAJOR.MINOR.PATCH` tag prefix and serve as deployment markers for the Azure App Service deploy.

See the [Releases page](https://github.com/pkeenan87/Neo/releases) for changelogs and downloads.

## Contributing

Issues and pull requests are welcome. Before opening a PR:

1. Run `MOCK_MODE=true` and verify your change works against the mock executors.
2. For new tools, follow the pattern in [CLAUDE.md](CLAUDE.md#adding-a-new-tool-cli) — add the schema, mark destructive tools, and provide both mock and real implementations.
3. CI will run typecheck, lint, tests, `npm audit`, CodeQL (security-extended), and gitleaks. Address any failures before requesting review.

For security issues, **do not open a public issue** — see [SECURITY.md](SECURITY.md) for the disclosure process.

## Going Live

1. Set `MOCK_MODE=false` in `.env`
2. Fill in Azure credentials in `.env`
3. Replace mock implementations in `web/lib/executors.ts` — each function has a `REAL IMPLEMENTATION` comment block

### Required Azure App Registration Permissions

| API | Permission | Type |
|-----|------------|------|
| Log Analytics API | Data.Read | Application |
| Microsoft Graph | User.ReadWrite.All | Application |
| Microsoft Graph | Directory.ReadWrite.All | Application |
| Microsoft Graph | ThreatHunting.Read.All | Application |
| Defender for Endpoint | Machine.Isolate | Application |
| Defender for Endpoint | Machine.ReadWrite.All | Application |
| Sentinel (ARM) | Microsoft Sentinel Reader | Role (RBAC) |

## Commands

### CLI REPL

| Command | Description |
|---------|-------------|
| `clear` | Reset conversation (starts new server session) |
| `exit` | Quit the CLI |
| `yes` | Confirm a destructive action |
| anything else | Cancel a destructive action |

### CLI Auth

| Command | Description |
|---------|-------------|
| `node src/index.js auth login --api-key <key>` | Save API key |
| `node src/index.js auth login` | Entra ID browser login (auto-discovers config) |
| `node src/index.js auth logout` | Clear Entra ID credentials |
| `node src/index.js auth status` | Show connection and auth status |
