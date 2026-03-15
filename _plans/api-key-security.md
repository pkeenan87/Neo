# API Key Security

## Context

API keys are currently stored as plaintext in a JSON file (`web/api-keys.json`) with no expiration, no audit trail, and no admin UI. This plan migrates them to Cosmos DB with Key Vault encryption, adds expiration and revocation support, a last-used timestamp, a 20-key-per-admin cap, and a 2-year maximum lifetime. An admin "API Keys" tab is added to `/settings` for key management. The existing JSON file remains as a fallback when Cosmos DB is not configured.

---

## Key Design Decisions

- **Partition key is `/id`** — each key record is its own partition, enabling fast point-reads by hash. This matches the spec requirement and is optimal for the lookup-by-hash access pattern.
- **SHA-256 hash as the document `id`** — the hash of the raw key serves as both the Cosmos DB document ID and partition key. This enables O(1) point-reads during authentication without a cross-partition query.
- **Key Vault `CryptographyClient` for encryption** — uses `@azure/keyvault-keys` to encrypt/decrypt the raw key with an RSA key in Key Vault (`wrapKey`/`unwrapKey` with RSA-OAEP). This is the Azure-recommended pattern for envelope encryption.
- **`findApiKey` becomes async** — the Cosmos DB lookup is async, so `findApiKey` must return `Promise<ApiKeyEntry | undefined>`. The single call site in `auth-helpers.ts` already awaits the auth resolution.
- **Fallback chain** — if Cosmos DB is not configured (`COSMOS_ENDPOINT` is empty), fall back to the JSON file. If Key Vault is not configured, the JSON fallback is the only option.
- **`userRole` passed to SettingsPage** — the settings page route already has `authCtx.userRole` available; pass it as a new prop so the API Keys tab can be conditionally rendered for admins only.
- **API routes under `/api/api-keys`** — keeps API key management routes separate from integration routes. Admin-only via `resolveAuth()`.

---

## Files to Change

| File | Change |
|------|--------|
| `web/lib/api-key-store.ts` | **Rewrite.** Add `ApiKeyRecord` interface (Cosmos document shape), `findApiKey` becomes async with Cosmos lookup + Key Vault decrypt + JSON fallback, add `createApiKey`, `revokeApiKey`, `listApiKeys`, `updateLastUsed` functions. Keep `loadKeys` and file watcher for fallback. |
| `web/lib/api-key-crypto.ts` | **New.** Key Vault encryption wrapper using `CryptographyClient` from `@azure/keyvault-keys`. Exports `encryptApiKey(raw)` and `decryptApiKey(encrypted)`. Uses `KEY_VAULT_KEY_NAME` env var for the key name. |
| `web/lib/auth-helpers.ts` | Update `resolveAuth()` to `await findApiKey(token)` (was sync). Call `updateLastUsed` after successful validation. |
| `web/lib/config.ts` | Add `KEY_VAULT_KEY_NAME` to `env` object. |
| `web/lib/types.ts` | Add `ApiKeyRecord` interface to `EnvConfig`, add `KEY_VAULT_KEY_NAME`. |
| `web/app/api/api-keys/route.ts` | **New.** `GET` (list keys for admin), `POST` (create key). Admin-only auth gate. |
| `web/app/api/api-keys/[id]/route.ts` | **New.** `DELETE` (revoke key by hash ID). Admin-only. |
| `web/app/settings/page.tsx` | Pass `userRole` prop to `SettingsPage`. |
| `web/components/SettingsPage/SettingsPage.tsx` | Add `userRole` prop, add `'api-keys'` tab (admin-only), render `ApiKeysSection`. |
| `web/components/SettingsPage/ApiKeysSection.tsx` | **New.** Client component with key table, create form, revoke button, and one-time key display modal. |
| `web/components/SettingsPage/SettingsPage.module.css` | Add styles for key table, create form, modal, and copy button. |
| `scripts/provision-cosmos-db.ps1` | Add `api-keys` container creation step (partition key `/id`, no TTL). |
| `.env.example` | Add `KEY_VAULT_KEY_NAME=neo-api-key-encryption` with comment. |
| `web/package.json` | Add `@azure/keyvault-keys` dependency. |
| `test/api-key-security.test.js` | **New.** Tests for hash lookup, expiration, revocation, and key creation. |

---

## Implementation Steps

### 1. Install dependencies and update config

- Add `@azure/keyvault-keys` to `web/package.json` via `npm install`.
- In `web/lib/types.ts`, add `KEY_VAULT_KEY_NAME: string | undefined` to `EnvConfig`.
- In `web/lib/config.ts`, add `KEY_VAULT_KEY_NAME: process.env.KEY_VAULT_KEY_NAME || "neo-api-key-encryption"` to the `env` object.
- In `.env.example`, add after the `KEY_VAULT_URL` section: `# Key Vault key name for API key encryption (used with KEY_VAULT_URL)`, `KEY_VAULT_KEY_NAME=neo-api-key-encryption`.

### 2. Create the encryption module

- Create `web/lib/api-key-crypto.ts`.
- Import `CryptographyClient`, `KeyClient` from `@azure/keyvault-keys` and `DefaultAzureCredential` from `@azure/identity`.
- Lazy-initialize a `CryptographyClient` using `env.KEY_VAULT_URL` and `env.KEY_VAULT_KEY_NAME`. The client is constructed by first getting the key reference via `KeyClient.getKey()`, then creating `CryptographyClient` from the key.
- Export `encryptApiKey(raw: string): Promise<string>`:
  - Call `cryptoClient.encrypt("RSA-OAEP", Buffer.from(raw))`.
  - Return the result as a base64 string.
- Export `decryptApiKey(encrypted: string): Promise<string>`:
  - Decode from base64, call `cryptoClient.decrypt("RSA-OAEP", buffer)`.
  - Return the decrypted string.
- If Key Vault is not configured, both functions should throw with a clear error.

### 3. Update the provisioning script

- In `scripts/provision-cosmos-db.ps1`, add a new step to create the `api-keys` container in the `neo-db` database with partition key `/id` and no TTL.
- Update the step counter (e.g., change from 7/7 to 8/8 for the managed identity step).
- In `scripts/provision-key-vault.ps1`, add a step to create an RSA key in the vault: `az keyvault key create --vault-name $KeyVaultName --name neo-api-key-encryption --kty RSA --size 2048`. The managed identity also needs the `Key Vault Crypto Officer` role (in addition to `Key Vault Secrets Officer`).

### 4. Rewrite the API key store

- In `web/lib/api-key-store.ts`, keep the existing JSON file fallback code (`loadKeys`, file watcher, `safeCompare`).
- Add the `ApiKeyRecord` interface for Cosmos documents:
  - `id: string` — SHA-256 hash of the raw key (also the partition key).
  - `encryptedKey: string` — base64-encoded Key Vault-encrypted raw key.
  - `role: Role` — admin or reader.
  - `label: string` — human-readable name.
  - `createdAt: string` — ISO 8601 timestamp.
  - `expiresAt: string | null` — ISO 8601 timestamp or null for no expiration. Maximum 2 years from creation.
  - `createdBy: string` — ownerId of the admin who created the key.
  - `revoked: boolean` — soft-delete flag.
  - `lastUsedAt: string | null` — ISO 8601 timestamp, updated on each successful validation.
- Add a lazy-initialized Cosmos container getter (`getApiKeysContainer()`) following the pattern in `usage-tracker.ts`. Return `null` if `COSMOS_ENDPOINT` is not set.
- Rewrite `findApiKey(key: string): Promise<ApiKeyEntry | undefined>`:
  - Compute SHA-256 hash of the incoming key.
  - If Cosmos is available, do a point-read: `container.item(hash, hash).read<ApiKeyRecord>()`.
  - If found, check `revoked === true` → return undefined.
  - Check `expiresAt` and compare to current time → return undefined if expired.
  - Decrypt `encryptedKey` with Key Vault, do timing-safe comparison against the incoming key.
  - If match, return `{ key, role: record.role, label: record.label }`.
  - If Cosmos is not available or the point-read fails, fall back to the JSON file lookup (existing logic).
- Add `createApiKey(label, role, expiresAt, createdBy): Promise<{ rawKey: string; record: ApiKeyRecord }>`:
  - Check active key count for `createdBy` — query Cosmos for `WHERE c.createdBy = @createdBy AND c.revoked = false`. If count >= 20, throw an error.
  - Generate a secure random key (use `crypto.randomBytes(32).toString('base64url')`).
  - Compute SHA-256 hash.
  - Encrypt the raw key with Key Vault.
  - Validate `expiresAt` is not more than 2 years from now.
  - Create the Cosmos document.
  - Return the raw key (for one-time display) and the record.
- Add `revokeApiKey(id: string): Promise<void>`:
  - Point-read the document, set `revoked = true`, replace it.
- Add `listApiKeys(createdBy?: string): Promise<ApiKeyRecord[]>`:
  - Query Cosmos for all keys, optionally filtered by `createdBy`.
  - Return records without `encryptedKey` (strip it before returning for security).
- Add `updateLastUsed(id: string): Promise<void>`:
  - Point-read, update `lastUsedAt` to current ISO string, replace. Fire-and-forget (don't await in the auth path — use `.catch(() => {})` to avoid blocking).

### 5. Update auth-helpers

- In `web/lib/auth-helpers.ts`, change the `findApiKey(token)` call to `await findApiKey(token)`. The function is already inside an async function so this is a straightforward change.
- After a successful API key match, fire-and-forget `updateLastUsed(hash)` where `hash` is the SHA-256 of the token.

### 6. Create the API routes

- Create `web/app/api/api-keys/route.ts`:
  - `GET`: authenticate via `resolveAuth()`, require `admin` role. Call `listApiKeys()`. Return the list (without encrypted keys).
  - `POST`: authenticate, require admin. Parse body `{ label, role, expiresAt? }`. Validate inputs (label required, role must be "admin" or "reader", expiresAt must be a valid future date within 2 years). Call `createApiKey(...)`. Emit audit log. Return `{ rawKey, record }` (raw key is included this one time only).
- Create `web/app/api/api-keys/[id]/route.ts`:
  - `DELETE`: authenticate, require admin. Call `revokeApiKey(id)`. Emit audit log. Return 200.
  - Sanitize error responses (generic messages to client, full errors to server logs).

### 7. Create the ApiKeysSection component

- Create `web/components/SettingsPage/ApiKeysSection.tsx` as a client component.
- Props: none (fetches data from API routes).
- On mount, fetch `GET /api/api-keys` and render a table with columns: Label, Role, Created, Expires, Last Used, Status, Actions.
- Status column: "Active" (green badge), "Expired" (gray), "Revoked" (red).
- Actions column: a "Revoke" button (calls `DELETE /api/api-keys/[id]`, confirms with a simple "Are you sure?" prompt).
- Above the table, a "Create Key" form with fields: Label (text input, required), Role (select: admin/reader), Expiration (date input, optional, max 2 years from now).
- On successful creation, show a modal/overlay displaying the raw key in a monospace font with a "Copy to Clipboard" button. The modal has a warning: "This key will only be shown once. Copy it now." The modal can be dismissed with a button or clicking outside.
- Use `aria-live` for feedback messages (success/error) following the pattern established in `IntegrationDetailPage`.
- Follow all CLAUDE.md styling rules (CSS modules, 3-class rule, design tokens, dark mode).

### 8. Update the SettingsPage

- In `web/app/settings/page.tsx`, pass `userRole={authCtx.userRole}` to `SettingsPage`.
- In `web/components/SettingsPage/SettingsPage.tsx`:
  - Add `userRole?: string` to `SettingsPageProps`.
  - Add `'api-keys'` to the `Tab` type union.
  - Conditionally add `{ value: 'api-keys', label: 'API Keys' }` to the rendered tabs only when `userRole === 'admin'`.
  - Add rendering for `activeTab === 'api-keys'` → `<ApiKeysSection />`.

### 9. Add styles

- In `web/components/SettingsPage/SettingsPage.module.css`, add styles for:
  - Key table (`.keyTable`, `.keyTableHeader`, `.keyTableRow`, `.keyTableCell`).
  - Status badges (`.badgeActive`, `.badgeExpired`, `.badgeRevoked`).
  - Create form (`.createForm`, `.createFormField`).
  - One-time key modal (`.keyModal`, `.keyModalOverlay`, `.keyModalContent`, `.keyDisplay`, `.copyButton`).
  - Dark mode overrides for all new classes.

### 10. Update .env.example

- Add `KEY_VAULT_KEY_NAME=neo-api-key-encryption` after the `KEY_VAULT_URL` entry.

### 11. Write tests

- Create `test/api-key-security.test.js` using `node:test`.
- Test SHA-256 hash computation produces consistent results.
- Test that the `ApiKeyRecord` structure validation works (required fields present).
- Test expiration check: a key with `expiresAt` in the past should be rejected.
- Test revocation check: a key with `revoked: true` should be rejected.
- Test the 2-year maximum lifetime validation on creation.
- Test the 20-key-per-admin limit validation.

---

## Verification

1. **Type check**: Run `cd web && npx tsc --noEmit` — no errors.
2. **Tests**: Run `node --test test/api-key-security.test.js` — all pass.
3. **Fallback**: Start with `COSMOS_ENDPOINT` unset. Verify existing `api-keys.json` authentication still works.
4. **Cosmos path**: With Cosmos configured, create a key via the UI. Verify it appears in Cosmos DB. Use it to authenticate a CLI request.
5. **Expiration**: Create a key with a short expiration (e.g., 1 minute). Verify it works, wait for expiry, verify it's rejected.
6. **Revocation**: Create a key, use it successfully, revoke it via the UI, verify it's rejected.
7. **One-time display**: Create a key, copy it, dismiss the modal. Verify the raw key is not visible in the table or retrievable via the API.
8. **20-key limit**: Attempt to create 21 keys for the same admin. Verify the 21st is rejected.
9. **Last used**: Use a key, check the table — "Last Used" column should show the timestamp.
10. **Audit log**: Check console/Event Hub for key creation and revocation log entries.
