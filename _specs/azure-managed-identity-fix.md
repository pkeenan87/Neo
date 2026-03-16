# Spec for Azure Managed Identity Fix

branch: claude/feature/azure-managed-identity-fix

## Summary

The App Service fails to authenticate to Azure infrastructure (Key Vault, Blob Storage) because `DefaultAzureCredential` picks up the `AZURE_CLIENT_ID` and `AZURE_CLIENT_SECRET` environment variables that are set for tool execution (Sentinel, Defender, Entra ID). This causes infrastructure connections to use the service principal instead of the App Service's managed identity. The fix replaces `DefaultAzureCredential` with `ManagedIdentityCredential` in all infrastructure-access code paths so tool credentials never interfere with infrastructure auth.

## Functional requirements

- All infrastructure clients (Key Vault `SecretClient`, Key Vault `KeyClient`/`CryptographyClient`, Blob Storage `BlobServiceClient`) use `ManagedIdentityCredential` instead of `DefaultAzureCredential`.
- The Cosmos DB clients (conversation store, usage tracker, teams mapping store, api key store) already use `ManagedIdentityCredential` and are unaffected.
- Tool execution credentials (`AZURE_TENANT_ID`, `AZURE_CLIENT_ID`, `AZURE_CLIENT_SECRET`) remain in env vars / Key Vault for the `getAzureToken()` OAuth2 flow in `auth.ts` — that flow uses direct HTTP calls, not Azure SDK credentials.
- In local development (without managed identity), `ManagedIdentityCredential` will fail and the code should fall back gracefully — Key Vault returns null (env var fallback), Blob Storage returns 503 (already handled).

## Possible Edge Cases

- Local development without `az login` — `ManagedIdentityCredential` will fail. This is acceptable because: Key Vault secrets fall back to env vars, and Blob Storage/CLI downloads are optional.
- The `api-key-crypto.ts` Key Vault keys client also needs the change — it uses `DefaultAzureCredential` for both `KeyClient` and `CryptographyClient`.

## Acceptance Criteria

- The deployed App Service successfully connects to Key Vault for reading/writing integration secrets.
- The deployed App Service successfully serves CLI installer downloads from Blob Storage.
- The deployed App Service successfully encrypts/decrypts API keys via Key Vault.
- Tool execution (Sentinel KQL, Defender alerts, Entra ID lookups) continues to work using the service principal credentials.
- Local dev with `MOCK_MODE=true` is unaffected.
- All existing tests pass.

## Open Questions

- None.

## Testing Guidelines

No new test files needed — this is a credential-type swap with no logic changes. Verify via:

- Type check passes.
- Existing tests pass.
- Manual: deploy to App Service and confirm Key Vault + Blob Storage connections work.
