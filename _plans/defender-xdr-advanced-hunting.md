# Defender XDR Advanced Hunting Executor

## Context

Add a new Neo executor — `run_defender_hunting_query` — that runs KQL via Microsoft Graph's `POST /v1.0/security/runHuntingQuery` endpoint. This unlocks the full Defender XDR Advanced Hunting schema (notably the `DeviceTvm*` vulnerability management tables) that Sentinel's Defender XDR connector does not stream, so the agent can answer MDVM compliance and CVE-exposure questions without sending the analyst to the Defender portal. The executor must mirror the existing `run_sentinel_kql` pattern (tool schema, typed input, dual mock/live path, router registration, integration-registry capability) and distinguish request-rate vs CPU-time 429s. Spec lives at `_specs/defender-xdr-advanced-hunting.md`.

---

## Key Design Decisions

- **Tool name `run_defender_hunting_query`** — symmetrical to `run_sentinel_kql`. Description in the schema must explicitly tell the agent that this is the *only* path to `DeviceTvm*` tables and `DeviceInfoGathering*`, otherwise the agent will default to `run_sentinel_kql` and get empty results.
- **Reuse `getMSGraphToken()`** — no new auth surface in code. The `ThreatHunting.Read.All` application permission is granted out-of-band on the existing app registration; the token already requests `https://graph.microsoft.com/.default`, which includes all consented app scopes.
- **Return shape mirrors `run_sentinel_kql`** — Graph's `runHuntingQuery` response (`{ Schema: [...], Results: [...] }`) gets normalized into the same `{ tables: [{ name, columns, rows }] }` shape that `mockSentinelKql` already uses, so the agent's existing reasoning patterns and the context-manager truncation logic apply unchanged.
- **429 classification** — the Graph response body for 429 contains either `"Api calls quota exceeded"` (rate) or `"CPU quota"` / `"Concurrent requests quota"` (CPU). The executor surfaces a structured error with a `quotaKind: "rate" | "cpu"` field rather than a generic 429.
- **No client-side rate limiter, no result cache** — per spec answers. We rely on the API's 429 and let the agent decide whether to retry.
- **No KB auto-join helper** — per spec answer. The agent writes its own joins.
- **CLI gets it for free** — per spec answer. The CLI is a thin client over the web server's `/api/chat` route, so registering the tool in `web/lib/tools.ts` and the executor router is sufficient. No CLI-side code changes.
- **No role gating beyond the existing model** — per spec answer. The tool is not destructive; `canUseTool()` in `permissions.ts` will allow it for all roles by default (it's only gated for tools in `DESTRUCTIVE_TOOLS`). No additional permission entries needed.
- **`description` is required input** — match `SentinelKqlInput`. The "what this query is looking for" string is useful for logs and for future audit. Keeps the agent honest about intent.
- **Timeout handling** — Graph enforces 200s server-side. We pass `AbortSignal.timeout(210_000)` so the *server's* error message wins on near-timeout queries instead of an opaque client abort.

---

## Files to Change

| File | Change |
|------|--------|
| `web/lib/tools.ts` | Add `run_defender_hunting_query` to the `TOOLS` array. Schema accepts `query: string` (required), `description: string` (required). Description explicitly steers the agent toward this tool for `DeviceTvm*`, `DeviceInfoGathering*`, and other tables not present in Sentinel. |
| `web/lib/types.ts` | Add `DefenderHuntingQueryInput { query: string; description: string }` to the Executor Input Types section. |
| `web/lib/executors.ts` | Add `run_defender_hunting_query` executor function near the Sentinel block; add `mockDefenderHuntingQuery` helper alongside `mockSentinelKql`; register in the `executors` router. Import the new type. |
| `web/lib/integration-registry.ts` | Add `"run_defender_hunting_query"` to the `capabilities` array of the `microsoft-defender-xdr` integration (line ~75–85). |
| `web/lib/config.ts` | Update `buildBaseSystemPrompt()` to mention Defender XDR Advanced Hunting alongside Sentinel KQL, with the disambiguation rule: TVM / device posture / software inventory → Defender XDR; signals streamed into Sentinel → Sentinel. Keep the addition tight to avoid bloating token cost on every call. |
| `test/defender-xdr-advanced-hunting.test.js` | New test file. Follows the in-process style of `test/defender-xdr-indicators.test.js` — replicate the small validators / classifiers locally and assert against them, plus exercise the mock path and 429-body classification logic. |
| `.env.example` (root) | Add a comment line documenting that the existing Graph app registration must have `ThreatHunting.Read.All` (application) consented. No new env var. |
| `README.md` (if it lists Graph scopes) | Mirror the `.env.example` note. Confirm by grep before editing. |

---

## Implementation Steps

### 1. Type definition

- Open `web/lib/types.ts`.
- In the "Executor Input Types" section (after `SentinelIncidentsInput` is a natural home), add `DefenderHuntingQueryInput` with two fields: `query: string` and `description: string`. Both required.

### 2. Tool schema registration

- Open `web/lib/tools.ts`.
- Add a new entry in `TOOLS`, placed next to `run_sentinel_kql` so the schemas group logically.
- Schema fields:
  - `query` (string, required) — described as "Valid KQL query for the Microsoft Defender XDR Advanced Hunting schema."
  - `description` (string, required) — described as "Human-readable explanation of what this query is looking for."
- Tool description: explicitly call out that this is the only path to `DeviceTvm*` (compliance, vulnerabilities, inventory, KBs) and `DeviceInfoGathering*` tables, and that for AlertEvidence / DeviceProcessEvents / SignInLogs the analyst should prefer `run_sentinel_kql` *unless* the query needs to join with TVM data.
- Do **not** add this tool to `DESTRUCTIVE_TOOLS` — it's read-only.

### 3. Executor function

- Open `web/lib/executors.ts`.
- Import `DefenderHuntingQueryInput` from `./types` in the existing import block.
- Add the executor function near the Sentinel block (between `get_sentinel_incidents` and the `// ── XDR ──` divider — TVM data is logically closer to Sentinel queries than to XDR alert lookups).
- Behavior:
  - If `env.MOCK_MODE`, return `mockDefenderHuntingQuery(query)`.
  - Otherwise, call `await getMSGraphToken()`.
  - `POST https://graph.microsoft.com/v1.0/security/runHuntingQuery` with `Authorization: Bearer …`, `Content-Type: application/json`, body `{ Query: query }`.
  - Pass `signal: AbortSignal.timeout(210_000)` to `fetch` so a server-side 200s timeout error is surfaced before our own client abort fires.
  - On 429: read the response body, decide `quotaKind` based on text matches: bodies containing `"CPU"` (case-insensitive) → `"cpu"`, otherwise → `"rate"`. Throw `Error` with a message that begins with `Defender Advanced Hunting quota exceeded (rate)` or `(cpu)` so the agent sees the distinction in its next loop iteration.
  - On any other non-OK: throw with the response text (mirror `run_sentinel_kql` style).
  - On OK: parse JSON; normalize `{ Schema, Results }` into `{ tables: [{ name: "PrimaryResult", columns, rows }] }` where `columns` is derived from `Schema` (array of `{ name, type }`) and `rows` is `Results.map(r => columns.map(c => r[c.name]))`. Also surface a top-level `truncated: boolean` if the result count equals 100_000 (treat as "at cap, may be truncated"), and pass through any `Stats` block if present.
- Register `run_defender_hunting_query: (input) => run_defender_hunting_query(input as unknown as DefenderHuntingQueryInput)` in the `executors` router map (next to the Sentinel entries).

### 4. Mock implementation

- In the `Mock implementations` section of `web/lib/executors.ts`, add `mockDefenderHuntingQuery(query: string)`.
- Branch on lowercase substrings of `query`:
  - Contains `devicetvmsecureconfigurationassessment` → return 5 rows with columns `DeviceId`, `DeviceName`, `OSPlatform`, `ConfigurationId`, `IsApplicable`, `IsCompliant`, `Timestamp`. Mix of compliant + non-compliant.
  - Contains `devicetvmsoftwarevulnerabilities` → 5 rows with `DeviceId`, `DeviceName`, `SoftwareName`, `SoftwareVendor`, `CveId`, `VulnerabilitySeverityLevel`. Include at least one row with a `CveId` that the KB mock would mark exploit-available.
  - Contains `devicetvmsoftwareinventory` → 5 rows with `DeviceId`, `DeviceName`, `SoftwareName`, `SoftwareVendor`, `SoftwareVersion`, `EndOfSupportStatus`.
  - Contains `devicetvminfogathering` → 3 rows with `DeviceId`, `DeviceName`, `FieldName`, `FieldValue`.
  - Default branch: empty `rows: []` with the expected outer shape, mirroring the "no results" fallback in `mockSentinelKql`.
- Every mock return includes `_mock: true` at the top level (matches existing convention).
- The mock for the truncation test path should return exactly 100_000-row count + `truncated: true` only if a specific marker substring (e.g. `simulate_truncation`) is in the query — gives the test a deterministic hook without bloating real mock output.

### 5. Integration registry

- Open `web/lib/integration-registry.ts`.
- In the `microsoft-defender-xdr` entry, append `"run_defender_hunting_query"` to `capabilities`. No new secrets needed (existing Azure AD secrets cover it).
- In the integration's `description`, add a short clause referencing Advanced Hunting (e.g. "…run Advanced Hunting KQL across the full Defender XDR schema including TVM tables").

### 6. System prompt

- Open `web/lib/config.ts`, function `buildBaseSystemPrompt()`.
- In the opening sentence (`You are an expert AI security operations analyst for ${ORG_NAME}'s security team with direct access to Microsoft Sentinel, Defender XDR, and Entra ID tools.`) leave as-is.
- Add a short subsection (3–4 lines max) after `## INVESTIGATION METHODOLOGY`, titled something like `## QUERY ROUTING`, that says:
  - Use `run_sentinel_kql` for signals streamed into Sentinel (SigninLogs, AuditLogs, AlertEvidence, DeviceProcessEvents in Sentinel).
  - Use `run_defender_hunting_query` for the Defender XDR schema, especially `DeviceTvm*` (config compliance, software vulns, inventory) and `DeviceInfoGathering*` (attack surface state). These tables are not in Sentinel.
  - For cross-table investigations that need both, run two queries and correlate; do not assume Sentinel has the TVM tables.
- Keep wording tight to avoid prompt bloat. This section will be part of the cached system prompt (Anthropic prompt caching is already enabled in the agent loop).

### 7. Environment / docs

- Edit `.env.example` at repo root. Add a comment near `AZURE_*` block explaining that the Graph app registration must have `ThreatHunting.Read.All` (application permission, admin-consented) in addition to the existing scopes used by `run_sentinel_kql`, `get_user_info`, etc.
- If `README.md` enumerates Graph scopes anywhere, mirror the note there. Grep first before assuming.

### 8. Tests

- Create `test/defender-xdr-advanced-hunting.test.js` using `node:test` (matches `defender-xdr-indicators.test.js` style — runs with `node --test`).
- Test cases:
  1. **Quota classifier** — replicate the 429-body string-matching logic locally. Assert `"too many requests..."` (no CPU markers) → `"rate"`; `"Concurrent requests quota exceeded"` → `"cpu"`; `"CPU quota exceeded for this tenant"` → `"cpu"`.
  2. **Response normalizer** — given a synthetic Graph response of `{ Schema: [{Name:"DeviceId",Type:"string"}, {Name:"IsCompliant",Type:"bool"}], Results: [{DeviceId:"abc", IsCompliant:false}] }`, the normalizer returns `{ tables: [{ name: "PrimaryResult", columns: [...], rows: [["abc", false]] }] }`. Tests column-order preservation and value mapping.
  3. **Mock routing** — assert that queries containing each TVM table name return rows referencing that table's columns.
  4. **Truncation flag** — assert the simulator path returns `truncated: true` when the marker is present and `truncated: false` otherwise.
  5. **Empty result** — a query like `DeviceTvmSoftwareInventory | where 1==0` (mock path) returns the empty-shape fallback without throwing.
- Keep test scope to *logic that ships in the executor*. Do not test the live Graph API. Mock `fetch` only if needed for one end-to-end assertion on URL + method + headers; otherwise stick to in-process logic checks like `defender-xdr-indicators.test.js`.

### 9. Lint / typecheck / formatting

- From `web/`: run `npm run typecheck` and `npm run lint`. Fix any issues introduced by the new code.
- From repo root: run the new test file via `node --test test/defender-xdr-advanced-hunting.test.js`.

### 10. Commit and PR

- Conventional commit subject: `✨ feat(defender-xdr): advanced hunting executor`.
- Body explains the why (TVM table coverage gap), notes the new app registration permission requirement, and lists the open-question answers from the spec.
- Push the branch and open a PR. CI must be green (typecheck, lint, tests, CodeQL, secret scan) before merge.

---

## Verification

1. `cd web && npm run typecheck` — no new errors.
2. `cd web && npm run lint` — clean.
3. From repo root: `node --test test/defender-xdr-advanced-hunting.test.js` — all cases pass.
4. From repo root, run the full test suite to confirm no regression: `node --test test/`.
5. Manual mock-path check: in `MOCK_MODE=true`, drive `cd web && npm run dev`, open `/chat`, ask the agent "show me devices non-compliant with our antivirus baseline" and confirm it picks `run_defender_hunting_query` (not `run_sentinel_kql`) and returns the canned compliance rows.
6. Manual live-path check (requires admin consent of `ThreatHunting.Read.All` on the existing Graph app registration first): set `MOCK_MODE=false`, run `DeviceTvmSoftwareInventory | take 5` via the agent, confirm rows return.
7. Manual 429 check (best-effort) — if the tenant is anywhere close to the quota, trigger 429 by replaying a query in a loop and confirm the error message contains `(rate)` or `(cpu)` and the agent surfaces the distinction. Otherwise rely on the unit test.
8. Confirm the new tool appears in the integration's capability list when viewing the integrations page in the web UI.
9. Confirm the system prompt addition is short enough that the prompt-cache hit rate (visible in usage logs) doesn't regress materially after the change.
