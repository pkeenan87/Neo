# Azure Managed Identity Fix

## Context

`DefaultAzureCredential` in 4 infrastructure-access files picks up the `AZURE_CLIENT_ID`/`AZURE_CLIENT_SECRET` env vars meant for tool execution, causing the App Service to authenticate to Key Vault and Blob Storage as the service principal instead of its managed identity. The fix is a direct import swap from `DefaultAzureCredential` to `ManagedIdentityCredential` in each file. No logic changes needed.

---

## Key Design Decisions

- **`ManagedIdentityCredential` only** — This is the explicit credential type for App Service managed identity. It ignores env vars entirely, which is the desired behavior.
- **No fallback chain** — In local dev, `ManagedIdentityCredential` will fail, but all affected code paths already handle this gracefully (Key Vault returns null → env var fallback; Blob Storage returns 503 → already handled).
- **Cosmos DB files already correct** — `conversation-store.ts`, `usage-tracker.ts`, `teams-mapping-store.ts`, and `api-key-store.ts` already use `ManagedIdentityCredential`.

---

## Files to Change

| File | Change |
|------|--------|
| `web/lib/secrets.ts` | Change `DefaultAzureCredential` import and usage to `ManagedIdentityCredential`. |
| `web/lib/api-key-crypto.ts` | Change `DefaultAzureCredential` import and usage to `ManagedIdentityCredential`. |
| `web/app/api/cli/version/route.ts` | Change `DefaultAzureCredential` import and usage to `ManagedIdentityCredential`. |
| `web/app/api/downloads/[filename]/route.ts` | Change `DefaultAzureCredential` import and usage to `ManagedIdentityCredential`. |

---

## Implementation Steps

### 1. Update `web/lib/secrets.ts`

- Change import from `DefaultAzureCredential` to `ManagedIdentityCredential`.
- Change `new DefaultAzureCredential()` to `new ManagedIdentityCredential()` in `getSecretClient()`.

### 2. Update `web/lib/api-key-crypto.ts`

- Change import from `DefaultAzureCredential` to `ManagedIdentityCredential`.
- Change `new DefaultAzureCredential()` to `new ManagedIdentityCredential()` in `getCryptoClient()`.

### 3. Update `web/app/api/cli/version/route.ts`

- Change import from `DefaultAzureCredential` to `ManagedIdentityCredential`.
- Change `new DefaultAzureCredential()` to `new ManagedIdentityCredential()` in `getBlobServiceClient()`.

### 4. Update `web/app/api/downloads/[filename]/route.ts`

- Change import from `DefaultAzureCredential` to `ManagedIdentityCredential`.
- Change `new DefaultAzureCredential()` to `new ManagedIdentityCredential()` in `getBlobServiceClient()`.

### 5. Verify no remaining `DefaultAzureCredential` uses

- Grep the entire `web/` directory for `DefaultAzureCredential`. Confirm zero results.

---

## Verification

1. **Type check**: `cd web && npx tsc --noEmit` — no errors.
2. **Grep**: `grep -r "DefaultAzureCredential" web/` — zero results.
3. **Existing tests**: `node --test test/` — all pass.
4. **Manual (deployed)**: Redeploy to App Service. Verify Key Vault secret save/read works via `/integrations`. Verify CLI download works via `/downloads`.
