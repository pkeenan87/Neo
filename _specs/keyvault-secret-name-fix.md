# Spec for Key Vault Secret Name Fix

branch: claude/feature/keyvault-secret-name-fix

## Summary

Azure Key Vault secret names only allow alphanumeric characters and dashes — underscores are not permitted. The integration registry uses secret keys with underscores (e.g. `AZURE_TENANT_ID`) which causes Key Vault API calls to fail when admins save integration credentials via `/integrations`. The fix adds a name-conversion layer in the secrets module that translates between the application's underscore convention and Key Vault's dash convention transparently.

## Functional requirements

- The `secrets.ts` module converts secret names from underscore format (`AZURE_TENANT_ID`) to dash format (`AZURE-TENANT-ID`) before any Key Vault API call (get, set, delete).
- The conversion is transparent — callers (auth.ts, executors.ts, integration API routes) continue using underscore names.
- The env var fallback path is unaffected — `process.env[name]` continues to use underscore names since env vars support underscores.
- Existing secrets already stored in Key Vault with underscore names (which would have failed) are not a concern since no secrets could have been successfully created with the old names.
- The `getSecretStatuses` function works correctly with the name conversion.

## Possible Edge Cases

- A secret name that contains only dashes and no underscores — should pass through unchanged.
- The in-memory cache should use the original underscore name as the key (since that's what callers use for lookup), not the converted dash name.
- Key Vault secret names are case-insensitive but case-preserving — the conversion should lowercase for consistency.

## Acceptance Criteria

- Saving integration credentials via the `/integrations/[slug]` UI succeeds without Key Vault errors.
- Reading credentials back (via `getToolSecret`) returns the correct values.
- The env var fallback (`process.env[name]`) still works with underscore names when Key Vault is not configured.
- The `getSecretStatuses` function correctly reports configured/unconfigured for all secrets.
- All existing tests pass.

## Open Questions

- None — the fix is a straightforward name translation in the secrets module.

## Testing Guidelines

Create test file(s) in the `./test` folder for the new feature, and create meaningful tests for the following cases, without going too heavy:

- Underscore names are converted to dashes for Key Vault calls.
- Names without underscores pass through unchanged.
- The cache uses the original caller-provided name, not the converted name.
