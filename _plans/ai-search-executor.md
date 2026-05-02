# AI Search Executor

## Context

Implement a new read-only Neo executor, `searchKnowledgeBase`, that performs hybrid (BM25 + vector + semantic rerank) retrieval against the `sharepoint-docx` Azure AI Search index on `srch-neo-prod-001.search.windows.net`. The pipeline that populates the index is already deployed; this work is purely the agent-side retrieval surface so Neo can answer open-ended policy/runbook questions without first knowing which SharePoint document to fetch. All implementation lives in the `web/` Next.js project — the CLI is server-deferred (it calls into the web server via `cli/src/server-client.js`) and does not need its own copy of the executor or tool schema. The CLAUDE.md "Adding a new tool (CLI)" section is stale on this point and will be ignored.

---

## Key Design Decisions

- **Web-only implementation, no CLI duplication.** `cli/src/` no longer carries `tools.js` / `executors.js`; the CLI talks to the web server. All registration happens in `web/lib/`.
- **Direct REST via `fetch`, no `@azure/search-documents` SDK.** Every existing Neo executor (Sentinel, Defender XDR, Graph) calls Azure REST endpoints with `fetch`. Matching that pattern keeps the dependency footprint small and avoids a new top-level package.
- **Server-side vectorization.** The index has a server-side text-to-vector vectorizer configured, so the executor sends raw query text inside a `vectorQueries[].kind = "text"` payload. No client-side embedding call (and no second AOAI hit per turn).
- **Auth: `ManagedIdentityCredential` in production, Key Vault admin-key fallback for local dev.** The existing `getAzureToken()` in `web/lib/auth.ts` uses OAuth2 client_credentials with a service principal. The spec explicitly requires `ManagedIdentityCredential` for AI Search (matching the pattern already used in `web/lib/secrets.ts` and the Cosmos/conversation stores). Add a new helper rather than overloading `getAzureToken()`. For local dev where managed identity is unavailable, fall through to an admin key resolved via `getToolSecret("AI_SEARCH_ADMIN_KEY")` (which itself falls through to `process.env.AI_SEARCH_ADMIN_KEY`).
- **Read-only ⇒ not in `DESTRUCTIVE_TOOLS`.** The tool runs autonomously inside the agent loop with no confirmation gate. Visibility falls out of the existing role permission model: all roles (`admin`, `reader`, `triage`) see read-only tools.
- **Role-gating reality check.** The spec's "Security / Help Desk / Desktop Engineering" roles do not exist in `web/lib/permissions.ts` (which has `admin | reader | triage`). The current model is binary: destructive vs. read-only. Since `searchKnowledgeBase` is read-only, no role-specific gating beyond the existing `getToolsForRole()` filter is required for v1. Capture the role-name mismatch as an open question rather than introducing a new role taxonomy in this PR.
- **Role-based system prompt modules don't exist either.** `getSystemPrompt(role)` in `web/lib/config.ts` returns the same base prompt for every role and only differs by which admin-defined skills are appended. The spec's "update the role-based system prompts" requirement maps to: (a) add a paragraph to `buildBaseSystemPrompt()` in `web/lib/config.ts` describing when to use `searchKnowledgeBase` vs. the direct SharePoint fetch; (b) optionally seed a skill markdown later if finer-grained per-role guidance is wanted, but that is out of scope for this PR.
- **Structured "no results" response, not an empty array.** Per the user's spec edit: when retrieval succeeds but no result clears the reranker threshold (or the index is empty for the query), return a structured object that explicitly tells the agent to consider fallback paths, rather than an empty array that could be mistaken for a transport error.
- **`top` clamping and `index` whitelist enforced server-side.** `top` is clamped to `[1, 20]` and unknown `index` values are rejected with a clear error, even though the JSON Schema also constrains them — defense-in-depth for prompt-injection or model hallucination of unsupported indices.
- **Per-result chunk truncation at ~1,500 chars.** SplitSkill already caps chunks at 2,000; truncating again on the way out keeps total tool-result size predictable for the context manager.
- **Structured audit log per invocation.** Use the existing `logger` (`web/lib/logger.ts`) with safe metadata only: `query` (raw — it is the user's question, not PII; size-limited), `resultCount`, `topRerankerScore`, and `urls` (array of source URLs). No raw chunks logged. One log line per successful invocation; errors continue to flow through `logger.error`.
- **Smoke test uses MOCK_MODE.** The vitest test mocks the network layer and the auth helper — no live AI Search call. A separate manual smoke against prod is captured in the verification section.
- **Default reranker threshold is globally fixed (1.5)** per the user's spec edit, configurable only by the executor's debug knob (input flag), not per-role.

---

## Files to Change

| File | Change |
|------|--------|
| `web/lib/tools.ts` | Add `searchKnowledgeBase` tool schema entry to the `TOOLS` array. Do NOT add to `DESTRUCTIVE_TOOLS`. |
| `web/lib/types.ts` | Add `SearchKnowledgeBaseInput` and `SearchKnowledgeBaseResult` interfaces (and a `SearchKnowledgeBaseNoResults` shape for the structured-empty case). |
| `web/lib/executors.ts` | Add `searchKnowledgeBase()` async function with MOCK_MODE dual-path; register it in the `executors` registry object. |
| `web/lib/ai-search-auth.ts` (new) | Helper that returns a bearer token for `https://search.azure.com` via `ManagedIdentityCredential`, with a Key Vault admin-key fallback for local dev. In-memory token cache mirroring the pattern in `auth.ts`. |
| `web/lib/config.ts` | Add `AI_SEARCH_ENDPOINT`, `AI_SEARCH_INDEX_DEFAULT`, `AI_SEARCH_ADMIN_KEY` (optional, dev fallback), and `AI_SEARCH_RERANKER_THRESHOLD` (with default `1.5`) to the `env` object. Update `buildBaseSystemPrompt()` to describe `searchKnowledgeBase` and when to use it vs. the direct SharePoint fetch executor. |
| `web/lib/secrets.ts` | No change required — `getToolSecret("AI_SEARCH_ADMIN_KEY")` already works generically. |
| `web/test/ai-search-executor.test.ts` (new) | Vitest test file mirroring the structure of `web/test/query-csv-executor.test.ts`: mocks for `logger`, the auth helper, and `fetch`. Covers happy path, input validation, threshold filtering, chunk truncation, error paths, audit logging, auth path selection, and the structured "no results" shape. |
| `.env.example` | Document `AI_SEARCH_ENDPOINT`, `AI_SEARCH_INDEX_DEFAULT`, optional `AI_SEARCH_ADMIN_KEY`, and `AI_SEARCH_RERANKER_THRESHOLD`. |
| `_specs/ai-search-executor.md` | Already committed (`1288f5d`). No further change. |
| `README.md` / deployment docs | If a single proxy-bypass list exists, append `*.search.windows.net`. If proxy bypass is environment-level only, add a one-paragraph note in the deployment doc that points to the operator's network bypass list. |

> **Out of scope for this PR (track separately):** ACL trimming for SharePoint indexer (preview feature); multi-index expansion beyond `sharepoint-docx`; MCP wrapper through Mithril; introducing a "Security / Help Desk / Desktop Engineering" role taxonomy; per-role skill markdown for the new tool.

---

## Implementation Steps

### 1. Add environment configuration

- Open `web/lib/config.ts`. Add these fields to the `env` object next to existing Azure-resource configuration:
  - `AI_SEARCH_ENDPOINT` — string, required when `MOCK_MODE=false`. Example: `https://srch-neo-prod-001.search.windows.net`. Trim trailing slash on read.
  - `AI_SEARCH_INDEX_DEFAULT` — string, default `"sharepoint-docx"`.
  - `AI_SEARCH_API_VERSION` — string, default `"2024-07-01"` (or the latest stable version that supports semantic + integrated vectorization). Centralising this avoids hard-coding it in the executor.
  - `AI_SEARCH_RERANKER_THRESHOLD` — number, default `1.5`.
  - `AI_SEARCH_ADMIN_KEY` — string, optional. Local-dev fallback only. Read via `getToolSecret("AI_SEARCH_ADMIN_KEY")` at call time, not at module load.
- Add validation in the existing config validation block (around `env.MOCK_MODE` checks): if `MOCK_MODE=false`, require `AI_SEARCH_ENDPOINT`. Log a warning if neither managed identity nor an admin key fallback is available.
- Update `.env.example` with the new keys and a comment pointing to the AI Search & RAG Notion doc.

### 2. Add input/output types

- Open `web/lib/types.ts`. Add (next to other executor input types):
  - `SearchKnowledgeBaseInput` — `query: string` (required); `top?: number`; `filter?: string`; `index?: string`; `disableRerankerThreshold?: boolean` (the debug knob).
  - `SearchKnowledgeBaseResult` — single hit shape: `chunk`, `header_1`, `header_2`, `header_3`, `title`, `url`, `lastModified`, `rerankerScore`, `captions`.
  - `SearchKnowledgeBaseResponse` — discriminated union: either `{ status: "ok"; results: SearchKnowledgeBaseResult[]; topRerankerScore: number }` or `{ status: "no_results"; reason: "empty_index" | "below_threshold"; query: string; suggestion: string }`. The `suggestion` field steers the agent toward the SharePoint fetch executor or rephrasing.

### 3. Add the auth helper

- Create `web/lib/ai-search-auth.ts`.
- Export `getAiSearchAuth()` that returns either `{ kind: "bearer"; token: string }` or `{ kind: "apiKey"; key: string }`.
- Production path:
  - Construct a `ManagedIdentityCredential` (singleton at module scope, mirroring `secrets.ts` line 40).
  - Call `credential.getToken("https://search.azure.com/.default")`.
  - Cache the token in-memory with a 5-minute expiry buffer (mirror the cache in `web/lib/auth.ts`).
- Local-dev fallback path:
  - When the managed-identity call fails (typical local env error: `CredentialUnavailableError`), call `getToolSecret("AI_SEARCH_ADMIN_KEY")` and return the apiKey shape.
  - If that also returns undefined, throw with an actionable message: "AI Search auth unavailable: grant the app's managed identity `Search Index Data Reader` on `srch-neo-prod-001`, or set `AI_SEARCH_ADMIN_KEY` for local development."
- Token-cache misses, refresh, and 401 handling: on a 401 from the search endpoint, the executor invalidates the cache once and retries exactly once. Beyond that, propagate the error.

### 4. Implement the executor

- Open `web/lib/executors.ts`. Add a section near the existing read-only executors (e.g., after `run_sentinel_kql`).
- Implement `async function searchKnowledgeBase(input: SearchKnowledgeBaseInput): Promise<SearchKnowledgeBaseResponse>`.
- Behavior:
  1. Validate and normalise inputs:
     - `query`: must be a non-empty string; reject if blank or longer than ~2,000 characters (clamp or reject — reject with a clear error message so the agent shortens its query).
     - `top`: clamp to `[1, 20]`; default 5.
     - `index`: default `env.AI_SEARCH_INDEX_DEFAULT`; reject any value other than `sharepoint-docx` for v1 with a clear error listing supported indices.
     - `filter`: pass through unchanged. Trust AI Search to validate OData; surface its 400 to the agent.
     - `disableRerankerThreshold`: default `false`.
  2. Mock-mode branch: `if (env.MOCK_MODE) return mockSearchKnowledgeBase(input);` Mock returns a synthetic `SearchKnowledgeBaseResponse` with one or two believable hits keyed off keywords in the query (mirror the keyword-branch style of `mockSentinelKql`). Include `_mock: true` on each result.
  3. Real path:
     - Resolve auth via `getAiSearchAuth()`.
     - Build the request URL: `${env.AI_SEARCH_ENDPOINT}/indexes/${index}/docs/search?api-version=${env.AI_SEARCH_API_VERSION}`.
     - Build the body matching the spec exactly: `search`, `vectorQueries: [{ kind: "text", text, fields: "vector", k: 50 }]`, `queryType: "semantic"`, `semanticConfiguration: "default-semantic"`, `captions: "extractive"`, `answers: "extractive|count-3"`, `select: "chunk,header_1,header_2,header_3,title,url,lastModified"`, `top`, and `filter` if provided.
     - Set headers: `Content-Type: application/json`, plus either `Authorization: Bearer <token>` or `api-key: <key>` based on the auth-helper return shape.
     - Call `fetch(...)`. On 401, invalidate the auth cache and retry once. On any other non-2xx, throw `new Error(\`AI Search request failed: ${res.status} ${await res.text()}\`)`.
  4. Post-process the response:
     - Map each `value[]` entry to a `SearchKnowledgeBaseResult`.
     - Truncate `chunk` to 1,500 characters; append `…` if truncated.
     - If `disableRerankerThreshold === false`, drop entries where `rerankerScore < env.AI_SEARCH_RERANKER_THRESHOLD`.
     - If the filtered list is empty: build the structured `no_results` response. Distinguish `reason: "below_threshold"` (raw response had hits but none cleared the bar) vs. `"empty_index"` (raw response had zero hits).
     - Otherwise sort descending by `rerankerScore` (it should already be sorted by the service, but make it explicit) and compute `topRerankerScore`.
  5. Audit log exactly once at end of the happy path: `logger.info("ai_search_query", "executors", { toolName: "searchKnowledgeBase", query: <truncated to 500 chars>, resultCount, topRerankerScore, urls })`. Errors flow through `logger.error` with `toolName` and the original error message.
- Register in the `executors` registry object (around line 3358 in `web/lib/executors.ts`):
  `searchKnowledgeBase: (input) => searchKnowledgeBase(input as unknown as SearchKnowledgeBaseInput),`

### 5. Add the tool schema

- Open `web/lib/tools.ts`. Append a new entry to the `TOOLS` array (NOT inside `DESTRUCTIVE_TOOLS`):
  - `name: "searchKnowledgeBase"`.
  - `description`: a concise one-paragraph guide that covers (a) what the tool does — hybrid retrieval with semantic rerank against the SharePoint document index; (b) when to use it — open-ended natural-language questions about Goodwin policies, runbooks, memos, templates; (c) when NOT to use it — direct fetch by URL (use the SharePoint executor instead); (d) that results include source URLs that should be cited; (e) note that an empty/below-threshold result returns a structured `status: "no_results"` payload, not an error.
  - `input_schema.properties`: `query` (string, required), `top` (integer, 1–20, default 5), `filter` (string, optional, OData), `index` (string, optional, default `sharepoint-docx`), `disableRerankerThreshold` (boolean, optional, debug-only).
  - `input_schema.required: ["query"]`.

### 6. Update the base system prompt

- Open `web/lib/config.ts`. In `buildBaseSystemPrompt()`, add a short paragraph in the appropriate "tools" guidance section that explains:
  - For broad / open-ended questions about company policy, procedures, runbooks, templates, or any other documentation, prefer `searchKnowledgeBase` over the direct SharePoint fetch executor.
  - When the user supplies a known SharePoint URL or you already know the exact document, use the direct SharePoint fetch executor.
  - Always cite source URLs from `searchKnowledgeBase` results in your response.
  - If `searchKnowledgeBase` returns `status: "no_results"`, follow the embedded `suggestion` (typically: rephrase, broaden, or fall back to direct fetch).

### 7. Write the tests

- Create `web/test/ai-search-executor.test.ts`. Mirror the mock setup from `web/test/query-csv-executor.test.ts`:
  - `vi.mock("../lib/logger", ...)` returning spy `info/warn/error/debug`.
  - `vi.mock("../lib/ai-search-auth", ...)` returning a controllable token shape.
  - Stub the global `fetch` per test using `vi.stubGlobal("fetch", vi.fn(...))` or `vi.spyOn(global, "fetch")`.
- Cover (at minimum):
  1. Happy path: a known query returns a non-empty `results` array; at least one result has `rerankerScore > 1.5` and a non-empty `url`; `topRerankerScore` matches the highest score returned.
  2. `top` clamping: input `top: 0` and `top: 100` both pass through to AI Search as `1` and `20` respectively (assert on the captured fetch body).
  3. `index` whitelist: input `index: "runbooks"` rejects with an error mentioning the supported list.
  4. Oversized `query`: input over 2,000 chars rejects with a clear error.
  5. Threshold filtering: AI Search returns three hits with scores `[2.1, 1.9, 1.0]`; default behavior drops the third; with `disableRerankerThreshold: true` all three pass through.
  6. Below-threshold structured response: AI Search returns one hit with score `0.4`; default behavior returns `{ status: "no_results", reason: "below_threshold", ... }`.
  7. Empty-index structured response: AI Search returns `value: []`; executor returns `{ status: "no_results", reason: "empty_index", ... }`.
  8. Chunk truncation: an input chunk of 5,000 chars is returned as `≤ 1,500 chars + "…"`.
  9. 5xx error: fetch resolves with `res.ok === false, status === 503`; executor throws with a structured message; `logger.error` called once.
  10. 401 retry-once: first fetch returns 401, auth helper is re-invoked, second fetch returns 200; final result is the success body.
  11. Audit log shape: a single `logger.info` call with `eventType` and the documented metadata (no raw chunks).
  12. Auth path selection: `getAiSearchAuth` returning `{ kind: "bearer", token }` produces an `Authorization: Bearer ...` header; returning `{ kind: "apiKey", key }` produces an `api-key: ...` header. Captured via the fetch mock.

### 8. Documentation and ops notes

- Append a section to the existing deployment / operations doc (or create a one-pager under `_specs/` or `docs/` if there is no central doc) that captures:
  - Required role assignment: managed identity of `app-neo-prod-001` needs `Search Index Data Reader` on `srch-neo-prod-001`.
  - Proxy bypass: add `*.search.windows.net` to the corporate proxy bypass list (network/infra task; not a code change).
  - Fallback admin key: stored in `kv-neovault-prod-001` and never deployed; local dev only.

### 9. Verify wiring end-to-end (mock mode)

- Run the web dev server with `MOCK_MODE=true` (default).
- Open the chat UI, ask a question that the system prompt should route to `searchKnowledgeBase` (e.g. "What's our policy on outside counsel guidelines?").
- Confirm the agent calls the tool, the mock executor returns a synthetic result, the agent cites the mock URL in its response, and a single audit log entry appears in the dev console.

---

## Verification

1. Confirm the new files and edits are present:
   - `web/lib/ai-search-auth.ts` exists.
   - `web/lib/tools.ts` includes a `searchKnowledgeBase` entry; `DESTRUCTIVE_TOOLS` is unchanged.
   - `web/lib/executors.ts` defines `searchKnowledgeBase` and registers it.
   - `web/lib/types.ts` exports the new input/output interfaces.
   - `web/lib/config.ts` lists the new `AI_SEARCH_*` env keys and the system-prompt paragraph mentions the tool.
   - `web/test/ai-search-executor.test.ts` exists.
   - `.env.example` lists the new keys.
2. From `web/`, run the test suite for the new file: `npx vitest run test/ai-search-executor.test.ts`. Expect all twelve cases to pass.
3. From `web/`, run the full test suite: `npm test` (or `npx vitest run`). Expect no regressions in adjacent executor or agent-loop tests.
4. From `web/`, run `npm run build`. Expect a clean TypeScript compile — `any` is forbidden by CLAUDE.md, so the new types must be tight.
5. Mock-mode smoke (manual): `cd web && npm run dev`. Open chat. Issue a policy question that routes to `searchKnowledgeBase`. Confirm:
   - The tool is invoked (visible in the chat tool trace).
   - The synthetic result is rendered and cited by the agent.
   - One `logger.info` "ai_search_query" entry appears in the dev console with the expected metadata fields and no raw chunks.
6. Live smoke (post-deploy, manual, requires Azure access): with `MOCK_MODE=false`, the role assignment in place, and proxy bypass configured, run a known-good query (e.g. "outside counsel guidelines"). Assert at least one result with `rerankerScore > 1.5` and a populated `url`.
7. Negative live smoke: temporarily revoke the role assignment, re-run, and confirm the executor surfaces the actionable error (not a generic 403). Re-grant the role afterward.
8. Confirm the `_specs/ai-search-executor.md` "Acceptance Criteria" checklist is fully satisfied before merge.
