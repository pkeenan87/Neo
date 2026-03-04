# Azure Deploy Scripts

> Two PowerShell utility scripts for provisioning an Azure App Service and deploying the Next.js web application to it.

## Problem

There is no deployment infrastructure for the Neo web application. Developers and admins must manually create Azure resources and deploy the app through the Azure Portal or ad-hoc CLI commands. This is error-prone, undocumented, and not repeatable. There is no standardized way to stand up a new environment or redeploy after code changes.

## Goals

- Provide a PowerShell script that creates all required Azure resources (App Service Plan, Web App, resource group) for hosting the Next.js web application
- Provide a second PowerShell script that builds and deploys the Next.js application to the provisioned App Service
- Scripts are parameterized so they work across environments (dev, staging, production) without modification
- Scripts validate prerequisites (Azure CLI installed, logged in, correct subscription) before making changes
- Scripts are idempotent where possible — re-running should not fail or create duplicate resources

## Non-Goals

- Setting up CI/CD pipelines (GitHub Actions, Azure DevOps) — that is a separate feature
- Provisioning Azure resources beyond what the web app needs to run (e.g., Sentinel workspaces, Defender, Entra ID app registrations)
- Managing the CLI project deployment (it is a local tool, not a hosted service)
- Configuring custom domains or SSL certificates
- Setting up Azure Key Vault or other secrets management — environment variables are set directly on the App Service

## User Stories

1. **As a platform admin**, I can run a single PowerShell script to create all Azure infrastructure needed to host the Neo web app, so I don't have to click through the Azure Portal manually.
2. **As a platform admin**, I can run a second PowerShell script to build and deploy the latest code to the App Service, so deployments are repeatable and scriptable.
3. **As a platform admin**, I can customize the resource names, region, and pricing tier via script parameters, so I can deploy to different environments (dev, staging, prod) without editing the script.
4. **As a platform admin**, I see clear error messages if prerequisites are missing (e.g., Azure CLI not installed, not logged in, wrong subscription), so I can fix issues before the script makes any changes.
5. **As a platform admin**, I can re-run either script safely without creating duplicate resources or breaking the existing deployment.

## Design Considerations

### Script Location and Organization

The scripts should live in a new `scripts/` directory at the repo root, keeping infrastructure tooling separate from application code. This directory may grow to include other utility scripts in the future.

### Script 1: Provision Azure Resources

This script needs to create the minimum Azure resources for running a Next.js application:

- **Resource Group** — logical container for all related resources
- **App Service Plan** — defines the compute tier (size, OS, pricing)
- **Web App** — the actual App Service instance configured for Node.js

The script should accept parameters for resource naming, Azure region, and pricing tier. It should also configure the Web App with the correct Node.js runtime version, startup command (`npm run start` or `node server.js`), and any required application settings (environment variables) that the Next.js app needs.

Consider whether the script should also set the application settings (environment variables like `ANTHROPIC_API_KEY`, `MOCK_MODE`, Azure credentials) or leave that as a manual step. Setting secrets via script parameters means they appear in the terminal history, so it may be better to prompt interactively or require the admin to set them separately.

### Script 2: Build and Deploy

This script needs to:

- Build the Next.js application (`npm run build` in the `web/` directory)
- Package the build output into a deployable artifact
- Deploy the artifact to the App Service

Azure App Service supports several deployment methods:

- **Zip Deploy** — package the app as a zip and push via `az webapp deploy` or the Kudu API
- **Local Git** — push to the App Service's git remote
- **GitHub Actions** — out of scope for this feature

Zip Deploy is the simplest and most scriptable option. The script would need to determine which files to include (the `web/` directory with `node_modules/`, `.next/`, `package.json`, etc.) and exclude development-only files.

### Next.js on Azure App Service

Next.js requires a Node.js runtime and the `next start` command to serve the production build. The App Service needs to be configured with:

- Node.js runtime (version matching the project's requirements)
- Startup command pointing to `npm run start` or the standalone output
- `WEBSITE_NODE_DEFAULT_VERSION` application setting

Consider using Next.js standalone output mode (`output: 'standalone'` in `next.config.js`) which produces a self-contained server with only the necessary dependencies. This significantly reduces the deployment package size and avoids shipping all of `node_modules/`.

### Idempotency

Both scripts should handle the case where resources already exist:

- The provisioning script should check for existing resources and skip creation if they match the desired configuration, or update them if they differ
- The deployment script should handle redeployment cleanly (App Service handles this natively with zip deploy)

### Prerequisites and Validation

Both scripts should validate before making any changes:

- Azure CLI (`az`) is installed and accessible
- User is logged in (`az account show`)
- Correct subscription is selected
- Required parameters are provided

## Key Files

- `scripts/provision-azure.ps1` — Creates Azure Resource Group, App Service Plan, and Web App
- `scripts/deploy-azure.ps1` — Builds and deploys the Next.js app to the App Service
- `web/next.config.js` — May need `output: 'standalone'` added for optimized deployment
- `web/package.json` — Contains the `build` and `start` scripts used during deployment

## Open Questions

1. Should the provisioning script set application environment variables (secrets) directly, or should that remain a manual step via the Azure Portal to avoid secrets in terminal history?
2. Should `output: 'standalone'` be added to `next.config.js` to optimize the deployment package, or should the scripts deploy the full `web/` directory with `node_modules/`?
3. What Azure region and pricing tier should be the defaults? (e.g., `eastus` and `B1` for dev, `P1v3` for production)
4. Should the scripts support deploying to an existing App Service created outside of the provisioning script, or only to one created by the provisioning script?
5. Should the deployment script run `npm install --production` on the App Service side (via Kudu), or install locally and include `node_modules/` in the zip?
