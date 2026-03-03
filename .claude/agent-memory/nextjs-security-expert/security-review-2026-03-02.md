# Security Review — Neo Web Layer (2026-03-02)

Initial review of the entire web/ directory added in this diff.
Key files: route.ts (x3), session-store.ts, agent.ts, auth.ts, config.ts, executors.ts, stream.ts, tools.ts, types.ts.

## Findings Summary (12 issues)

### BLOCKER
1. Zero authentication on all API routes
2. Math.random() used for cryptographic password generation
3. OData/URL injection from unvalidated tool inputs

### MAJOR
4. Temporary password returned to the browser in plaintext
5. Confirmation gate race condition enables double-execution of destructive actions
6. toolId in ConfirmRequest is declared but never verified
7. Azure API error bodies leak to client
8. No security headers configured

### MINOR
9. Per-session rate limit trivially bypassed with new sessions
10. GET /sessions leaks all session IDs without auth
11. No input length/content validation on user message field
12. dotenv loads ../.env — fragile in containerized deployments

Status: Reported to developer 2026-03-02.
