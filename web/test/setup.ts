// Vitest setup — runs once before any test module loads.
//
// Purpose: pin MOCK_MODE=true for the test process so config.env.MOCK_MODE
// is true regardless of what the developer's local `.env` says. Tests
// that exercise live-mode code paths already mock `lib/config` directly
// (see test/mcp-servers.test.ts) so they aren't affected by this default.
//
// Why: lib/config.ts calls `dotenv.config({ path: "../../.env" })` at
// module load. On a developer machine with MOCK_MODE=false (live Azure
// creds for the agent loop), every test that imports lib/config inherits
// that — the agent loop's getMcpServers / getInProgressPlan / etc. then
// try to hit real Cosmos / Key Vault / MCP, hang for 5s, and the test
// times out. CI doesn't reproduce this because the runner has no `.env`,
// so dotenv is a no-op and process.env.MOCK_MODE stays undefined (which
// `config.ts` treats as true via `!== "false"`).
//
// Pinning here pre-empts dotenv: it never overrides already-set env vars,
// so our value wins.
//
// IMPORTANT: this file MUST NOT import anything from `lib/` — pinning has
// to happen before any module that calls `dotenv.config()` is touched.

process.env.MOCK_MODE = "true";
