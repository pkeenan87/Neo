<#
.SYNOPSIS
    Provisions Azure App Service infrastructure for the Neo web application.

.DESCRIPTION
    Creates a Resource Group, Linux App Service Plan, and Web App configured
    for Node.js 20. Idempotent — safe to re-run without creating duplicates.
    Enforces HTTPS-only and TLS 1.2 minimum.

.EXAMPLE
    ./provision-azure.ps1
    ./provision-azure.ps1 -WebAppName "neo-prod" -Sku "P1v3" -Location "westus2"
#>

param(
    [ValidateNotNullOrEmpty()]
    [ValidateLength(1, 90)]
    [string]$ResourceGroupName = "neo-rg",

    [ValidateNotNullOrEmpty()]
    [ValidateLength(1, 60)]
    [string]$AppServicePlanName = "neo-plan",

    [ValidateNotNullOrEmpty()]
    [ValidatePattern('^[a-z0-9][a-z0-9\-]{0,58}[a-z0-9]$')]
    [string]$WebAppName = "neo-web",

    [ValidateNotNullOrEmpty()]
    [string]$Location = "eastus",

    [ValidateSet("B1", "B2", "B3", "S1", "S2", "S3", "P1v2", "P2v2", "P1v3", "P2v3", "P3v3")]
    [string]$Sku = "B1",

    [ValidateSet("20-lts", "22-lts")]
    [string]$NodeVersion = "20-lts"
)

$ErrorActionPreference = "Stop"

# ─────────────────────────────────────────────────────────────
#  Prerequisites
# ─────────────────────────────────────────────────────────────

Write-Host "`n  Checking prerequisites..." -ForegroundColor Cyan

if (-not (Get-Command az -ErrorAction SilentlyContinue)) {
    Write-Host "`n  ERROR: Azure CLI (az) is not installed." -ForegroundColor Red
    Write-Host "  Install it from: https://learn.microsoft.com/en-us/cli/azure/install-azure-cli`n" -ForegroundColor Red
    exit 1
}

try {
    $account = az account show --output json 2>$null | ConvertFrom-Json
} catch {
    Write-Host "`n  ERROR: Not logged in to Azure CLI." -ForegroundColor Red
    Write-Host "  Run: az login`n" -ForegroundColor Red
    exit 1
}

if (-not $account) {
    Write-Host "`n  ERROR: Not logged in to Azure CLI." -ForegroundColor Red
    Write-Host "  Run: az login`n" -ForegroundColor Red
    exit 1
}

Write-Host "  Subscription: $($account.name) ($($account.id))" -ForegroundColor Gray

# ─────────────────────────────────────────────────────────────
#  Resource Group
# ─────────────────────────────────────────────────────────────

Write-Host "`n  Creating Resource Group: $ResourceGroupName ($Location)..." -ForegroundColor Cyan
az group create --name $ResourceGroupName --location $Location --output none
if ($LASTEXITCODE -ne 0) {
    Write-Host "`n  ERROR: Failed to create resource group '$ResourceGroupName'.`n" -ForegroundColor Red
    exit 1
}
Write-Host "  Resource Group ready." -ForegroundColor Green

# ─────────────────────────────────────────────────────────────
#  App Service Plan
# ─────────────────────────────────────────────────────────────

Write-Host "`n  Creating App Service Plan: $AppServicePlanName (SKU: $Sku, Linux)..." -ForegroundColor Cyan
az appservice plan create `
    --name $AppServicePlanName `
    --resource-group $ResourceGroupName `
    --sku $Sku `
    --is-linux `
    --output none
if ($LASTEXITCODE -ne 0) {
    Write-Host "`n  ERROR: Failed to create App Service Plan '$AppServicePlanName'.`n" -ForegroundColor Red
    exit 1
}
Write-Host "  App Service Plan ready." -ForegroundColor Green

# ─────────────────────────────────────────────────────────────
#  Web App
# ─────────────────────────────────────────────────────────────

Write-Host "`n  Creating Web App: $WebAppName (Node.js $NodeVersion)..." -ForegroundColor Cyan
az webapp create `
    --name $WebAppName `
    --resource-group $ResourceGroupName `
    --plan $AppServicePlanName `
    --runtime "NODE:$NodeVersion" `
    --output none
if ($LASTEXITCODE -ne 0) {
    Write-Host "`n  ERROR: Failed to create Web App '$WebAppName'.`n" -ForegroundColor Red
    exit 1
}
Write-Host "  Web App ready." -ForegroundColor Green

# ─────────────────────────────────────────────────────────────
#  App Settings
# ─────────────────────────────────────────────────────────────

Write-Host "`n  Configuring app settings..." -ForegroundColor Cyan
az webapp config appsettings set `
    --name $WebAppName `
    --resource-group $ResourceGroupName `
    --settings `
        WEBSITE_NODE_DEFAULT_VERSION="~20" `
        MOCK_MODE="false" `
        INJECTION_GUARD_MODE="monitor" `
        SCM_DO_BUILD_DURING_DEPLOYMENT="false" `
    --output none
if ($LASTEXITCODE -ne 0) {
    Write-Host "`n  ERROR: Failed to configure app settings.`n" -ForegroundColor Red
    exit 1
}
Write-Host "  App settings configured." -ForegroundColor Green

# ─────────────────────────────────────────────────────────────
#  Startup Command
# ─────────────────────────────────────────────────────────────

Write-Host "`n  Setting startup command..." -ForegroundColor Cyan
az webapp config set `
    --name $WebAppName `
    --resource-group $ResourceGroupName `
    --startup-file "node server.js" `
    --min-tls-version 1.2 `
    --output none
if ($LASTEXITCODE -ne 0) {
    Write-Host "`n  ERROR: Failed to set startup command.`n" -ForegroundColor Red
    exit 1
}
Write-Host "  Startup command set." -ForegroundColor Green

# ─────────────────────────────────────────────────────────────
#  HTTPS-Only
# ─────────────────────────────────────────────────────────────

Write-Host "`n  Enforcing HTTPS-only..." -ForegroundColor Cyan
az webapp update `
    --name $WebAppName `
    --resource-group $ResourceGroupName `
    --https-only true `
    --output none
if ($LASTEXITCODE -ne 0) {
    Write-Host "`n  ERROR: Failed to enforce HTTPS-only.`n" -ForegroundColor Red
    exit 1
}
Write-Host "  HTTPS-only enabled." -ForegroundColor Green

# ─────────────────────────────────────────────────────────────
#  Summary
# ─────────────────────────────────────────────────────────────

Write-Host "`n  ============================================" -ForegroundColor Green
Write-Host "  Provisioning complete!" -ForegroundColor Green
Write-Host "  ============================================" -ForegroundColor Green
Write-Host ""
Write-Host "  Resource Group:   $ResourceGroupName"
Write-Host "  App Service Plan: $AppServicePlanName ($Sku)"
Write-Host "  Web App:          $WebAppName"
Write-Host "  URL:              https://$WebAppName.azurewebsites.net"
Write-Host "  HTTPS-only:       yes"
Write-Host "  Min TLS:          1.2"
Write-Host ""
Write-Host "  MOCK_MODE is set to 'false' (live Azure APIs)." -ForegroundColor Yellow
Write-Host "  Set to 'true' only for testing environments." -ForegroundColor Yellow
Write-Host ""
Write-Host "  Next step: set secret environment variables." -ForegroundColor Yellow
Write-Host "  Run the following command, filling in your values:" -ForegroundColor Yellow
Write-Host ""
Write-Host "  az webapp config appsettings set ``" -ForegroundColor Gray
Write-Host "    --name $WebAppName ``" -ForegroundColor Gray
Write-Host "    --resource-group $ResourceGroupName ``" -ForegroundColor Gray
Write-Host "    --settings ``" -ForegroundColor Gray
Write-Host "      ANTHROPIC_API_KEY=`"<your-key>`" ``" -ForegroundColor Gray
Write-Host "      AUTH_SECRET=`"<openssl rand -hex 32>`" ``" -ForegroundColor Gray
Write-Host "      AZURE_TENANT_ID=`"<tenant-id>`" ``" -ForegroundColor Gray
Write-Host "      AZURE_CLIENT_ID=`"<client-id>`" ``" -ForegroundColor Gray
Write-Host "      AZURE_CLIENT_SECRET=`"<client-secret>`" ``" -ForegroundColor Gray
Write-Host "      AZURE_SUBSCRIPTION_ID=`"<subscription-id>`" ``" -ForegroundColor Gray
Write-Host "      SENTINEL_WORKSPACE_ID=`"<workspace-id>`" ``" -ForegroundColor Gray
Write-Host "      SENTINEL_WORKSPACE_NAME=`"<workspace-name>`" ``" -ForegroundColor Gray
Write-Host "      SENTINEL_RESOURCE_GROUP=`"<resource-group>`" ``" -ForegroundColor Gray
Write-Host "      AUTH_MICROSOFT_ENTRA_ID_ID=`"<entra-client-id>`" ``" -ForegroundColor Gray
Write-Host "      AUTH_MICROSOFT_ENTRA_ID_SECRET=`"<entra-secret>`" ``" -ForegroundColor Gray
Write-Host "      AUTH_MICROSOFT_ENTRA_ID_ISSUER=`"<entra-issuer>`" ``" -ForegroundColor Gray
Write-Host "      INJECTION_GUARD_MODE=`"monitor`"" -ForegroundColor Gray
Write-Host ""
Write-Host "  Then deploy with: ./scripts/deploy-azure.ps1`n" -ForegroundColor Yellow
