# Spec for API Key Security

branch: claude/feature/api-key-security

## Summary

Migrate API keys from a static JSON file (`api-keys.json`) to Cosmos DB with encryption via Azure Key Vault. Add an admin UI under `/settings` for creating, viewing, revoking, and rotating API keys. Keys are encrypted at rest using a Key Vault encryption key, decrypted on validation, and support expiration dates and role assignment.

## Functional requirements

- API keys are stored in a dedicated Cosmos DB container (`api-keys`) with partition key `/id`.
- Each key record includes: `id`, `keyHash` (SHA-256 hash for lookup), `encryptedKey` (AES-256-GCM encrypted with a Key Vault key), `role` (admin or reader), `label` (human-readable name), `createdAt`, `expiresAt` (optional), `createdBy`, and `revoked` (boolean).
- On creation, the raw API key is generated securely, encrypted with a Key Vault encryption key, and stored. The raw key is shown to the admin exactly once (on creation) and never again.
- On validation (`findApiKey`), the system hashes the incoming key with SHA-256 and looks it up in Cosmos DB by hash. If found and not revoked/expired, it decrypts the stored key with Key Vault and performs a timing-safe comparison.
- Admins can manage API keys via a new "API Keys" tab or section under `/settings`. The UI shows a table of keys with label, role, creation date, expiration status, and a revoke button. A "Create Key" form allows setting a label, role, and optional expiration.
- On creation, the new key is displayed in a one-time-view modal with a copy button. Once dismissed, the raw key cannot be retrieved again.
- Admins can revoke a key (soft delete — sets `revoked: true`), which immediately invalidates it.
- The existing `api-keys.json` file continues to work as a fallback for deployments without Cosmos DB, preserving backward compatibility.
- The file watcher on `api-keys.json` remains active for the fallback path.
- The Key Vault encryption key is a symmetric key (or an RSA key for wrap/unwrap) managed in the same Key Vault provisioned by `scripts/provision-key-vault.ps1`. The key name is configurable via an environment variable (`KEY_VAULT_KEY_NAME`, default: `neo-api-key-encryption`).

## Possible Edge Cases

- Cosmos DB is unavailable — fall back to `api-keys.json` with a logged warning.
- Key Vault is unavailable during key creation — return a clear error to the admin.
- Key Vault is unavailable during key validation — fall back to `api-keys.json` if available.
- Admin creates a key with a label that already exists — allow it (labels are not unique identifiers).
- Admin revokes a key that is currently in use by an active CLI session — the next API call with that key fails with 401.
- Key expires mid-session — the next API call with that key fails with 401.
- Migration from `api-keys.json` to Cosmos DB — provide a one-time migration utility or document the manual migration process.
- Multiple admins create keys simultaneously — Cosmos DB handles concurrency natively.
- The one-time key display modal is accidentally dismissed — the key is lost and a new one must be created.

## Acceptance Criteria

- API keys are stored encrypted in Cosmos DB with SHA-256 hashes for lookup.
- The `/settings` page has an "API Keys" section visible only to admins.
- Admins can create a new key with label, role, and optional expiration.
- The raw key is displayed exactly once on creation with a copy-to-clipboard button.
- Admins can revoke keys, which immediately invalidates them.
- The key table shows label, role, created date, expiration, and revoked status.
- Expired and revoked keys are rejected during authentication with a 401 response.
- When Cosmos DB is not configured, the system falls back to `api-keys.json` with no behavioral change.
- Audit log entries are emitted for key creation and revocation.

## Open Questions

- Should there be a key rotation flow (create new key + grace period on old key)? Keys should be valid for a maximum of two years.
- Should the key table show the last-used timestamp for each key? yes.
- Should there be a limit on the number of active keys per admin? Yes, lets set it high just to prevent against accidents. Max of 20 active keys.

## Testing Guidelines

Create test file(s) in the `./test` folder for the new feature, and create meaningful tests for the following cases, without going too heavy:

- Key hash lookup finds the correct key record.
- Expired keys are rejected during validation.
- Revoked keys are rejected during validation.
- Key creation generates a valid key with all required fields.
- Fallback to `api-keys.json` works when Cosmos DB is unavailable.
- Admin-only access control on the API key management endpoints.
