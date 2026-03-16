# Key Vault Secret Name Fix

## Context

Azure Key Vault secret names only allow alphanumeric characters and dashes — underscores are rejected with a 400 error. The application uses underscore-based names like `AZURE_TENANT_ID` everywhere (env vars, integration registry, executors). The fix adds a single name-conversion helper in `secrets.ts` that translates underscores to dashes before Key Vault API calls, keeping the cache and env var fallback on the original underscore names.

---

## Key Design Decisions

- **Conversion in one place** — A `toKvName(name)` helper inside `secrets.ts` handles all translation. No other files need to change.
- **Cache uses caller names** — The in-memory cache keys on the original underscore name (e.g. `AZURE_TENANT_ID`), since that's what callers pass to `getToolSecret`. Only the Key Vault API call uses the converted name.
- **Lowercase the converted name** — Key Vault names are case-insensitive, so `azure-tenant-id` is cleaner than `AZURE-TENANT-ID` and avoids case-sensitivity surprises.
- **Env var fallback unchanged** — `process.env[name]` continues to use the original underscore name.

---

## Files to Change

| File | Change |
|------|--------|
| `web/lib/secrets.ts` | Add `toKvName()` helper. Apply it in `getToolSecret`, `setToolSecret`, `deleteToolSecret` — only on the `client.getSecret()`, `client.setSecret()`, and `client.beginDeleteSecret()` calls. Cache operations stay on the original name. |
| `test/keyvault-secret-names.test.js` | **New.** Tests for the name conversion logic. |

---

## Implementation Steps

### 1. Add the name conversion helper

- In `web/lib/secrets.ts`, add an exported function `toKvName(name: string): string` that replaces all underscores with dashes and lowercases the result.
- The function is pure and has no side effects.

### 2. Apply the conversion in Key Vault calls

- In `getToolSecret`: change `client.getSecret(name)` to `client.getSecret(toKvName(name))`. The cache check and cache write continue to use `name` (the original underscore form).
- In `setToolSecret`: change `client.setSecret(name, value)` to `client.setSecret(toKvName(name), value)`. The cache write continues to use `name`.
- In `deleteToolSecret`: change `client.beginDeleteSecret(name)` to `client.beginDeleteSecret(toKvName(name))`. The cache delete continues to use `name`.

### 3. Write tests

- Create `test/keyvault-secret-names.test.js`.
- Test: `toKvName("AZURE_TENANT_ID")` returns `"azure-tenant-id"`.
- Test: `toKvName("SENTINEL_WORKSPACE_NAME")` returns `"sentinel-workspace-name"`.
- Test: `toKvName("already-dashed")` returns `"already-dashed"`.
- Test: `toKvName("NoDashes")` returns `"nodashes"`.
- Test: `toKvName("")` returns `""`.

---

## Verification

1. **Type check**: `cd web && npx tsc --noEmit` — no errors.
2. **Tests**: `node --test test/keyvault-secret-names.test.js` — all pass.
3. **Existing tests**: `node --test test/` — all pass.
4. **Manual**: Save integration credentials via `/integrations/microsoft-sentinel`. Verify secrets appear in Key Vault with dashed names (e.g. `azure-tenant-id`). Verify the agent can read them back and authenticate.
