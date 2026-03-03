# Next.js API Layer

> Wrap the existing CLI security agent (`src/`) in a Next.js application that exposes the agentic loop as a server-side API, enabling a future web UI and third-party integrations.

## Problem

The security agent currently runs only as a local CLI REPL. There is no way to invoke it from a browser, webhook, or external service. Standing up a Next.js API layer unlocks a web-based SOC dashboard and programmatic access without rewriting the core agent logic.

## Goals

- Expose the existing agentic loop (`agent.js`) through Next.js API routes
- Preserve the confirmation gate pattern for destructive tools — the API must not auto-execute destructive actions
- Support streaming responses so the client can show tool calls and thinking state in real time
- Keep the CLI fully functional alongside the new API (shared core, two entry points)
- Follow the Next.js / React / TypeScript conventions defined in CLAUDE.md

## Non-Goals

- Building the frontend UI (that is a separate feature)
- Replacing the CLI — it remains an independent entry point
- Adding authentication/authorization to the API (will be a follow-up feature)
- Migrating the existing `src/` JS files to TypeScript (consume them as-is)

## User Stories

1. **As a developer**, I can `POST /api/agent` with a message and receive a streamed response containing tool calls and the final agent reply.
2. **As a developer**, when the agent hits a destructive tool, the API returns a `confirmation_required` payload instead of executing, and I can `POST /api/agent/confirm` to approve or cancel.
3. **As a developer**, I can manage conversation sessions so that multi-turn investigations persist across requests.
4. **As a developer**, I can run `npm run dev` and have both the Next.js dev server and the original CLI available.

## Proposed Architecture

### Project Structure

```
neo/
  src/                     ← existing CLI agent (unchanged)
    agent.js
    tools.js
    executors.js
    config.js
    auth.js
    index.js               ← CLI entry point
  app/                     ← new Next.js app directory
    layout.tsx
    page.tsx               ← minimal landing page (placeholder)
    api/
      agent/
        route.ts           ← POST: send message, streamed response
        confirm/
          route.ts         ← POST: confirm or cancel destructive action
        sessions/
          route.ts         ← GET/DELETE: list or clear sessions
  lib/
    agent-bridge.ts        ← TypeScript wrapper around src/agent.js
    session-store.ts       ← In-memory conversation session management
    types.ts               ← Shared TypeScript interfaces
  next.config.js
  tsconfig.json
  tailwind.config.ts
```

### Key Design Decisions

1. **Agent bridge pattern** — `lib/agent-bridge.ts` imports and wraps the existing ES module agent (`src/agent.js`) so the Next.js API routes interact with a typed interface rather than raw JS. This avoids rewriting the agent while providing type safety at the boundary.

2. **Session management** — Conversation history is stored in-memory keyed by session ID. The client sends a session ID with each request. Sessions have a configurable TTL.

3. **Streaming via Server-Sent Events** — The `POST /api/agent` route streams events as they happen: `tool_call`, `thinking`, `confirmation_required`, and `response`. This mirrors the CLI callbacks (`onToolCall`, `onThinking`).

4. **Confirmation flow over HTTP** — When a destructive tool is encountered, the stream emits a `confirmation_required` event with the pending tool details and pauses. The client then calls `POST /api/agent/confirm` with the session ID and a `confirmed: boolean` to resume.

### API Shape

**POST /api/agent**
```
Request:  { sessionId?: string, message: string }
Response: SSE stream with events:
  - { type: "session", sessionId: string }
  - { type: "thinking" }
  - { type: "tool_call", tool: string, input: object }
  - { type: "confirmation_required", tool: { id, name, input } }
  - { type: "response", text: string }
  - { type: "error", message: string }
```

**POST /api/agent/confirm**
```
Request:  { sessionId: string, toolId: string, confirmed: boolean }
Response: SSE stream (same event types as above)
```

**GET /api/agent/sessions**
```
Response: { sessions: [{ id, createdAt, messageCount }] }
```

**DELETE /api/agent/sessions/:id**
```
Response: { deleted: true }
```

## Open Questions

- Should sessions persist across server restarts (e.g., Redis or SQLite), or is in-memory sufficient for v1? in memory is sufficient
- Should the API enforce rate limiting on agent calls given the Claude API cost? Yes, set session limits that would match a claude max plan.
- What is the maximum session history length before truncation? match what claude max currently does

## Success Criteria

- [ ] `POST /api/agent` accepts a message and streams back tool calls + final response
- [ ] Destructive tools pause the stream and require explicit confirmation via `/api/agent/confirm`
- [ ] Conversation history persists across multiple requests within the same session
- [ ] The existing CLI (`npm start`) continues to work unchanged
- [ ] All new code follows the TypeScript and Next.js conventions in CLAUDE.md
