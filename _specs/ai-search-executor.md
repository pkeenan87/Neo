# Spec for ai-search-executor

branch: claude/feature/ai-search-executor

## Summary

Add a new Neo executor that performs hybrid retrieval (BM25 + vector + semantic rerank) against the `sharepoint-docx` Azure AI Search index, giving Neo on-demand grounding from the indexed SharePoint document library. This unblocks RAG-style answers over Goodwin's policies, runbooks, memos, and templates without forcing the agent to chain through the existing SharePoint fetch executor for every document.

Today, Neo's SharePoint executor pulls specific files by URL via Microsoft Graph and converts them to Markdown. That works when the agent already knows which document it wants, but it does not help with open questions like *"what's our policy on outside counsel guidelines"* — those need retrieval, not fetch. The RAG pipeline is already deployed and indexing into `sharepoint-docx` on `srch-neo-prod-001.search.windows.net`; this feature is the Neo-side executor that wraps query-time retrieval and surfaces results into the agent's context window.

Reference: [AI Search & RAG (Notion)](https://www.notion.so/3537b36249e280a2a44fe10c4477df91) for the deployed pipeline design.

## Functional requirements

- Add a single new tool to the Neo executor registry (working name: `searchKnowledgeBase`; final name to be confirmed — alternative `retrieveDocumentContext`).
- Tool inputs:
  - `query` (string, required) — natural-language question.
  - `top` (number, optional, default 5, max 20) — number of chunks to return.
  - `filter` (string, optional) — OData filter expression for fields like `title`, `lastModified`, `header_1`.
  - `index` (string, optional, default `sharepoint-docx`) — placeholder for future multi-index support.
- Tool output: array of result objects, each containing `chunk`, `header_1`, `header_2`, `header_3`, `title`, `url`, `lastModified`, `rerankerScore`, and `captions` (extractive highlights).
- Use Azure AI Search hybrid + semantic search: BM25 keyword search combined with a server-side text-to-vector query (no client-side embedding call), with `semantic` query type, `default-semantic` configuration, extractive captions, and extractive answers.
- The executor is read-only: no confirmation gate, safe to invoke autonomously inside the agent loop.
- Authenticate to Azure AI Search via `ManagedIdentityCredential` in production (explicit, matching the existing Neo pattern — not `DefaultAzureCredential`). Grant `app-neo-prod-001`'s system-assigned managed identity the `Search Index Data Reader` role on `srch-neo-prod-001`.
- Keep the AI Search admin key in `kv-neovault-prod-001` as a local-dev-only fallback path.
- Add `*.search.windows.net` to the corporate proxy bypass list alongside the existing entries (`api.loganalytics.io`, `api.securitycenter.microsoft.com`, etc.).
- Truncate each returned `chunk` to ~1,500 characters as defense-in-depth (chunks are already capped at 2,000 chars by the indexer's SplitSkill).
- Filter out results below a configurable `rerankerScore` threshold (default `1.5`); allow disabling the threshold for debugging.
- Always return `url` for each result so the agent can cite source documents in its response.
- Emit structured audit logs for every invocation capturing the query string, result count, top reranker score, and the list of source URLs returned. Use the same audit pipeline as the other Neo executors.
- Update the role-based system prompts (Security, Help Desk, Desktop Engineering modules) to describe the new tool and explain when to use it vs. the existing SharePoint fetch executor.
- Expose the tool with role-gated visibility: at minimum Security, Help Desk, and Desktop Engineering should see it.

## Figma Design Reference (only if referenced)

Not applicable — this is a backend executor with no UI surface in v1.

## Possible Edge Cases

- Empty result set — agent should be able to recognise "no relevant context found" and fall back gracefully (e.g. tell the user, or chain to direct SharePoint fetch).
- All results below the reranker threshold — same handling as empty set; surface a clear signal rather than returning silently empty.
- Index temporarily unavailable / 503 from AI Search — surface a structured error to the agent loop, do not crash the turn.
- Managed identity not yet granted `Search Index Data Reader` — must produce an actionable error message pointing at the role assignment, not a generic 403.
- Proxy bypass missing for `*.search.windows.net` — calls will hang or TLS-fail silently. Detect early in local dev and document the bypass requirement.
- Very long `query` strings (e.g. agent pastes a giant context blob) — clamp or reject queries above a sane upper bound to avoid AI Search request limits.
- `top` outside the valid range — clamp to `[1, 20]` rather than passing through.
- Malformed `filter` OData expression — return the AI Search validation error to the agent so it can self-correct.
- Per-document ACL trimming is currently in preview for the SharePoint indexer; the InformationSecurity619 site is uniformly permissioned today, but if the document library later gains unique permissions, the executor must not leak content the calling user shouldn't see.
- Token budget pressure — large `top` × large chunks could blow the context window. The 1,500-char truncation and reranker threshold both help; verify behaviour at `top=20`.
- Future multi-index expansion — `index` parameter accepted but only `sharepoint-docx` is whitelisted in v1; an unknown index value should be rejected explicitly.

## Acceptance Criteria

- Executor is registered in the Neo registry and callable from the agent loop with the documented input shape.
- Natural-language queries against `sharepoint-docx` return ranked, captioned results with the documented output shape.
- Authentication uses `ManagedIdentityCredential` in production; admin-key fallback works for local development only.
- Proxy bypass for `*.search.windows.net` is added and documented.
- The role-based system prompts (Security, Help Desk, Desktop Engineering) describe when to use `searchKnowledgeBase` vs. the direct SharePoint fetch executor.
- Audit logs include query, result count, top reranker score, and source URLs for every invocation.
- The executor is read-only and does not trigger the destructive-tool confirmation gate.
- A smoke test runs a known-good query (e.g. "outside counsel guidelines") and asserts non-empty results with at least one `rerankerScore > 1.5`.
- Tool visibility is role-gated to Security, Help Desk, and Desktop Engineering at minimum.

## Open Questions

- Final tool name: `searchKnowledgeBase` vs. `retrieveDocumentContext` — pick one before merge. searchKnowledgeBase
- Should the default reranker threshold (1.5) be tunable per-role, or globally fixed for v1? globally fixed
- ACL trimming — track the SharePoint indexer preview feature; revisit once the library has non-uniform permissions.
- Multi-index expansion: should v1 accept the `index` parameter at all, or hardcode `sharepoint-docx` and add the parameter only when a second index actually exists? accept the index parameter
- MCP wrapper through Mithril — explicitly out of scope for v1, but worth confirming no near-term external client (Claude Code, etc.) needs the retrieval surface. out of scope
- Should empty / below-threshold results return an empty array, or a structured "no results" object that nudges the agent toward a fallback path? a structured object

## Testing Guidelines

Create a test file under `./test` for the new executor, with meaningful but lightweight coverage of the following cases:

- Happy path: a known-good query (e.g. "outside counsel guidelines") returns a non-empty array with at least one result whose `rerankerScore > 1.5` and a populated `url`.
- Input validation: `top` is clamped to `[1, 20]`; invalid `index` values are rejected; oversized `query` strings are rejected or clamped.
- Threshold filtering: results below the default reranker threshold are filtered out; the debug knob disables filtering.
- Chunk truncation: returned `chunk` values are no longer than the configured per-result character budget.
- Error handling: AI Search 5xx and 403 (missing role assignment) surface structured, actionable errors rather than crashing the agent turn.
- Audit logging: a single invocation produces exactly one audit record containing query, result count, top reranker score, and source URLs.
- Auth path selection: production code path uses managed identity; local-dev fallback uses the Key Vault admin key.
- Role gating: the tool is visible to Security / Help Desk / Desktop Engineering roles and hidden from any role that should not see it.
