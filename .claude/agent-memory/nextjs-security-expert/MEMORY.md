# Security Expert Agent Memory — Neo Project

## Project Identity
- Security Agent CLI + Next.js web API. Codebase at `/Users/pkeenan/Documents/neo/`.
- Web layer is a pure API server (`web/`) — no auth layer, no middleware, all routes are unauthenticated.
- Tool execution (Sentinel KQL, XDR, Entra ID, password reset, machine isolation) happens server-side via Azure APIs.

## Critical Security Patterns in This Codebase

### No Authentication on Any Route
All three API routes (`/api/agent`, `/api/agent/confirm`, `/api/agent/sessions`) are fully unauthenticated. No middleware.ts exists. This is the single highest-severity issue.

### Session Store (web/lib/session-store.ts)
- In-memory Map, single-process only (not suitable for multi-instance deploys).
- Rate limit is per-session (100 messages), not per-IP/caller — trivially bypassed by creating new sessions.
- Session IDs are `crypto.randomUUID()` — cryptographically sound.
- TTL: 30 min with 1-min sweep interval.
- `list()` endpoint leaks all active session IDs — no auth guard.

### CSPRNG Gap (web/lib/auth.ts)
- `generateSecurePassword()` uses `Math.random()` (not `crypto.randomBytes`) — not cryptographically random.
- Fisher-Yates shuffle is implemented as `.sort(() => Math.random() - 0.5)` — not a uniform shuffle.

### OData Injection (web/lib/executors.ts)
- `get_sentinel_incidents`: severity/status string interpolated into OData `$filter` without sanitization.
- `search_xdr_by_host`, `isolate_machine`, `unisolate_machine`, `get_user_info`: hostname/upn interpolated into API URLs without encoding (`encodeURIComponent` missing).
- Inputs come from Claude tool outputs, which themselves come from user messages — full injection chain exists.

### Sensitive Data in NDJSON Stream
- `reset_user_password` returns `temporaryPassword` in the API response — flows to the NDJSON stream and to the browser.
- `tool_call` events in the stream include full tool input (including `justification`, `upn`, `hostname`) — sent to every client connected to that stream.

### Error Message Leakage
- Azure API error bodies (from `res.text()`) are concatenated directly into thrown Error messages, which propagate to the client via `{ type: "error", message: (err as Error).message }`.

### Confirmation Gate Bypass (web/app/api/agent/confirm/route.ts)
- `clearPendingConfirmation` is called before the stream is opened — concurrent POST requests to `/confirm` with the same sessionId will both find a pending tool on the first call; only one will clear it. Race condition allows double-execution.
- No `toolId` verification against the pending tool's actual ID (field exists in `ConfirmRequest` type but is not checked).

### Missing Security Headers (web/next.config.js)
- No `headers()` configuration. No CSP, HSTS, X-Frame-Options, X-Content-Type-Options.
- `poweredByHeader: false` not set — server advertises Next.js version.

### Config Loading (web/lib/config.ts)
- Uses `dotenv` to load `../.env` (parent directory). In production this path is fragile.
- `validateConfig()` is never called from any route handler — startup validation is opt-in.

## See Also
- Detailed findings: `security-review-2026-03-02.md`
