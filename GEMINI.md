# GEMINI.md - Neo AI Security Agent

This project, **Neo**, is a Claude-powered AI Security Operations Center (SOC) analyst agent designed to investigate and contain security incidents using Microsoft Sentinel, Defender XDR, and Entra ID.

## Project Overview

Neo follows a client-server architecture:
- **Web Server (`/web`):** A Next.js API backend that runs the Claude agent loop, manages sessions, enforces RBAC, and executes tool logic (both mock and real Azure/Microsoft APIs).
- **CLI Client (`/cli`):** A terminal-based REPL that connects to the web server via HTTPS/NDJSON to provide a real-time investigation interface.

### Key Technologies
- **AI:** Claude (Anthropic SDK) using Sonnet or Opus models.
- **Frontend/Backend:** Next.js (App Router), React, TypeScript, Tailwind CSS v4.
- **Security Context:** Microsoft Sentinel (KQL), Defender XDR, Microsoft Graph API.
- **Authentication:** Auth.js (Entra ID), API Keys, OAuth2 PKCE.
- **Data Persistence:** Azure Cosmos DB (usage tracking), encrypted local config for CLI.

## Building and Running

### Environment Setup
1. Copy `.env.example` to `.env` in the root directory.
2. Set `ANTHROPIC_API_KEY`.
3. Set `MOCK_MODE=true` to test without Azure credentials, or `false` for live API integration.

### Web Server
```bash
cd web
npm install
npm run dev   # Starts on http://localhost:3000
```

### CLI Client
```bash
cd cli
npm install
# Login via API key
node src/index.js auth login --api-key <key>
# Start REPL
npm start
```

## Development Conventions

### General
- **Mock/Real Dual Path:** Every tool executor must check `process.env.MOCK_MODE` and provide a mock implementation for development without Azure access.
- **Confirmation Gates:** "Destructive" tools (e.g., `isolate_machine`, `reset_user_password`) must be registered in the destructive tools set to trigger a human confirmation prompt before execution.

### Web (Next.js & React)
- **Tailwind v4 + CSS Modules:** Follow the **3-class rule**: max 3 Tailwind classes inline. If a 4th is needed, extract all to a CSS Module using `@apply`.
- **CSS Modules Reference:** Every `.module.css` using `@apply` must start with `@reference "../../app/globals.css";`.
- **Component Structure:** Each component has its own folder with an `index.ts` barrel export. Always import from `@/components`.
- **TypeScript:** No `any`. Use strict typing for props and state.

### CLI
- **ES Modules:** All source files use `"type": "module"`.
- **Streaming:** Uses NDJSON for real-time response streaming from the server.
- **Colors:** Use `chalk` for terminal styling according to established color patterns (e.g., tool colors).

## Key Files & Directories
- `web/lib/agent.ts`: Core Claude agentic loop and tool integration logic.
- `web/lib/executors.ts`: Implementation of security tools (KQL queries, Graph actions).
- `web/lib/context-manager.ts`: Manages the 200K token window via truncation and rolling compression.
- `cli/src/index.js`: Main entry point for the terminal REPL.
- `CLAUDE.md`: Detailed technical instructions for AI assistants.
- `docs/`: Comprehensive guides for configuration and usage.
