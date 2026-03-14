# Spec for Tool Integration Config Overhaul

branch: claude/feature/tool-integration-config

## Summary

Move all tool-related secrets (Azure AD credentials, Sentinel workspace metadata) out of environment variables and into Azure Key Vault. Add an admin-only `/integrations` page where administrators can browse available integrations, view their capabilities, and configure credentials through a form — without redeploying the application. Tools continue to function identically but resolve their secrets from Key Vault at runtime instead of from `.env`.

## Functional requirements

- A new Azure Key Vault is provisioned via a PowerShell script (following the pattern of existing `scripts/provision-*.ps1`). The Key Vault URL is stored in a single new environment variable (`KEY_VAULT_URL`).
- On server startup, the application connects to Key Vault using `DefaultAzureCredential` (managed identity in production, `az login` locally) and loads tool secrets. If Key Vault is unavailable, the application falls back to environment variables so existing deployments are not broken.
- A new `/integrations` page (admin-only) displays all available integrations as cards in a searchable grid layout, inspired by the Zapier apps directory. Each card shows an icon, title, and short description.
- Clicking an integration card navigates to `/integrations/[slug]`, which shows the integration's icon, description, an overview of the tools/capabilities it provides, and a configuration form.
- The configuration form renders one field per required secret for that integration. Each field has a tooltip describing the parameter. Existing values are shown as masked placeholders (e.g. `••••••••`) — never displayed in plain text.
- Submitting the form calls a new API route that writes the secrets to Key Vault. The API validates that the caller has the `admin` role.
- All tool executors are updated to read secrets from the Key Vault-backed config instead of directly from `env.*`. The existing `getAzureToken()` function in `auth.ts` is updated to use the Key Vault-sourced credentials.
- The integrations are defined declaratively in a registry (not hard-coded per page). Each integration entry specifies: slug, display name, icon, description, capabilities (which tools it powers), and required secret keys.
- The initial set of integrations includes:
  - **Microsoft Sentinel** — powers `run_sentinel_kql` and `get_sentinel_incidents`. Secrets: `AZURE_TENANT_ID`, `AZURE_CLIENT_ID`, `AZURE_CLIENT_SECRET`, `AZURE_SUBSCRIPTION_ID`, `SENTINEL_WORKSPACE_ID`, `SENTINEL_WORKSPACE_NAME`, `SENTINEL_RESOURCE_GROUP`.
  - **Microsoft Defender XDR** — powers `get_xdr_alert`, `search_xdr_by_host`, `isolate_machine`, `unisolate_machine`. Secrets: `AZURE_TENANT_ID`, `AZURE_CLIENT_ID`, `AZURE_CLIENT_SECRET`.
  - **Microsoft Entra ID** — powers `get_user_info`, `reset_user_password`. Secrets: `AZURE_TENANT_ID`, `AZURE_CLIENT_ID`, `AZURE_CLIENT_SECRET`.
- Shared secrets (e.g. `AZURE_TENANT_ID` used by all three integrations) are stored once in Key Vault and referenced by all integrations that need them.
- Infrastructure secrets (`ANTHROPIC_API_KEY`, `AUTH_SECRET`, `AUTH_MICROSOFT_ENTRA_ID_*`, `MICROSOFT_APP_*`, `EVENT_HUB_CONNECTION_STRING`, `COSMOS_ENDPOINT`, `CLI_STORAGE_ACCOUNT`) remain as environment variables — they are not part of this feature.

## Possible Edge Cases

- Key Vault is unreachable at startup — fall back to environment variables and log a warning. Tools should still work if env vars are populated.
- Key Vault is unreachable when saving from the UI — return a clear error to the admin rather than a generic 500.
- Admin saves partial credentials (e.g. client ID without client secret) — the form should validate that all required fields for an integration are provided before submitting.
- Secret values contain special characters — ensure no encoding issues when writing to or reading from Key Vault.
- Multiple admins editing the same integration simultaneously — last write wins is acceptable; no locking needed.
- MOCK_MODE is true — tools should continue to return mock data regardless of whether Key Vault secrets are configured. The integrations UI should still be accessible so admins can pre-configure credentials.
- An integration has some but not all secrets configured — the integration detail page should show which fields are configured (masked) vs missing, and the integration card should indicate its configuration status (configured / partially configured / not configured).

## Acceptance Criteria

- A provisioning script (`scripts/provision-key-vault.ps1`) creates the Key Vault, sets access policies, and outputs the `KEY_VAULT_URL` for `.env`.
- The `/integrations` page is only accessible to users with the `admin` role; non-admins are redirected.
- Integrations are displayed as cards with icon, title, and description in a responsive grid with a search bar.
- Clicking a card navigates to `/integrations/[slug]` showing the detail view and configuration form.
- Submitting the form writes secrets to Key Vault via an admin-only API route.
- Existing secrets are shown as masked placeholders; clearing a field and submitting removes the secret.
- All 8 existing tools continue to function using Key Vault-sourced credentials.
- When Key Vault is not configured (`KEY_VAULT_URL` is empty), the application falls back to environment variables with no behavioral change.
- The `.env.example` file includes the new `KEY_VAULT_URL` variable with a comment.

## Open Questions

- Should there be a "Test Connection" button on the integration detail page that validates the credentials work before saving? Yes.
- Should the integration registry be stored in code (a TypeScript file) or in Cosmos DB to allow future dynamic addition of integrations? in code.
- Should there be an audit log entry when secrets are created, updated, or deleted via the UI? Yes.

## Testing Guidelines

Create test file(s) in the `./test` folder for the new feature, and create meaningful tests for the following cases, without going too heavy:

- Integration registry returns all expected integrations with correct metadata.
- Key Vault secret read falls back to environment variable when Key Vault is unavailable.
- API route for saving secrets rejects non-admin callers with 403.
- API route for saving secrets validates required fields are present.
- Integration detail page correctly identifies configured vs missing secrets.
- Search filtering on the integrations page matches by name and description.
