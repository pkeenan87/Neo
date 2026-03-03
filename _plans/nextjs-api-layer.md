# Next.js API Layer

## Context

This plan implements a Next.js application that wraps the existing CLI security agent (`src/agent.js`) as a server-side API with SSE streaming, in-memory session management, and an HTTP-based confirmation gate for destructive tools. The existing CLI remains unchanged — the new layer imports and bridges to the existing ES module agent. All new code is TypeScript and follows the conventions in CLAUDE.md.

---

## Key Design Decisions

- **Bridge pattern over rewrite** — `lib/agent-bridge.ts` imports `src/agent.js` and `src/tools.js` directly via relative paths. The existing JS files are not converted to TypeScript; type safety is enforced at the bridge boundary only.
- **SSE streaming via ReadableStream** — Each API route returns a `Response` with a `ReadableStream` that encodes events as `text/event-stream`. This uses the Web Streams API built into Next.js App Router route handlers — no third-party SSE library needed.
- **In-memory session store with TTL** — Sessions are stored in a `Map<string, Session>` with a 30-minute idle TTL. A `setInterval` sweep cleans expired sessions. No persistence across restarts for v1.
- **Pending confirmation stored on session** — When the agent loop returns `confirmation_required`, the pending tool payload and in-progress message history are saved on the session object. The `/api/agent/confirm` route reads them back to resume.
- **Rate limiting via simple per-session counter** — Each session tracks message count. Requests beyond a configurable limit (default: 100 messages per session, matching Claude Max-level usage) return a 429 status.
- **Next.js config with `serverExternalPackages`** — The `@anthropic-ai/sdk` and `dotenv` packages need to be excluded from Next.js bundling since they're Node-only. Use `serverExternalPackages` in `next.config.js`.
- **Separate npm scripts** — `npm start` continues to run the CLI. `npm run dev:web` runs the Next.js dev server. `npm run dev` keeps its current behavior (CLI with --watch).

---

## Files to Change

| File | Change |
|------|--------|
| `package.json` | Add `next`, `react`, `react-dom`, `typescript`, `@types/react`, `@types/node` as dependencies. Add `dev:web`, `build:web`, `start:web` scripts. |
| `next.config.js` | New file. Minimal config with `serverExternalPackages` for `@anthropic-ai/sdk` and `dotenv`. |
| `tsconfig.json` | New file. Standard Next.js tsconfig with `@/` path alias pointing to project root, `jsx: "preserve"`, strict mode, include `app/` and `lib/`. Exclude `src/` from TS compilation. |
| `tailwind.config.ts` | New file. Minimal Tailwind config scanning `app/**/*.tsx` and `components/**/*.tsx`. Include 8pt spacing scale and placeholder brand color tokens per CLAUDE.md conventions. |
| `app/globals.css` | New file. Tailwind directives (`@tailwind base/components/utilities`). |
| `app/layout.tsx` | New file. Root layout with html/body, font setup via `next/font`, and globals.css import. Server component. |
| `app/page.tsx` | New file. Minimal placeholder page — project name and a note that this is the API backend. Server component. |
| `lib/types.ts` | New file. TypeScript interfaces: `AgentEvent` (union of all SSE event types), `Session`, `SessionMeta`, `AgentRequest`, `ConfirmRequest`. |
| `lib/session-store.ts` | New file. `SessionStore` class: `create()`, `get()`, `delete()`, `list()`, `cleanup()`. In-memory Map with TTL sweep. Stores conversation messages, pending confirmation tool, creation time, and message count. |
| `lib/agent-bridge.ts` | New file. Typed wrapper that imports `runAgentLoop` and `resumeAfterConfirmation` from `src/agent.js`, and `DESTRUCTIVE_TOOLS` from `src/tools.js`. Provides `streamAgentResponse()` and `streamConfirmation()` functions that accept a `WritableStreamDefaultWriter` and push SSE-formatted events via the callback hooks. |
| `app/api/agent/route.ts` | New file. `POST` handler: parse JSON body, resolve or create session, call `streamAgentResponse()` from the bridge, return SSE `Response`. Enforce rate limit. |
| `app/api/agent/confirm/route.ts` | New file. `POST` handler: parse JSON body, look up session and its pending tool, call `streamConfirmation()` from the bridge, return SSE `Response`. Return 400 if no pending confirmation. |
| `app/api/agent/sessions/route.ts` | New file. `GET` handler: return list of active sessions with metadata. `DELETE` handler: accept `sessionId` in body or query, delete from store. |

---

## Implementation Steps

### 1. Install dependencies and configure Next.js

- Run `npm install next react react-dom typescript @types/react @types/node`
- Add scripts to `package.json`: `"dev:web": "next dev"`, `"build:web": "next build"`, `"start:web": "next start"`
- Create `next.config.js` with `serverExternalPackages: ["@anthropic-ai/sdk", "dotenv"]` and `experimental.esmExternals: true` so Next.js can import the existing ESM files in `src/`
- Create `tsconfig.json` with `paths: { "@/*": ["./*"] }`, strict mode, and `include: ["app", "lib", "next-env.d.ts"]` — explicitly do not include `src/`
- Create `tailwind.config.ts` with content paths for `app/` and `components/`, the 8pt spacing scale (2/4/8/16/32 mapping to 0.5/1/2/4/8rem), and placeholder `brand` color tokens
- Create `app/globals.css` with Tailwind directives

### 2. Create the shared type definitions

- In `lib/types.ts`, define:
  - `AgentEventType` — union literal: `"session" | "thinking" | "tool_call" | "confirmation_required" | "response" | "error"`
  - `AgentEvent` — discriminated union with a `type` field and corresponding data for each event type
  - `Session` — contains `id: string`, `messages: Array<{role: string, content: unknown}>`, `createdAt: number`, `lastActivityAt: number`, `messageCount: number`, `pendingConfirmation: { id: string, name: string, input: Record<string, unknown> } | null`
  - `SessionMeta` — subset of Session for listing: `id`, `createdAt`, `messageCount`
  - `AgentRequest` — `{ sessionId?: string, message: string }`
  - `ConfirmRequest` — `{ sessionId: string, toolId: string, confirmed: boolean }`

### 3. Build the session store

- In `lib/session-store.ts`, create a `SessionStore` class (singleton pattern via module-level instance export)
- `create()`: generate a random session ID (crypto.randomUUID), initialize a Session object, store in Map, return the ID
- `get(id)`: return the session if it exists and is not expired, update `lastActivityAt`
- `delete(id)`: remove from Map
- `list()`: return array of `SessionMeta` for all non-expired sessions
- `setPendingConfirmation(id, tool)`: store the pending destructive tool on the session
- `clearPendingConfirmation(id)`: clear the pending tool after confirmation/cancellation
- Constructor starts a `setInterval` (every 60 seconds) that removes sessions where `Date.now() - lastActivityAt > TTL_MS` (TTL_MS = 30 minutes)
- Export a singleton instance: `export const sessionStore = new SessionStore()`
- Add a `SESSION_MESSAGE_LIMIT` constant (100) and a method `isRateLimited(id)` that checks `messageCount >= SESSION_MESSAGE_LIMIT`

### 4. Build the agent bridge

- In `lib/agent-bridge.ts`, import `runAgentLoop` and `resumeAfterConfirmation` from `../src/agent.js` and `DESTRUCTIVE_TOOLS` from `../src/tools.js`
- Add a JSDoc `@ts-expect-error` or type declaration (`declare module`) for the JS imports so TypeScript doesn't error on untyped modules — create a `lib/src-modules.d.ts` declaration file that types the exports of `src/agent.js` and `src/tools.js`
- Define `streamAgentResponse(sessionId: string, message: string, writer: WritableStreamDefaultWriter)`:
  - Get or create session from sessionStore
  - Push a `session` event with the session ID
  - Append the user message to the session's message history
  - Increment message count; check rate limit and send `error` event if exceeded
  - Call `runAgentLoop(session.messages, callbacks)` where callbacks are:
    - `onThinking`: push a `thinking` event
    - `onToolCall(name, input)`: push a `tool_call` event
  - If the result type is `confirmation_required`: save the pending tool on the session via `sessionStore.setPendingConfirmation()`, push a `confirmation_required` event, then close the writer
  - If the result type is `response`: update `session.messages` with the returned messages, push a `response` event with the text, then close the writer
  - Wrap the whole body in try/catch — on error, push an `error` event and close the writer
- Define `streamConfirmation(sessionId: string, confirmed: boolean, writer: WritableStreamDefaultWriter)`:
  - Get the session and its pending confirmation from sessionStore
  - Clear the pending confirmation
  - Call `resumeAfterConfirmation(session.messages, pendingTool, confirmed, callbacks)` with the same callback pattern
  - Handle the result the same way as `streamAgentResponse` (may return another `confirmation_required` or a final `response`)

### 5. Create the SSE helper

- In `lib/agent-bridge.ts` (or a small `lib/sse.ts` helper), define a function `encodeSSE(event: AgentEvent): Uint8Array` that formats an event as `data: ${JSON.stringify(event)}\n\n` and encodes to UTF-8
- This is used by the bridge functions to write events to the stream writer

### 6. Implement the agent API route

- In `app/api/agent/route.ts`, export an async `POST` function:
  - Parse the request body as JSON, validate it matches `AgentRequest` (has `message` string)
  - Return 400 if `message` is missing or empty
  - Create a `TransformStream`, get the `writable` writer
  - Call `streamAgentResponse()` with the session ID (or undefined to create new), the message, and the writer — do NOT await it; let it run while the response streams
  - Return `new Response(readable, { headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", "Connection": "keep-alive" } })`

### 7. Implement the confirm API route

- In `app/api/agent/confirm/route.ts`, export an async `POST` function:
  - Parse body as `ConfirmRequest`, validate `sessionId` and `confirmed` are present
  - Look up the session — return 404 if not found
  - Check for pending confirmation — return 400 if none
  - Create a `TransformStream`, call `streamConfirmation()`, return the SSE response

### 8. Implement the sessions API route

- In `app/api/agent/sessions/route.ts`:
  - `GET`: call `sessionStore.list()`, return JSON array of session metadata
  - `DELETE`: read `sessionId` from request body or URL search params, call `sessionStore.delete()`, return `{ deleted: true }` or 404 if not found

### 9. Create the minimal app shell

- `app/layout.tsx`: root layout as a Server Component — html element with lang="en", body with `next/font` (Inter or similar), import `globals.css`
- `app/page.tsx`: simple Server Component rendering the project name "Neo Security Agent" and a note that this is the API backend with a link to the API docs (placeholder)

### 10. Update package.json and verify CLI still works

- Ensure `"main": "src/index.js"` is preserved
- Ensure `npm start` still runs `node --no-deprecation src/index.js`
- Ensure `npm run dev` still runs the CLI with `--watch`
- Verify the new `npm run dev:web` starts Next.js on port 3000
- Add a `.gitignore` entry for `.next/` if not already present

---

## Verification

1. Run `npm run dev:web` — Next.js dev server starts without errors on port 3000
2. Run `npm start` — CLI starts normally with the Neo banner and REPL prompt (confirming no regressions)
3. Use `curl` to test `POST /api/agent` with `{"message": "Show me high severity incidents"}` — verify SSE stream returns `session`, `thinking`, `tool_call`, and `response` events in order
4. Use `curl` to test a destructive action — send a message that triggers `reset_user_password`, verify the stream ends with a `confirmation_required` event
5. Use `curl` to test `POST /api/agent/confirm` with the session ID and `confirmed: true` — verify the stream resumes and completes
6. Use `curl` to test `GET /api/agent/sessions` — verify it returns the active session
7. Use `curl` to test `DELETE /api/agent/sessions` with the session ID — verify it returns `{ deleted: true }`
8. Verify rate limiting by sending 101 messages to the same session — the 101st should return a 429 or error event
