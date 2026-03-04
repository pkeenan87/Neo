# Azure Deploy Scripts

## Context

Implement two PowerShell utility scripts for Azure App Service deployment of the Neo web application. There is currently no deployment infrastructure — no scripts, no CI/CD, no Docker configuration. The provisioning script creates the Azure Resource Group, App Service Plan, and Web App. The deploy script builds the Next.js app using standalone output mode and deploys via zip deploy. Both scripts are parameterized, idempotent, and validate prerequisites before making changes.

---

## Key Design Decisions

- **Standalone output mode**: Add `output: 'standalone'` to `next.config.js` so the build produces a self-contained server (~50 MB) instead of requiring the full `node_modules/` (~300+ MB). The deploy script packages only the standalone output, `public/`, and static assets. This dramatically reduces deployment size and startup time.
- **Zip Deploy over Local Git**: Zip Deploy via `az webapp deploy` is the simplest, most scriptable method. It requires no git remote setup, works with any build output, and is natively idempotent (each deploy replaces the previous).
- **Secrets kept separate**: The provisioning script sets only non-secret app settings (`MOCK_MODE`, `WEBSITE_NODE_DEFAULT_VERSION`). Secrets (`ANTHROPIC_API_KEY`, Azure credentials, `AUTH_SECRET`) are documented but must be set manually via `az webapp config appsettings set` or the Azure Portal to avoid leaking them in terminal history.
- **Linux App Service Plan**: Next.js standalone output runs best on Linux. The provisioning script defaults to Linux (`--is-linux`) with a `B1` tier (cheapest production-capable SKU). The admin can override via parameters.
- **Shared prerequisite validation**: Both scripts need identical checks (Azure CLI installed, logged in, correct subscription). Each script includes its own validation block at the top rather than sharing a module — PowerShell script dot-sourcing adds complexity for two simple scripts.

---

## Files to Change

| File | Change |
|------|--------|
| `scripts/provision-azure.ps1` | New file — creates Resource Group, App Service Plan, and Web App with Node.js 20 runtime |
| `scripts/deploy-azure.ps1` | New file — builds Next.js standalone, packages as zip, deploys via `az webapp deploy` |
| `web/next.config.js` | Add `output: 'standalone'` to enable self-contained build output |

---

## Implementation Steps

### 1. Add `output: 'standalone'` to `web/next.config.js`

- Add `output: "standalone"` as a top-level property in the `nextConfig` object, alongside the existing `poweredByHeader: false`
- This tells Next.js to produce a self-contained server in `.next/standalone/` that includes only the necessary `node_modules` dependencies
- The standalone output uses `server.js` as its entry point instead of `next start`
- Existing `poweredByHeader`, `serverExternalPackages`, `turbopack`, and `headers()` config remain unchanged

### 2. Create `scripts/` directory

- Create the `scripts/` directory at the repo root (sibling to `web/`, `cli/`, `docs/`)

### 3. Create `scripts/provision-azure.ps1`

The script accepts these parameters (all with defaults except none required — sensible defaults provided):

- `-ResourceGroupName` (default: `"neo-rg"`)
- `-AppServicePlanName` (default: `"neo-plan"`)
- `-WebAppName` (default: `"neo-web"`) — must be globally unique on Azure
- `-Location` (default: `"eastus"`)
- `-Sku` (default: `"B1"`)
- `-NodeVersion` (default: `"20-lts"`)

Script structure, in order:

1. **Prerequisites check block**:
   - Verify `az` command exists (use `Get-Command az`). If missing, print error with install instructions and exit
   - Run `az account show` to verify the user is logged in. If it fails, print error telling user to run `az login` and exit
   - Print the current subscription name and ID so the admin can confirm it is correct

2. **Create Resource Group**:
   - Run `az group create --name <ResourceGroupName> --location <Location>`
   - This is natively idempotent — if the group exists, it updates (no-op if unchanged)
   - Print the resource group name and location on success

3. **Create App Service Plan**:
   - Run `az appservice plan create --name <AppServicePlanName> --resource-group <ResourceGroupName> --sku <Sku> --is-linux`
   - Idempotent — if the plan exists with the same SKU, it is a no-op
   - Print the plan name and SKU on success

4. **Create Web App**:
   - Run `az webapp create --name <WebAppName> --resource-group <ResourceGroupName> --plan <AppServicePlanName> --runtime "NODE:20-lts"`
   - If the web app already exists, this updates it
   - Print the web app name and default hostname on success

5. **Configure App Settings**:
   - Run `az webapp config appsettings set` to set non-secret defaults:
     - `WEBSITE_NODE_DEFAULT_VERSION` = `~20`
     - `MOCK_MODE` = `true`
     - `SCM_DO_BUILD_DURING_DEPLOYMENT` = `false` (we build locally and zip deploy)
   - Print a reminder listing the secret environment variables the admin must set manually: `ANTHROPIC_API_KEY`, `AUTH_SECRET`, `AZURE_TENANT_ID`, `AZURE_CLIENT_ID`, `AZURE_CLIENT_SECRET`, `AZURE_SUBSCRIPTION_ID`, `SENTINEL_WORKSPACE_ID`, `SENTINEL_WORKSPACE_NAME`, `SENTINEL_RESOURCE_GROUP`, `AUTH_MICROSOFT_ENTRA_ID_ID`, `AUTH_MICROSOFT_ENTRA_ID_SECRET`, `AUTH_MICROSOFT_ENTRA_ID_ISSUER`

6. **Configure Startup Command**:
   - Run `az webapp config set --startup-file "node server.js"` — this is the entry point for Next.js standalone output
   - Print confirmation

7. **Print summary**:
   - Resource group, app service plan, web app name, default URL (`https://<WebAppName>.azurewebsites.net`), and a reminder to set secrets

### 4. Create `scripts/deploy-azure.ps1`

The script accepts these parameters:

- `-ResourceGroupName` (default: `"neo-rg"`)
- `-WebAppName` (default: `"neo-web"`)
- `-SkipBuild` (switch, default: `$false`) — skip the build step if the admin has already run `npm run build` manually

Script structure, in order:

1. **Prerequisites check block** (same pattern as provision script):
   - Verify `az` command exists
   - Verify user is logged in (`az account show`)
   - Verify the web app exists (`az webapp show --name <WebAppName> --resource-group <ResourceGroupName>`). If not found, print error telling user to run the provision script first and exit

2. **Verify project structure**:
   - Check that `web/package.json` exists relative to the script's location (the repo root). If not, print error about running the script from the repo root and exit
   - Check that `npm` is available

3. **Build step** (skipped if `-SkipBuild` is set):
   - Run `npm install` in the `web/` directory
   - Run `npm run build` in the `web/` directory
   - Verify that `web/.next/standalone/` exists after the build. If not, print error about missing standalone output (likely `output: 'standalone'` not set in `next.config.js`) and exit

4. **Package the standalone output**:
   - Create a temporary directory for staging the zip
   - Copy `web/.next/standalone/` contents to the staging directory (this contains the server and trimmed `node_modules`)
   - Copy `web/public/` to `staging/public/` (standalone doesn't include static public assets)
   - Copy `web/.next/static/` to `staging/.next/static/` (standalone doesn't include static build assets)
   - Copy the root `.env` file to the staging directory if it exists (for any non-App-Settings env vars), but print a warning that App Settings should be preferred over `.env` in production
   - Create a zip file from the staging directory contents
   - Print the zip file size for the admin's reference

5. **Deploy via zip deploy**:
   - Run `az webapp deploy --resource-group <ResourceGroupName> --name <WebAppName> --src-path <zip-path> --type zip`
   - Print the deployment status

6. **Cleanup**:
   - Remove the temporary staging directory and zip file

7. **Print summary**:
   - Web app URL (`https://<WebAppName>.azurewebsites.net`)
   - Remind admin to verify the site is running

---

## Verification

1. Run `cd web && npm run build` — confirm that `.next/standalone/` directory is created (validates the `output: 'standalone'` change)
2. Open `scripts/provision-azure.ps1` and confirm it accepts all documented parameters and has a prerequisites check block
3. Open `scripts/deploy-azure.ps1` and confirm it accepts all documented parameters, builds, packages standalone output with `public/` and `.next/static/`, and deploys via `az webapp deploy`
4. Run `scripts/provision-azure.ps1` with a test resource group name — confirm resources are created in Azure
5. Run `scripts/deploy-azure.ps1` — confirm the Next.js app is deployed and accessible at the App Service URL
6. Re-run both scripts — confirm idempotent behavior (no errors, no duplicate resources)
