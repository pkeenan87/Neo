# Deployment Guide

End-to-end guide for deploying the Neo web server to Azure. Walks
through provisioning, identity setup, configuration, build, deploy,
and post-deploy verification — including the multi-instance
scaling configuration introduced by the [multi-instance migration](../_plans/multi-instance-deployment.md).

For day-to-day configuration knobs (env vars, integrations,
skills format) see [`configuration.md`](./configuration.md). This
doc focuses on the deploy mechanics.

## Table of Contents

- [Architecture overview](#architecture-overview)
- [Prerequisites](#prerequisites)
- [Step 1 — Provision App Service](#step-1--provision-app-service)
- [Step 2 — Provision Cosmos DB](#step-2--provision-cosmos-db)
- [Step 3 — Optional Azure resources](#step-3--optional-azure-resources)
- [Step 4 — Entra ID app registration](#step-4--entra-id-app-registration)
- [Step 5 — Configure App Service settings](#step-5--configure-app-service-settings)
- [Step 6 — Configure horizontal scaling](#step-6--configure-horizontal-scaling)
- [Step 7 — Configure App Service Health Check](#step-7--configure-app-service-health-check)
- [Step 8 — Build and deploy](#step-8--build-and-deploy)
- [Step 9 — Post-deploy verification](#step-9--post-deploy-verification)
- [Step 10 — Skill migration](#step-10--skill-migration)
- [Updates and rolling deploys](#updates-and-rolling-deploys)
- [Rollback](#rollback)
- [Troubleshooting](#troubleshooting)

---

## Architecture overview

The Neo web app is a Next.js 15 (App Router, Node runtime) application
that runs on Azure App Service Linux behind a load balancer. State
that must be consistent across instances lives in Cosmos DB; secrets
live in App Service settings (or Key Vault references). All Azure data
plane access uses the App Service's system-assigned managed identity —
no client secrets in app settings.

Required Azure resources:
- **App Service** (Linux Plan) hosting the Next.js standalone build.
- **Cosmos DB** (NoSQL, serverless) holding seven containers:
  `conversations`, `usage-logs`, `triageRuns`, `teams-mappings`,
  `api-keys`, `skills`, `instance-shared`.
- **Microsoft Entra ID app registration** for browser SSO (Auth.js)
  and for CLI client tokens.

Optional Azure resources:
- **Storage Account** (blob) for CLI installer downloads.
- **Event Hub** + **Log Analytics** for structured logging /
  Application Insights ingestion.
- **Key Vault** for secret references (recommended in regulated
  environments — App Service settings work for everything else).

---

## Prerequisites

Local tooling:
- **Azure CLI** ≥ 2.50 (`az --version`)
- **Node.js** 20-LTS (matches the App Service runtime)
- **PowerShell 7+** (the provisioning scripts are PowerShell so they
  run identically on macOS/Linux/Windows; the `pwsh` binary is on
  PATH after installing PowerShell)
- **`az login`** with a user account that has at minimum:
  - `Contributor` on the target subscription (or resource group)
  - `User Access Administrator` on the target resource group
    (needed to assign the Cosmos data-plane RBAC role to the App
    Service's managed identity)

Anthropic / Microsoft prerequisites:
- An **Anthropic API key** with sufficient quota.
- An Entra ID tenant with permission to register apps (Cloud
  Application Administrator or Global Administrator).

---

## Step 1 — Provision App Service

```powershell
# From repo root
./scripts/provision-azure.ps1 `
    -ResourceGroupName "neo-rg" `
    -AppServicePlanName "neo-plan" `
    -WebAppName "neo-web" `
    -Location "eastus" `
    -Sku "P1v3" `
    -NodeVersion "20-lts"
```

What the script does (idempotent; safe to re-run):
1. Creates the resource group if missing.
2. Creates a Linux App Service Plan at the chosen SKU.
3. Creates the Web App with Node 20 runtime, `output: "standalone"`
   compatible startup, HTTPS-only, TLS 1.2 minimum.
4. Enables the system-assigned managed identity on the Web App.

SKU recommendation:
- **B1 / B2** for dev/staging (single instance only).
- **P1v3 or higher** for production — supports horizontal scale-out
  to ≥ 2 instances. Required for the multi-instance correctness
  guarantees in this repo.

After the script finishes:
- Note the Web App's **default hostname** (e.g.
  `neo-web.azurewebsites.net`) — used in Step 4.
- Note the **principal ID** of the managed identity (`az webapp
  identity show -g neo-rg -n neo-web --query principalId -o tsv`) —
  used by the Cosmos provisioning script.

---

## Step 2 — Provision Cosmos DB

```powershell
./scripts/provision-cosmos-db.ps1 `
    -ResourceGroupName "neo-rg" `
    -AccountName "neo-cosmos" `
    -DatabaseName "neo-db" `
    -Location "eastus" `
    -WebAppName "neo-web"
```

Pass `-WebAppName` so the script auto-assigns the **Cosmos DB
Built-in Data Contributor** role to the Web App's managed identity.
If you skip it, you'll have to assign the role manually before the
app can read/write Cosmos.

The script creates eleven steps in this order, each idempotent:
1. Resource group (no-op if it exists).
2. Cosmos account (serverless, NoSQL, single region).
3. Database `neo-db`.
4. `conversations` container — partition key `/id`, TTL 90 days.
5. `teams-mappings` container — partition key `/id`.
6. `usage-logs` container — partition key `/userId`.
7. `api-keys` container — partition key `/id`.
8. `skills` container — partition key `/id`.
9. `instance-shared` container — partition key `/key`, TTL 24 h
   (used by the rate limiter and circuit breaker primitives).
10. `triageRuns` container — partition key `/id`.
11. Role assignment (Cosmos DB Built-in Data Contributor → Web App
    MSI).

Verify by listing containers:

```bash
az cosmosdb sql container list \
  --account-name neo-cosmos \
  --resource-group neo-rg \
  --database-name neo-db \
  --query "[].name" -o tsv
```

You should see all seven containers. If a container is missing, the
new `instrumentation.ts` boot hook will fail fast at startup (the
`assertCosmosContainers` check) — that's the whole point.

---

## Step 3 — Optional Azure resources

Skip this section for a minimal deployment. Add resources as needed
for the features you intend to use.

### CLI installer downloads (Blob Storage)

Required if you serve the Windows CLI installer from the web app's
`/downloads` page.

```powershell
./scripts/provision-blob-storage.ps1 `
    -ResourceGroupName "neo-rg" `
    -StorageAccountName "neostorage<unique>" `
    -ContainerName "cli-downloads"
```

The script grants `Storage Blob Data Reader` on the container to the
Web App's managed identity.

### Structured logging (Event Hub + Log Analytics)

Required if you want logs to flow into Application Insights /
Sentinel. Without these the app logs to stdout only (visible in the
App Service log stream).

```powershell
./scripts/provision-event-hub.ps1 `
    -ResourceGroupName "neo-rg" `
    -NamespaceName "neo-eventhub" `
    -EventHubName "neo-logs"

./scripts/provision-log-analytics.ps1 `
    -ResourceGroupName "neo-rg" `
    -WorkspaceName "neo-logs"
```

### Phishing-intake CSV cleanup (Function App)

Optional. Ages out the CSVs uploaded by the phishing-report intake.

```powershell
./scripts/provision-csv-cleanup.ps1 `
    -ResourceGroupName "neo-rg" `
    -FunctionAppName "neo-cleanup"
```

### Key Vault (secrets)

Optional. Recommended for regulated environments. App Service
supports Key Vault references in app settings; for everything below,
swap the literal value for `@Microsoft.KeyVault(SecretUri=...)`.

```powershell
./scripts/provision-key-vault.ps1 `
    -ResourceGroupName "neo-rg" `
    -VaultName "neo-kv" `
    -WebAppName "neo-web"
```

The script grants `Key Vault Secrets User` on the vault to the Web
App's managed identity.

---

## Step 4 — Entra ID app registration

Required for browser SSO. Skip only if you're running with
`DEV_AUTH_BYPASS=true` in a dev environment — never in production
(the boot guard will reject it).

1. **Register the app** in the Entra portal:
   - Name: `Neo Web` (or your convention).
   - Supported account types: typically *Accounts in this
     organizational directory only*.
   - Redirect URI: `Web` →
     `https://<your-canonical-domain>/api/auth/callback/microsoft-entra-id`.
   - Click *Register*.

2. **Note** the resulting **Application (client) ID** and
   **Directory (tenant) ID** — both go into App Service settings
   (Step 5).

3. **Create a client secret**:
   - Certificates & secrets → New client secret.
   - Save the value immediately (you can't view it again).

4. **API permissions** — add Microsoft Graph delegated permissions
   based on what the app needs to do:
   - `User.Read.All`, `User.RevokeSessionsAll.All`
   - `Mail.ReadWrite`, `Mail.Send` (phishing intake / autoresponder)
   - `Directory.Read.All` (group membership lookup)
   - Plus the Sentinel / Defender XDR permissions described in
     `configuration.md` if you're enabling those tools.
   - **Grant admin consent** after adding (the *Grant admin consent*
     button in the API permissions blade).

5. **Issuer URL** — the value to use for
   `AUTH_MICROSOFT_ENTRA_ID_ISSUER` is
   `https://login.microsoftonline.com/<tenant-id>/v2.0`.

For the CLI public-client app registration (separate from this one),
see [`configuration.md`](./configuration.md#cli-public-client-setup).

---

## Step 5 — Configure App Service settings

App Service application settings become environment variables in the
container at runtime. Set them either in the portal (Configuration →
Application settings) or via CLI.

### Required settings

| Name | Source | Notes |
|---|---|---|
| `ANTHROPIC_API_KEY` | Anthropic console | Treat as secret — Key Vault reference recommended. |
| `NODE_ENV` | `production` | **Critical.** Triggers the `validateConfig` guard requiring `COSMOS_ENDPOINT`. |
| `COSMOS_ENDPOINT` | Cosmos account → Keys | Use the document endpoint, e.g. `https://neo-cosmos.documents.azure.com:443/`. **No connection string** — managed identity handles auth. |
| `MOCK_MODE` | `false` | Production must be `false`. Defaults to `true` (dev/file-fallback) when unset. |
| `AUTH_SECRET` | `openssl rand -hex 32` | **Must be identical across all instances.** Mismatched secrets break PKCE cookies. |
| `AUTH_TRUST_HOST` | `true` | Required behind App Service's reverse proxy. |
| `AUTH_URL` | `https://neo.your-domain.com` | Your canonical HTTPS URL. App Service injects bogus internal hostnames if unset, which Entra ID rejects. |
| `AUTH_MICROSOFT_ENTRA_ID_ID` | Step 4 | Application (client) ID. |
| `AUTH_MICROSOFT_ENTRA_ID_SECRET` | Step 4 | Client secret value. Key Vault reference recommended. |
| `AUTH_MICROSOFT_ENTRA_ID_ISSUER` | Step 4 | `https://login.microsoftonline.com/<tenant>/v2.0`. |
| `AZURE_TENANT_ID` | Entra portal | Used for downstream Sentinel/Graph calls. |
| `AZURE_SUBSCRIPTION_ID` | Subscription | Required when `MOCK_MODE=false`. |

### CLI bulk-set example

```bash
az webapp config appsettings set \
  --resource-group neo-rg --name neo-web \
  --settings \
    NODE_ENV=production \
    MOCK_MODE=false \
    COSMOS_ENDPOINT="https://neo-cosmos.documents.azure.com:443/" \
    AUTH_TRUST_HOST=true \
    AUTH_URL="https://neo.your-domain.com" \
    ANTHROPIC_API_KEY="@Microsoft.KeyVault(SecretUri=https://neo-kv.vault.azure.net/secrets/anthropic-key/)" \
    AUTH_SECRET="@Microsoft.KeyVault(SecretUri=https://neo-kv.vault.azure.net/secrets/auth-secret/)"
```

### Optional settings

These have sensible defaults but are commonly tuned in production.
See [`configuration.md`](./configuration.md) for the full list.

| Name | Default | Purpose |
|---|---|---|
| `ORG_NAME` | "Goodwin Procter LLP" | Appears in the agent system prompt. |
| `ORG_CONTEXT` | (none) | Domain names, SAM formats, VPN ranges injected into the system prompt. Also editable in Settings → Organization. |
| `MAX_TOKENS_DEFAULT` | 4096 | Per-turn output budget for plain chat. |
| `MAX_TOKENS_SKILL` | 24576 | Larger budget for skill invocations. |
| `USAGE_LIMIT_2H_INPUT_TOKENS` | 670000 | Per-user 2-hour rolling budget. |
| `USAGE_LIMIT_WEEKLY_INPUT_TOKENS` | 6700000 | Per-user weekly rolling budget. |
| `INJECTION_GUARD_MODE` | `monitor` | `monitor` logs only; `block` rejects 2+-pattern matches. |

### What to put in Key Vault

At minimum: `ANTHROPIC_API_KEY`, `AUTH_SECRET`,
`AUTH_MICROSOFT_ENTRA_ID_SECRET`. Use `@Microsoft.KeyVault(...)`
reference syntax in App Service settings — App Service resolves at
runtime via the managed identity, so secrets never appear in the
portal blade or in deployment artifacts.

---

## Step 6 — Configure horizontal scaling

The app is designed to run on ≥ 2 App Service instances behind the
Plan's load balancer. All shared state lives in Cosmos via the
`instance-shared`, `skills`, `api-keys`, `teams-mappings`, and
`conversations` containers.

### Set instance count

```bash
# Manual scale-out to 2 instances
az appservice plan update \
  --resource-group neo-rg --name neo-plan \
  --number-of-workers 2
```

For autoscale, use the App Service Plan → Scale out (App Service
plan) blade. Recommended starting policy: 2 minimum, 4 maximum,
scale up at 70% CPU, scale down at 30%.

### Disable ARR Affinity

ARR Affinity (sticky sessions) is **off** in steady state. The whole
multi-instance migration assumes traffic round-robins freely:

> App Service → your Web App → Configuration → General settings →
> ARR affinity = **Off**

Leaving it on is a valid temporary state (belt-and-suspenders during
initial rollout) but converges back to off once you're confident in
the shared-state behavior. The app does not depend on it.

### Verify shared-state behavior

After the deploy lands (Step 8), confirm:
- A circuit-breaker trip on instance A causes instance B to refuse
  the next triage request within ≤ 5 s.
- 50 triage requests to instance A + 50 to instance B hits the
  100-req/15-min cap on the 101st request, not 200.
- An admin skill update is visible on all instances within 15 s.

The acceptance-criteria load test in
[`_plans/multi-instance-deployment.md`](../_plans/multi-instance-deployment.md)
walks through the exact harness.

---

## Step 7 — Configure App Service Health Check

App Service Health Check is the load balancer's signal for whether
to route traffic to an instance. Set it to the new `/api/health`
endpoint:

> App Service → your Web App → Monitoring → Health Check →
> *Enable* → Path: `/api/health`

What the endpoint does:
- Calls `validateConfig()` — fails 503 if `ANTHROPIC_API_KEY` is
  missing, if `NODE_ENV=production` and `COSMOS_ENDPOINT` is unset
  (the multi-instance guard), or if `DEV_AUTH_BYPASS=true` outside
  development.
- Returns 200 `{ "status": "ok" }` otherwise.

Effect: a misconfigured instance drops out of the LB rotation
immediately at boot. The startup-time `assertCosmosContainers`
check in `instrumentation.ts` provides the second layer — that one
fails the boot itself, so the instance never serves traffic.

CLI alternative:

```bash
az webapp config set \
  --resource-group neo-rg --name neo-web \
  --generic-configurations '{"healthCheckPath":"/api/health"}'
```

---

## Step 8 — Build and deploy

The build script produces a Next.js standalone output and zips it
for App Service zip-deploy.

```powershell
./scripts/deploy-azure.ps1 `
    -ResourceGroupName "neo-rg" `
    -WebAppName "neo-web"
```

What it does:
1. `cd web && npm ci && npm run build` (Next.js standalone build,
   `output: "standalone"`).
2. Zips `.next/standalone/` plus `public/` and `.next/static/`.
3. `az webapp deploy --src-path <zip>` — App Service unpacks and
   restarts.

Pass `-SkipBuild` to redeploy an already-built artifact (useful for
config-only re-roll).

### What happens at boot

On startup, App Service runs `node server.js` from the standalone
output. Next.js calls `instrumentation.ts:register()` once per
process before any route handler runs. That hook:
1. Calls `validateConfig()` — throws on missing required env vars.
2. Calls `assertCosmosContainers(env.COSMOS_ENDPOINT)` — point-reads
   each required container; throws naming the missing one.

A throw at this stage means the process exits non-zero and App
Service marks the instance unhealthy. The Health Check probe
(`/api/health`) catches the same condition for instances that
somehow boot anyway.

---

## Step 9 — Post-deploy verification

After the deploy completes, walk through this checklist before
declaring the deploy done.

### 9.1 Health probe

```bash
curl -sS -o /dev/null -w "%{http_code}\n" \
  https://neo.your-domain.com/api/health
# Expect: 200
```

If 503 — read the response body. The error message names the
missing config (e.g. `Multi-instance deployment requires
COSMOS_ENDPOINT in production`).

### 9.2 Cosmos connectivity (per instance)

The startup container check fires once per instance. Tail the log
stream and confirm the line `"Cosmos startup check passed"` is
present once per instance after boot:

```bash
az webapp log tail --resource-group neo-rg --name neo-web | grep cosmos-startup-check
```

### 9.3 Sign-in flow

1. Open `https://neo.your-domain.com/` in a private browser window.
2. Click *Sign in* → redirects to Entra ID.
3. Authenticate with a test account that has access.
4. Lands on `/chat` — the new conversation page.

If the redirect URI is rejected: confirm Step 4's redirect URI
matches `AUTH_URL` exactly. Common mistake: `http://` vs `https://`,
or a missing trailing path segment.

### 9.4 Smoke test

1. Send a plain-chat message ("hi") — agent responds within ~2 s.
2. Invoke a read-only skill — confirm the skill list appears in the
   slash-command popover; pick one; the agent runs it.
3. Hit `/api/triage` from a CLI:
   ```bash
   curl -X POST https://neo.your-domain.com/api/triage \
     -H "X-API-Key: <test-key>" \
     -H "Content-Type: application/json" \
     -d '{"alertId": "test-001", "title": "test", "severity": "low"}'
   ```
   Expect a 200 with a `verdict` field.

### 9.5 Multi-instance smoke test

Confirm the rate limiter and breaker share state across instances:

```bash
# Send N+1 triage requests; expect the (N+1)th to 429.
for i in $(seq 1 101); do
  curl -s -o /dev/null -w "%{http_code}\n" \
    -X POST https://neo.your-domain.com/api/triage \
    -H "X-API-Key: <test-key>" \
    -H "Content-Type: application/json" \
    -d "{\"alertId\": \"smoke-$i\", \"title\": \"smoke\", \"severity\": \"low\"}"
done | tail -5
# Expect: 200, 200, ..., 200, 429
```

If the 101st returns 200, the limiter is bypassed. Most common
cause: `MOCK_MODE` is unset or `true`, so the limiter is in no-op
mode. Re-check Step 5's `MOCK_MODE=false`.

---

## Step 10 — Skill migration

One-time when cutting over from file-mode to Cosmos-backed skills.
Run from a workstation with `az login` and Cosmos data-plane RBAC
on the target account (the same role assigned to the App Service in
Step 2).

```bash
cd web

# 1. Dry run — reports what would change without writing.
COSMOS_ENDPOINT="https://neo-cosmos.documents.azure.com:443/" \
MOCK_MODE=false \
  npm run migrate:skills -- --dry-run

# 2. Real run.
COSMOS_ENDPOINT="https://neo-cosmos.documents.azure.com:443/" \
MOCK_MODE=false \
  npm run migrate:skills
```

Or from App Service SSH (uses the App Service's managed identity
implicitly):

```bash
node dist/migrate-skills.mjs
```

The script is idempotent (upsert) so re-running is safe. Skills with
invalid IDs (anything that doesn't match `^[a-z0-9][a-z0-9-]*[a-z0-9]$`)
are skipped with a warning — fix the filename and re-run.

After migration, dev mode (`MOCK_MODE=true`) still reads from the
file system, so contributor workflows are unchanged.

---

## Updates and rolling deploys

Steady-state updates go through the same `deploy-azure.ps1`
pipeline. A few things to know:

### Standard zero-downtime update

```powershell
./scripts/deploy-azure.ps1 -WebAppName "neo-web"
```

App Service zip-deploy stages the new code, then restarts each
instance one at a time. Health Check ensures restarting instances
drop out of the LB rotation until they pass `/api/health`.

### Deployment slots (recommended)

For higher-stakes deploys, stage to a slot first and swap:

```bash
# Create the slot (one-time)
az webapp deployment slot create \
  --resource-group neo-rg --name neo-web --slot staging

# Deploy to the slot
./scripts/deploy-azure.ps1 -WebAppName "neo-web" -Slot "staging"

# Smoke-test https://neo-web-staging.azurewebsites.net

# Swap → production
az webapp deployment slot swap \
  --resource-group neo-rg --name neo-web --slot staging
```

### Adding a new Cosmos container

When the app code adds a dependency on a new container:
1. Update `scripts/provision-cosmos-db.ps1` to create the container
   AND update the renumbered step counters.
2. Update the `REQUIRED_CONTAINERS` array in
   `web/lib/cosmos-startup-check.ts` so the boot guard picks it up.
3. Re-run `provision-cosmos-db.ps1` (idempotent — only the new
   container is created).
4. Then deploy the code change. The startup check fails-fast if the
   container is missing, which is exactly the behavior you want.

### Adding a new App Service setting

```bash
az webapp config appsettings set \
  --resource-group neo-rg --name neo-web \
  --settings NEW_VAR="value"
```

Setting changes restart the app automatically.

---

## Rollback

Two options depending on the deploy mechanism:

**Slot swap rollback** (preferred when using slots):

```bash
az webapp deployment slot swap \
  --resource-group neo-rg --name neo-web --slot staging
# Re-running swap inverts the slots — production is now whatever
# was in staging before, and staging holds the broken build.
```

**Zip redeploy of last-known-good**:

```bash
# Find the previous deployment ID
az webapp deployment list-publishing-profiles \
  --resource-group neo-rg --name neo-web

# Or just redeploy from a known-good git ref
git checkout <last-good-sha>
./scripts/deploy-azure.ps1 -WebAppName "neo-web"
```

**Cosmos schema rollbacks** are not built-in — Cosmos has no
point-in-time restore on the serverless tier. Plan schema changes
to be backwards-compatible (additive fields, optional new
containers) so a code rollback always works without touching data.

---

## Troubleshooting

### Boot fails with `Multi-instance deployment requires COSMOS_ENDPOINT`

`NODE_ENV=production` is set but `COSMOS_ENDPOINT` is missing or
empty. Set it (Step 5) and restart the app. The error is intentional —
this is the multi-instance correctness guard.

### Boot fails with `Cosmos containers missing in database 'neo-db'`

The named containers don't exist. Re-run
`scripts/provision-cosmos-db.ps1` with the same parameters as your
original provisioning. The error message lists the missing
containers verbatim.

### Boot fails with `Cosmos startup check failed for container '<name>'`

Connectivity / auth problem (anything that's not a 404 on the
container). Common causes:
- Managed identity hasn't been granted the **Cosmos DB Built-in
  Data Contributor** role yet. Check with
  `az cosmosdb sql role assignment list --resource-group neo-rg --account-name neo-cosmos`.
- Role assignment was just created but hasn't propagated. Wait 60 s
  and restart the app.
- Network rules on the Cosmos account block App Service. If the
  account has firewall rules enabled, add the App Service's outbound
  IPs (App Service → Networking → Outbound addresses) or enable
  *Accept connections from within public Azure datacenters*.

### Sign-in 500s with `prompt is too long` or `state mismatch`

`AUTH_SECRET` differs across instances. PKCE state cookies issued
by instance A can't be decrypted by instance B. Generate a single
secret (`openssl rand -hex 32`) and set it identically on every
instance and slot.

### `/api/triage` returns 500 instead of an `escalate` envelope

The triage endpoint is supposed to fail-safe to a 200 with
`verdict: "escalate"`. A 500 means something escaped the route's
fail-safe block — most commonly a Cosmos error in the auth
middleware. Check `az webapp log tail` for the stack trace.

### CLI 401s after API key revocation propagates slowly

API keys are read from Cosmos on every request — there's no cache.
Revocation is effectively immediate. If you see lag, it's
propagation of the admin write to all Cosmos replicas (eventual
consistency); typically < 1 s. If lag exceeds 5 s, check Cosmos
account → Settings → Default consistency — *Session* or *Eventual*
is fine; *Strong* not needed.

### Skill update not visible on other instances

Read-through cache TTL is 15 s — wait that long. Past 15 s, every
instance sees the new value on the next read. If a particular
instance stays stale, restart it to force cache invalidation.

### Triage rate limiter never blocks anything

Most common cause: `MOCK_MODE=true` (or unset) — the limiter is
no-op in mock mode. Verify with
`az webapp config appsettings list --resource-group neo-rg --name neo-web --query "[?name=='MOCK_MODE'].value" -o tsv`.

If `MOCK_MODE=false` and it still doesn't block, check the
`instance-shared` container exists and the App Service MSI has
data-plane access. The startup check would have failed if either
were missing — but if you bypassed the check during initial setup
and are seeing it now, that's the cause.

### "AUTH_URL is not set" warning in logs

App Service's reverse proxy injects internal hostnames that Entra
ID rejects. Set `AUTH_URL` to your canonical public HTTPS domain
(Step 5).

---

## Where to look next

- [`configuration.md`](./configuration.md) — full env var reference,
  Entra ID / API key setup details, integration configuration.
- [`conversation-storage-v2-migration.md`](./conversation-storage-v2-migration.md) —
  one-time migration if you're upgrading an existing v1 deployment.
- [`_plans/multi-instance-deployment.md`](../_plans/multi-instance-deployment.md) —
  internals of the multi-instance migration: which singletons moved
  to Cosmos and why.
- [`_specs/multi-instance-deployment.md`](../_specs/multi-instance-deployment.md) —
  acceptance criteria and load-test plan.
