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

A Claude-powered SOC analyst agent that investigates security incidents via Microsoft Sentinel, Defender XDR, and Entra ID. It can execute containment actions (password reset, machine isolation) with human confirmation gates.

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
| `search_user_messages` | Destructive | Search a user's Exchange mailbox for messages (reads any mailbox — admin only) |
| `get_user_info` | Read-only | Look up Entra ID user details and risk |
| `get_full_tool_result` | Read-only | Retrieve full content of a previously truncated tool result |
| `reset_user_password` | Destructive | Force password reset + session revocation |
| `dismiss_user_risk` | Destructive | Dismiss user risk in Entra ID Identity Protection |
| `isolate_machine` | Destructive | Network-isolate an endpoint |
| `unisolate_machine` | Destructive | Release an isolated machine |
| `report_message_as_phishing` | Destructive | Report a message as phishing/junk in a user's mailbox |
| `list_threatlocker_approvals` | Read-only | List ThreatLocker application approval requests |
| `get_threatlocker_approval` | Read-only | Get full details of a ThreatLocker approval request |
| `approve_threatlocker_request` | Destructive | Approve a ThreatLocker application approval request |
| `deny_threatlocker_request` | Destructive | Deny a ThreatLocker application approval request |
| `block_indicator` | Destructive | Block a domain, IP, URL, or file hash in Defender for Endpoint |
| `import_indicators` | Destructive | Batch import up to 500 indicators into Defender |
| `list_indicators` | Read-only | List current custom indicators in Defender |
| `delete_indicator` | Destructive | Delete a custom indicator from Defender by ID |

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

```
┌──────────┐     NDJSON/HTTPS      ┌──────────────┐      ┌─────────────────┐
│  CLI     │ ──────────────────→  │  Web Server  │ ───→ │  Claude API     │
│  (REPL)  │ ←────────────────── │  (Next.js)   │ ←─── │  (Opus 4.5)     │
└──────────┘  streaming events    │              │      └─────────────────┘
                                  │              │ ───→ Microsoft Sentinel
                                  │              │ ───→ Defender XDR
                                  │              │ ───→ Entra ID / Graph
                                  └──────────────┘
```

The CLI is a thin client. All agent logic, tool execution, and credential management for Azure APIs happens on the server.

## Documentation

- [Configuration Guide](docs/configuration.md) — Environment variables, API keys, Entra ID setup, CLI config
- [User Guide](docs/user-guide.md) — Step-by-step instructions for users and admins

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
