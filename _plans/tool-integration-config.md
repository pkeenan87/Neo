# Tool Integration Config Overhaul

## Context

This plan migrates tool secrets (Azure AD credentials, Sentinel workspace metadata) from environment variables to Azure Key Vault and adds an admin-only `/integrations` UI for managing them. The feature allows admins to configure tool credentials without redeploying. A fallback to env vars ensures backward compatibility when Key Vault is not configured. The integration registry is defined in code (TypeScript), and the UI follows the existing component patterns (CSS Modules, barrel exports, 3-class inline rule).

---

## Key Design Decisions

- **Key Vault client uses `DefaultAzureCredential`** — same auth pattern as Cosmos DB and Blob Storage. Managed identity in production, `az login` locally.
- **Integration registry in code** — a `web/lib/integration-registry.ts` file defines all integrations declaratively. This avoids a Cosmos dependency and keeps the registry versioned with the codebase.
- **Secrets module (`web/lib/secrets.ts`)** abstracts Key Vault reads/writes and env var fallback. All consumers (auth.ts, executors.ts) call this module instead of reading `env.*` directly for tool secrets.
- **Secrets are cached in memory on first read** with a TTL (5 minutes). Key Vault is not hit on every tool call.
- **The API never returns secret values** — only boolean flags indicating whether each secret is configured. The form uses masked placeholders and only sends values when the admin changes them.
- **Test Connection** is implemented per-integration as a lightweight probe (e.g., request an OAuth token for Azure AD, query a single Sentinel incident) to validate credentials before committing them.
- **Audit log entries** are emitted via the existing `logger` for secret create/update/delete events with component `"integrations"`.

---

## Files to Change

| File | Change |
|------|--------|
| `scripts/provision-key-vault.ps1` | **New.** PowerShell script to create Key Vault, set access policies, assign RBAC role to web app managed identity. |
| `web/lib/secrets.ts` | **New.** Key Vault client wrapper with `getSecret(name)`, `setSecret(name, value)`, `deleteSecret(name)`, `getSecretStatus(names)` (returns configured booleans). Fallback to env vars when `KEY_VAULT_URL` is empty. In-memory cache with TTL. |
| `web/lib/integration-registry.ts` | **New.** Declarative registry of integrations. Each entry: `slug`, `name`, `icon` (Lucide icon name), `description`, `capabilities` (tool names), `secrets` array (each with `key`, `label`, `description`, `required`). Exports `INTEGRATIONS` array and `getIntegration(slug)` helper. |
| `web/lib/auth.ts` | Update `getAzureToken()` to read `AZURE_TENANT_ID`, `AZURE_CLIENT_ID`, `AZURE_CLIENT_SECRET` from the secrets module instead of `env.*`. |
| `web/lib/executors.ts` | Update `run_sentinel_kql` and `get_sentinel_incidents` to read `SENTINEL_WORKSPACE_ID`, `SENTINEL_RG`, `SENTINEL_WORKSPACE_NAME`, `AZURE_SUBSCRIPTION_ID` from the secrets module instead of `env.*`. |
| `web/lib/config.ts` | Add `KEY_VAULT_URL` to `env` object. Keep existing tool env vars for fallback but mark them as deprecated in comments. |
| `web/lib/types.ts` | Add `IntegrationInfo`, `IntegrationSecret`, and `SecretStatus` type definitions. |
| `web/app/integrations/page.tsx` | **New.** Server component. Admin-only gate via `getAuthContext()`. Renders `IntegrationsPage` component with the registry data and secret statuses. |
| `web/app/integrations/[slug]/page.tsx` | **New.** Server component. Admin-only gate. Fetches integration by slug from registry, fetches secret statuses from secrets module, renders `IntegrationDetailPage`. |
| `web/app/api/integrations/[slug]/route.ts` | **New.** `PUT` handler to save secrets for an integration. `DELETE` handler to remove secrets. Admin-only via `resolveAuth()`. Validates required fields. Writes to Key Vault via secrets module. Emits audit log. |
| `web/app/api/integrations/[slug]/test/route.ts` | **New.** `POST` handler to test connection for an integration. Admin-only. Runs a lightweight probe per integration type and returns success/failure. |
| `web/components/IntegrationsPage/IntegrationsPage.tsx` | **New.** Client component. Search bar + responsive card grid. Each card shows icon, name, description, and config status badge. Cards link to `/integrations/[slug]`. |
| `web/components/IntegrationsPage/IntegrationsPage.module.css` | **New.** Styles for grid layout, search bar, cards, status badges. |
| `web/components/IntegrationsPage/index.ts` | **New.** Barrel export. |
| `web/components/IntegrationDetailPage/IntegrationDetailPage.tsx` | **New.** Client component. Shows integration header (icon, name, description), capabilities list (tool names), and config form with masked fields, tooltips, save button, and test connection button. |
| `web/components/IntegrationDetailPage/IntegrationDetailPage.module.css` | **New.** Styles for detail layout, form fields, tooltips, buttons. |
| `web/components/IntegrationDetailPage/index.ts` | **New.** Barrel export. |
| `web/components/index.ts` | Add exports for `IntegrationsPage` and `IntegrationDetailPage`. |
| `.env.example` | Add `KEY_VAULT_URL=` with a comment. |
| `test/integration-registry.test.js` | **New.** Tests for the registry and secrets fallback logic. |

---

## Implementation Steps

### 1. Create the provisioning script

- Create `scripts/provision-key-vault.ps1` following the pattern of `provision-cosmos-db.ps1`.
- Parameters: `$ResourceGroupName` (default `"neo-rg"`), `$KeyVaultName` (default `"neo-vault"`), `$Location` (default `"eastus"`), `$WebAppName` (optional).
- Steps: create resource group (if needed), create Key Vault with `az keyvault create` (enable RBAC authorization, purge protection, soft delete), assign `Key Vault Secrets Officer` role to the web app's managed identity (if `$WebAppName` provided), output the `KEY_VAULT_URL` for `.env`.
- Idempotent — skip existing resources.

### 2. Add `KEY_VAULT_URL` to config

- In `web/lib/config.ts`, add `KEY_VAULT_URL: process.env.KEY_VAULT_URL` to the `env` object.
- Add `KEY_VAULT_URL` to the `EnvConfig` interface in `web/lib/types.ts`.
- In `.env.example`, add a new section after the CLI Downloads block: `# Azure Key Vault (optional — for managing tool secrets via /integrations UI)`, `KEY_VAULT_URL=`.

### 3. Create the secrets module

- Create `web/lib/secrets.ts`.
- Import `SecretClient` from `@azure/keyvault-secrets` and `DefaultAzureCredential` from `@azure/identity`.
- Lazy-initialize the `SecretClient` on first call (only if `env.KEY_VAULT_URL` is set).
- Implement `getToolSecret(name: string): Promise<string | undefined>`:
  - Check in-memory cache first (Map with `{ value, expiresAt }`, TTL of 5 minutes).
  - If Key Vault is configured, try `secretClient.getSecret(name)`. On success, cache and return.
  - On any Key Vault error, log a warning and fall back to `process.env[name]`.
  - If Key Vault is not configured, return `process.env[name]`.
- Implement `setToolSecret(name: string, value: string): Promise<void>`:
  - Require Key Vault to be configured; throw if not.
  - Call `secretClient.setSecret(name, value)`.
  - Update the in-memory cache.
- Implement `deleteToolSecret(name: string): Promise<void>`:
  - Call `secretClient.beginDeleteSecret(name)`.
  - Remove from the in-memory cache.
- Implement `getSecretStatuses(names: string[]): Promise<Record<string, boolean>>`:
  - For each name, check if Key Vault has the secret (try `getSecret`, return true/false). If Key Vault is not configured, check `process.env[name]`.
  - Return a map of secret name to boolean.
- Install `@azure/keyvault-secrets` as a dependency in `web/package.json`. (`@azure/identity` is already installed.)

### 4. Create the integration registry

- Create `web/lib/integration-registry.ts`.
- Define the `IntegrationInfo` interface (or import from types): `slug`, `name`, `iconName` (Lucide icon string), `description`, `capabilities` (array of tool names this integration powers), `secrets` (array of `{ key: string, label: string, description: string, required: boolean }`).
- Export a `INTEGRATIONS` array with three entries:
  - **microsoft-sentinel**: slug `"microsoft-sentinel"`, name `"Microsoft Sentinel"`, icon `"Shield"`, description about SIEM and KQL queries, capabilities `["run_sentinel_kql", "get_sentinel_incidents"]`, secrets for all 7 keys (AZURE_TENANT_ID, AZURE_CLIENT_ID, AZURE_CLIENT_SECRET, AZURE_SUBSCRIPTION_ID, SENTINEL_WORKSPACE_ID, SENTINEL_WORKSPACE_NAME, SENTINEL_RESOURCE_GROUP) with descriptive labels and tooltips.
  - **microsoft-defender-xdr**: slug `"microsoft-defender-xdr"`, name `"Microsoft Defender XDR"`, icon `"ShieldAlert"`, description about endpoint detection and response, capabilities `["get_xdr_alert", "search_xdr_by_host", "isolate_machine", "unisolate_machine"]`, secrets for the 3 Azure AD keys.
  - **microsoft-entra-id**: slug `"microsoft-entra-id"`, name `"Microsoft Entra ID"`, icon `"Users"`, description about identity and access management, capabilities `["get_user_info", "reset_user_password"]`, secrets for the 3 Azure AD keys.
- Export a `getIntegration(slug: string)` helper that returns the matching entry or undefined.

### 5. Update auth.ts to use secrets module

- In `web/lib/auth.ts`, import `getToolSecret` from `./secrets`.
- Change `getAzureToken()` to be async for secret retrieval (it already is).
- Replace `const { AZURE_TENANT_ID, AZURE_CLIENT_ID, AZURE_CLIENT_SECRET } = env;` with three `await getToolSecret(...)` calls.
- Update the error message to reference both Key Vault and env vars.

### 6. Update executors.ts to use secrets module

- In `web/lib/executors.ts`, import `getToolSecret` from `./secrets`.
- In `run_sentinel_kql`, replace `env.SENTINEL_WORKSPACE_ID` with `await getToolSecret("SENTINEL_WORKSPACE_ID")`.
- In `get_sentinel_incidents`, replace `env.AZURE_SUBSCRIPTION_ID`, `env.SENTINEL_RG`, and `env.SENTINEL_WORKSPACE_NAME` with `await getToolSecret(...)` calls.
- Add a guard that throws a clear error if any required secret is missing (instead of silently building a malformed URL).

### 7. Create the API routes

- Create `web/app/api/integrations/[slug]/route.ts`:
  - `PUT` handler: authenticate via `resolveAuth()`, require `admin` role, parse JSON body `{ secrets: Record<string, string> }`, look up integration from registry by slug (404 if not found), validate all required secrets are present, call `setToolSecret()` for each, emit audit log via `logger.info("Integration secrets updated", "integrations", { slug, secretKeys })`, return 200.
  - `DELETE` handler: authenticate, require admin, look up integration, call `deleteToolSecret()` for each of its secrets, emit audit log, return 200.
- Create `web/app/api/integrations/[slug]/test/route.ts`:
  - `POST` handler: authenticate, require admin, look up integration.
  - Per integration type, run a lightweight probe:
    - **microsoft-sentinel**: call `getAzureToken("https://api.loganalytics.io")` and verify it succeeds.
    - **microsoft-defender-xdr**: call `getAzureToken("https://api.securitycenter.microsoft.com")` and verify.
    - **microsoft-entra-id**: call `getMSGraphToken()` and verify.
  - Return `{ success: true }` or `{ success: false, error: "..." }`.

### 8. Create the IntegrationsPage component

- Create `web/components/IntegrationsPage/` with `IntegrationsPage.tsx`, `IntegrationsPage.module.css`, and `index.ts`.
- Props: `integrations` (array of integration info with secret statuses).
- Client component (`'use client'`).
- Render a search input at the top that filters integrations by name and description (case-insensitive substring match, client-side).
- Render a responsive CSS Grid of cards (3 columns on desktop, 2 on tablet, 1 on mobile).
- Each card: Lucide icon, integration name, description (truncated to 2 lines), and a status badge ("Configured" in green, "Partially Configured" in amber, "Not Configured" in gray).
- Each card wraps a `next/link` to `/integrations/[slug]`.
- Follow all CLAUDE.md styling rules: 3-class inline rule, CSS modules with `@reference`, design tokens, semantic class names, 8pt grid spacing, dark mode support.

### 9. Create the IntegrationDetailPage component

- Create `web/components/IntegrationDetailPage/` with `IntegrationDetailPage.tsx`, `IntegrationDetailPage.module.css`, and `index.ts`.
- Props: `integration` (registry entry), `secretStatuses` (Record of key to boolean), `serverUrl` (for API calls).
- Client component.
- Layout: back link to `/integrations`, integration header (icon, name, description), capabilities section (list of tool names this integration powers), and config form.
- Config form: one field per secret in the integration's `secrets` array. Each field has a label and a tooltip (info icon with the secret's description). If the secret is already configured, show a masked placeholder. Fields are password-type inputs.
- Save button at the bottom of the form. On submit, `PUT /api/integrations/[slug]` with the filled secrets. Show success/error feedback.
- Test Connection button: `POST /api/integrations/[slug]/test`. Show success (green check) or failure (red error with message).
- Follow all CLAUDE.md styling rules.

### 10. Create the page routes

- Create `web/app/integrations/page.tsx`:
  - Server component. Call `getAuthContext()`, redirect to `/` if not authenticated, redirect to `/` if role is not `admin`.
  - Import `INTEGRATIONS` from registry, call `getSecretStatuses()` for all unique secret keys across all integrations.
  - Pass integrations + statuses to `IntegrationsPage` component.
- Create `web/app/integrations/[slug]/page.tsx`:
  - Server component. Same auth gate.
  - Look up integration by slug from params. Return `notFound()` if not in registry.
  - Call `getSecretStatuses()` for this integration's secret keys.
  - Pass integration + statuses to `IntegrationDetailPage`.

### 11. Update barrel exports

- In `web/components/index.ts`, add exports for `IntegrationsPage` and `IntegrationDetailPage`.

### 12. Update .env.example

- Add after the CLI Downloads section:
  - Comment: `# Azure Key Vault (optional — for managing tool secrets via /integrations admin UI)`
  - Comment: `# Uses Managed Identity auth — no connection string needed.`
  - Comment: `# Omit to use environment variables for tool secrets (existing behavior).`
  - Variable: `KEY_VAULT_URL=`

### 13. Write tests

- Create `test/integration-registry.test.js` using `node:test`.
- Test: `INTEGRATIONS` array has 3 entries with expected slugs.
- Test: `getIntegration("microsoft-sentinel")` returns correct entry.
- Test: `getIntegration("nonexistent")` returns undefined.
- Test: each integration has at least one capability and one secret.
- Test: all capabilities reference valid tool names from `TOOLS`.
- For secrets module testability, test the env var fallback logic by mocking `process.env` (with Key Vault URL unset, `getToolSecret` should return `process.env[name]`).

---

## Verification

1. **Provisioning**: Run `./scripts/provision-key-vault.ps1` in a test Azure subscription. Verify the Key Vault is created and the `KEY_VAULT_URL` is output.
2. **Fallback**: Start the web server with `KEY_VAULT_URL` empty. Verify all 8 tools work normally using env vars (no behavioral change from before).
3. **Key Vault integration**: Set `KEY_VAULT_URL`, manually write a secret with `az keyvault secret set`, verify the tool reads it from Key Vault.
4. **Integrations page**: Navigate to `/integrations` as admin. Verify 3 cards render with correct icons, names, and status badges. Verify search filters correctly.
5. **Non-admin gate**: Navigate to `/integrations` as a reader. Verify redirect to `/`.
6. **Integration detail**: Click a card, verify the detail page shows capabilities and form fields with correct tooltips.
7. **Save secrets**: Fill in credentials and click Save. Verify they are written to Key Vault (`az keyvault secret show`). Verify the card status updates.
8. **Test connection**: Click Test Connection. Verify success/failure feedback.
9. **Audit log**: Check console or Event Hub for `"Integration secrets updated"` log entries after saving.
10. **Tests**: Run `node --test test/integration-registry.test.js` — all tests pass.
11. **Type check**: Run `cd web && npx tsc --noEmit` — no errors.
