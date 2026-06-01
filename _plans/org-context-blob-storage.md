# Org Context Blob Storage

## Context

The organizational-context system prompt addendum is currently stored in an
Azure Key Vault secret (`ORG_CONTEXT`) with a hard cap of 5,000 characters
(`ORG_CONTEXT_MAX_CHARS`). The InfoSec team has produced a ~36.6 KB / ~9K-token
environment fingerprint that should be injected as persistent system-prompt
context, but it exceeds both Neo's application cap and Key Vault's underlying
~25 KB per-secret value limit. We need to move the canonical store to Azure
Blob Storage, raise the application cap to ~100,000 characters, and keep the
existing Key Vault / env-var paths as fallbacks for legacy small contexts.
The fingerprint will be injected verbatim every turn; the 1-hour prompt-cache
TTL (P4) absorbs the per-turn token cost after the first call.

---

## Key Design Decisions

- **Three-tier resolution** in `loadOrgContext`: Blob > Key Vault > env var.
  Blob is the new "large content" lane; Key Vault stays as a fallback so
  existing 5K-char deployments continue to work without migration, and so
  operators can disable the blob path by setting an empty container env var.
- **Single-file layout** at `<container>/org-context/current.yaml`. Versioning
  is delegated to Azure Blob's built-in soft-delete + versioning; no separate
  history table needed. Content-type is set to `text/plain` because the value
  is injected as opaque text — YAML structure has no operational meaning to
  the loader, only to the human author.
- **Raised application cap** to 100,000 characters (`ORG_CONTEXT_MAX_CHARS`),
  with a warn threshold of 20,000. 100K is ~25K tokens — large enough for the
  current fingerprint plus a few years of growth, well under Anthropic's 200K
  / 1M context windows and the system-prompt cache breakpoint budget.
- **Reuse existing storage account.** `CLI_STORAGE_ACCOUNT` + a new
  `NEO_ORG_CONTEXT_CONTAINER` env var (default `neo-org-context`) mirrors the
  exact pattern used by `tool-result-blob-store.ts` and `upload-storage.ts`.
  Managed-identity auth via `ManagedIdentityCredential` — no new secrets.
- **Admin UI: keep the textarea, raise its `maxLength`, surface a separate
  "Upload file" affordance.** A 36 KB textarea is still usable for paste-edit
  workflows; the upload button lets admins drop the file in directly. Both
  paths flow through the same `PUT /api/admin/org-context` endpoint.
- **Cache strategy unchanged.** Keep the 60-second in-memory cache in
  `loadOrgContext`. The blob round-trip is cheap and the cache key doesn't
  need to be content-aware — the existing time-based TTL is fine.
- **Sanitisation unchanged.** `sanitizeOrgContext` (markdown-heading
  stripping) still runs before injection. Blob storage is not a higher-trust
  source than Key Vault — both are admin-edited.
- **No migration script.** The existing Key Vault secret (5K chars) keeps
  working as the fallback tier. Admins promote their context to blob by
  re-saving via the admin UI; the UI writes to whichever backend is
  configured (blob if container env var set, KV otherwise).

---

## Files to Change

| File | Change |
|------|--------|
| `web/lib/org-context-constants.ts` | Raise `ORG_CONTEXT_MAX_CHARS` to 100_000 and `ORG_CONTEXT_WARN_CHARS` to 20_000. |
| `web/lib/org-context-blob-store.ts` *(new)* | Lazy-singleton container client + `loadOrgContextFromBlob()` and `saveOrgContextToBlob(text)` helpers. Pattern follows `tool-result-blob-store.ts` and `upload-storage.ts`: `ManagedIdentityCredential` + `BlobServiceClient` + a single `getContainerClient` call, gated on `CLI_STORAGE_ACCOUNT` and a new `NEO_ORG_CONTEXT_CONTAINER` env var. `isOrgContextBlobConfigured()` predicate exported for the admin route to pick the write target. |
| `web/lib/config.ts` | (1) Add `NEO_ORG_CONTEXT_CONTAINER` to the `env` export (default `neo-org-context`). (2) Modify `loadOrgContext` to try Blob first, then fall through to Key Vault, then env var. Reuse the existing 60s in-memory cache; cache invalidation on `kvResolved` already handles "transient errors don't poison the cache" — replicate the same flag for the blob path so a blob 503 falls through cleanly. (3) Same length-cap enforcement and warn-threshold logic apply to all three tiers. |
| `web/app/api/admin/org-context/route.ts` | (1) `GET` returns content from whichever tier is the active write target (blob if configured, KV otherwise) plus a `backend: 'blob' \| 'keyvault'` indicator in the JSON. (2) `PUT` writes to the active tier and clears the in-memory cache via `clearOrgContextCache()`. (3) Update the `if (orgContext.length > ORG_CONTEXT_MAX_CHARS)` check — the constant change in `org-context-constants.ts` carries the new ceiling automatically; no code change here beyond the message text staying accurate. |
| `web/components/SettingsPage/OrgContextSection.tsx` | (1) Render the "stored in: Blob storage / Key Vault" indicator from the new `backend` field. (2) Add an "Upload file" button that opens a native file picker scoped to `.yaml,.yml,.md,.txt`, reads the selected file as UTF-8 text via `FileReader` or `file.text()`, and pipes the contents into the existing `context` state. The save button still PUTs the assembled string. (3) Re-tune the textarea visible height (e.g. `rows=24`) so 100 KB content is still scrollable. (4) Refresh the placeholder text to mention that the fingerprint YAML is acceptable. |
| `web/components/SettingsPage/OrgContextSection.module.css` | New `.uploadButton` style + a row container for the upload button next to the save button. Conform to the 3-class rule and 8pt grid per CLAUDE.md. |
| `web/test/org-context-loader.test.ts` *(new)* | Vitest suite for `loadOrgContext`: (a) blob-only present → returns blob content; (b) blob fails (mocked 503) → falls through to KV, no cache poisoning; (c) blob unconfigured → KV path unchanged; (d) length cap enforced on blob content; (e) cache hit avoids second blob call. Mock `@azure/storage-blob` following the pattern in `web/test/conversation-store-blob-offload.test.ts`. |
| `web/test/org-context-blob-store.test.ts` *(new)* | Save + load round-trip against the mocked container; verify `saveOrgContextToBlob` calls `getBlockBlobClient("org-context/current.yaml").upload` with the expected content-type. |
| `web/test/admin-org-context-route.test.ts` *(new — or extend existing if one is added)* | Verify `GET` returns `backend` indicator, `PUT` routes to the right backend when `NEO_ORG_CONTEXT_CONTAINER` is set vs unset, and that the cache is cleared on successful save. |
| `docs/deployment.md` | Add row for `NEO_ORG_CONTEXT_CONTAINER`. Note the storage-account RBAC requirement: the App Service managed identity needs `Storage Blob Data Contributor` on the org-context container. |
| `docs/configuration.md` | Add `NEO_ORG_CONTEXT_CONTAINER` and update the `ORG_CONTEXT` row to mention that values larger than 5K are stored in blob storage, not Key Vault. |
| `_plans/org-context-blob-storage.md` *(this file)* | The plan itself. |

---

## Implementation Steps

### 1. Constants

- Edit `web/lib/org-context-constants.ts`: set `ORG_CONTEXT_MAX_CHARS = 100_000` and `ORG_CONTEXT_WARN_CHARS = 20_000`. Update the file's leading comment to explain the new ceiling and the storage-tier split.

### 2. Blob-storage helper

- Create `web/lib/org-context-blob-store.ts`:
  - Constants: `ORG_CONTEXT_BLOB_NAME = "org-context/current.yaml"`.
  - Lazy `getOrgContextContainer()` singleton that reads `env.CLI_STORAGE_ACCOUNT` and `env.NEO_ORG_CONTEXT_CONTAINER`. Returns `null` and emits a one-time `logger.warn` when either is unset.
  - `isOrgContextBlobConfigured()` → boolean (used by admin route to pick the write target).
  - `loadOrgContextFromBlob()` → `Promise<string | null>`: returns the blob's contents as UTF-8 text, returns `null` on 404 (no content saved yet), throws on any other failure (caller decides whether to fall through). Use `blockBlob.downloadToBuffer()` then `Buffer.toString("utf8")`.
  - `saveOrgContextToBlob(text: string)` → `Promise<void>`: uploads with `blobContentType: "text/plain; charset=utf-8"`.

### 3. Loader integration

- In `web/lib/config.ts`:
  - Add `NEO_ORG_CONTEXT_CONTAINER: process.env.NEO_ORG_CONTEXT_CONTAINER || "neo-org-context"` to the `env` object.
  - Modify `loadOrgContext`:
    - Tier 1: lazy-import `./org-context-blob-store`; if `isOrgContextBlobConfigured()` and the call succeeds, use its return value (when non-null). Track a `blobResolved` flag the same way `kvResolved` is tracked today so transient blob errors don't poison the cache.
    - Tier 2: existing Key Vault path (unchanged).
    - Tier 3: existing env-var path (unchanged).
    - Cache only when `(blobResolved || !blobConfigured) && (kvResolved || !env.KEY_VAULT_URL)` — i.e. only when no tier silently errored.
    - The length cap / warn threshold loop already runs after resolution; the constant change in step 1 carries through.

### 4. Admin API route

- In `web/app/api/admin/org-context/route.ts`:
  - `GET`: branch on `isOrgContextBlobConfigured()`. If true, call `loadOrgContextFromBlob()` and return `{ orgContext, orgName, backend: "blob" }`. Otherwise the existing Key Vault read path with `backend: "keyvault"`. On blob 503 the route falls back to KV reads — same fallback the loader uses — so a partial outage doesn't strand the admin UI.
  - `PUT`: same branch — write to blob via `saveOrgContextToBlob` when configured, otherwise existing `setToolSecret("ORG_CONTEXT", ...)`. Always call `clearOrgContextCache()` after a successful save. Update the log line to include `backend` so audit trails make the routing obvious.
  - Keep the CSRF Origin/Host check and length cap check exactly as they are today.

### 5. Admin UI

- In `web/components/SettingsPage/OrgContextSection.tsx`:
  - Extend the `OrgContextResponse` interface with `backend: "blob" | "keyvault"`.
  - Surface a small badge / inline label near the section title indicating which backend is active (e.g. "Stored in Blob storage" / "Stored in Key Vault").
  - Add a hidden `<input type="file" accept=".yaml,.yml,.md,.txt">` plus a visible "Upload file" button (CLAUDE.md 3-class rule applies). On change, read the file with `await file.text()` and set the `context` state. If file content exceeds `ORG_CONTEXT_MAX_CHARS`, surface the existing `overLimit` error state.
  - Bump textarea visual height (CSS module change) so 100K content is still readable; keep `maxLength={ORG_CONTEXT_MAX_CHARS}` to enforce the cap client-side.
  - Update placeholder text to call out that the full environment fingerprint YAML is now an acceptable input.

### 6. Tests

- `web/test/org-context-loader.test.ts`:
  - Mock `@azure/storage-blob` at top of the file (use the `conversation-store-blob-offload.test.ts` pattern as the template).
  - Cases: blob hit, blob miss (404 → KV fallback), blob 503 (fallback + no cache poison), KV-only path unchanged, env-var-only path unchanged, length cap enforced on blob content, warn threshold triggers `console.warn` exactly once when content size is in the warn band, cache hit avoids second blob call within 60s window.
- `web/test/org-context-blob-store.test.ts`:
  - Save → load round-trip; verify content-type and blob path.
  - `isOrgContextBlobConfigured` reflects the env state.
- `web/test/admin-org-context-route.test.ts`:
  - `GET` returns `backend: "blob"` when configured, `"keyvault"` otherwise.
  - `PUT` routes to the right helper based on configuration.
  - `clearOrgContextCache` is called on successful save (spy on the import).
- Run `npm run test`, `npm run typecheck`, `npm run lint` from `web/`.

### 7. Docs

- `docs/deployment.md`: add a row for `NEO_ORG_CONTEXT_CONTAINER` in the env-var reference table. Include the RBAC requirement (managed identity needs `Storage Blob Data Contributor` on the container).
- `docs/configuration.md`: add the same row; update the existing `ORG_CONTEXT` row to mention that large content lives in blob storage and Key Vault is the fallback tier.

### 8. Operator runbook step (out of scope for code, document in deployment.md)

- One-time setup per environment: create the `neo-org-context` container under the existing `CLI_STORAGE_ACCOUNT`, grant `Storage Blob Data Contributor` to the App Service managed identity, then have an admin paste or upload the fingerprint via Settings → Organization.

---

## Verification

1. `npm run typecheck` — clean (cron-parser pre-existing warning unchanged).
2. `npm run lint` — clean (pre-existing ApiKeysSection warning unchanged).
3. `npm run test` — all suites pass, including the three new ones from step 6.
4. Manual: start the dev server, visit Settings → Organization, paste the full 36 KB fingerprint into the textarea, click Save. Reload and confirm content persists. Start a new conversation and verify the model can answer a fingerprint-specific question (e.g. "Which Azure regions does Goodwin use?") on the first turn.
5. Manual: drop the blob container env var, restart the server, confirm the loader falls through to Key Vault and a small (<5K char) test value still works end-to-end.
6. Manual: kill blob storage permissions temporarily (e.g. remove the role assignment), confirm `loadOrgContext` falls through to KV and a warning is logged, not a 500.
7. Confirm logs show the new `backend` field on `admin-org-context` PUT events.
