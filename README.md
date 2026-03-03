# Security Agent CLI

Claude-powered SOC analyst agent for the terminal. Investigates incidents via Sentinel KQL, XDR, and Entra ID — and can execute containment actions (password reset, machine isolation) with confirmation gates.

## Quick Start

```bash
npm install
cp .env.example .env
# Add your ANTHROPIC_API_KEY to .env (leave MOCK_MODE=true to test)
npm start
```

## Example Prompts

```
# Triage
"Show me any high severity incidents from the last 24 hours"

# User investigation
"Investigate suspicious logins for jsmith@goodwin.com"

# Host investigation  
"Search for alerts on LAPTOP-JS4729 in Defender"

# Chained investigation (Claude runs multiple tools autonomously)
"The MDR team flagged jsmith@goodwin.com for a TOR login — investigate and contain if confirmed"

# Explicit containment
"Isolate LAPTOP-JS4729 from the network, it looks compromised"
"Reset the password for bwilliams@goodwin.com and revoke their sessions"
```

## Architecture

```
src/
  index.js     ← CLI REPL, confirmation prompts, color output
  agent.js     ← Agentic loop + confirmation resume logic
  tools.js     ← Tool schemas passed to Claude
  executors.js ← Tool implementations (mock + real stubs)
  config.js    ← Env vars + system prompt
```

## Agentic Loop Flow

```
User message
    ↓
Claude (with tools)
    ↓ stop_reason: "tool_use"
Execute tools (auto for read-only)
    ↓ DESTRUCTIVE tool?
    → Return to CLI for confirmation
    ↓ confirmed/cancelled
Resume loop with tool result
    ↓ stop_reason: "end_turn"
Final response
```

## Going Live

1. Set `MOCK_MODE=false` in `.env`
2. Fill in Azure credentials
3. Replace mock implementations in `executors.js` — each function has a `REAL IMPLEMENTATION` comment block with the actual API calls

### Required Azure App Registration Permissions

| API                    | Permission               | Type        |
|------------------------|--------------------------|-------------|
| Log Analytics API      | Data.Read                | Application |
| Microsoft Graph        | User.ReadWrite.All       | Application |
| Microsoft Graph        | Directory.ReadWrite.All  | Application |
| Defender for Endpoint  | Machine.Isolate          | Application |
| Defender for Endpoint  | Machine.ReadWrite.All    | Application |
| Sentinel (ARM)         | Microsoft Sentinel Reader | Role (RBAC) |

## Commands

| Command | Description |
|---------|-------------|
| `clear` | Reset conversation history |
| `exit`  | Quit the CLI |
| `yes`   | Confirm a destructive action |
| anything else | Cancel a destructive action |
