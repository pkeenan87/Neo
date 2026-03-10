<#
.SYNOPSIS
    Adds the teams-mappings container to an existing Neo Cosmos DB account.

.DESCRIPTION
    Creates the teams-mappings container in an existing Neo Cosmos DB database.
    Use this if your Cosmos DB was provisioned before the Teams integration was
    added. If you are starting fresh, use provision-cosmos-db.ps1 instead — it
    creates both containers in a single run.

    Idempotent — safe to re-run. Skips creation if the container already exists.

.EXAMPLE
    ./add-teams-mappings-container.ps1
    ./add-teams-mappings-container.ps1 -AccountName "neo-cosmos-prod" -DatabaseName "neo-db"
#>

param(
    [ValidateNotNullOrEmpty()]
    [ValidateLength(1, 90)]
    [string]$ResourceGroupName = "neo-rg",

    [ValidateNotNullOrEmpty()]
    [ValidateLength(3, 44)]
    [string]$AccountName = "neo-cosmos",

    [ValidateNotNullOrEmpty()]
    [string]$DatabaseName = "neo-db",

    [ValidateNotNullOrEmpty()]
    [string]$ContainerName = "teams-mappings",

    [ValidateRange(86400, 31536000)]
    [int]$DefaultTtl = 7776000  # 90 days
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

# ── Prerequisites ──────────────────────────────────────────

Write-Host "`n=== Add Teams Mappings Container ===" -ForegroundColor Cyan

if (-not (Get-Command az -ErrorAction SilentlyContinue)) {
    Write-Error "Azure CLI ('az') is not installed. Install from https://aka.ms/install-azure-cli"
    exit 1
}

$account = az account show 2>$null | ConvertFrom-Json
if (-not $account) {
    Write-Error "Not logged in to Azure CLI. Run 'az login' first."
    exit 1
}

Write-Host "Subscription: $($account.name) ($($account.id))" -ForegroundColor Yellow
Write-Host "Account: $AccountName" -ForegroundColor Yellow
Write-Host "Database: $DatabaseName" -ForegroundColor Yellow
Write-Host "Container: $ContainerName" -ForegroundColor Yellow
Write-Host "Default TTL: $DefaultTtl seconds ($([math]::Round($DefaultTtl / 86400)) days)" -ForegroundColor Yellow
Write-Host ""

# ── Verify account and database exist ─────────────────────

Write-Host "1/2 Verifying Cosmos DB account and database..." -ForegroundColor Green
$existingAccount = az cosmosdb show `
    --name $AccountName `
    --resource-group $ResourceGroupName 2>$null | ConvertFrom-Json
if (-not $existingAccount) {
    Write-Error "Cosmos DB account '$AccountName' not found in resource group '$ResourceGroupName'. Run provision-cosmos-db.ps1 first."
    exit 1
}
Write-Host "     Account '$AccountName' found."

$existingDb = az cosmosdb sql database show `
    --account-name $AccountName `
    --resource-group $ResourceGroupName `
    --name $DatabaseName 2>$null | ConvertFrom-Json
if (-not $existingDb) {
    Write-Error "Database '$DatabaseName' not found in account '$AccountName'. Run provision-cosmos-db.ps1 first."
    exit 1
}
Write-Host "     Database '$DatabaseName' found."

# ── Create container ──────────────────────────────────────

Write-Host "2/2 Creating teams-mappings container..." -ForegroundColor Green
$existingContainer = az cosmosdb sql container show `
    --account-name $AccountName `
    --resource-group $ResourceGroupName `
    --database-name $DatabaseName `
    --name $ContainerName 2>$null | ConvertFrom-Json
if ($existingContainer) {
    Write-Host "     Container '$ContainerName' already exists — nothing to do."
} else {
    az cosmosdb sql container create `
        --account-name $AccountName `
        --resource-group $ResourceGroupName `
        --database-name $DatabaseName `
        --name $ContainerName `
        --partition-key-path "/id" `
        --ttl $DefaultTtl `
        --output none
    Write-Host "     Container '$ContainerName' created with /id partition key and ${DefaultTtl}s TTL."
}

# ── Output ────────────────────────────────────────────────

Write-Host "`n=== Done ===" -ForegroundColor Cyan
Write-Host ""
Write-Host "The teams-mappings container is ready. No .env changes needed —" -ForegroundColor Yellow
Write-Host "it uses the same COSMOS_ENDPOINT as the conversations container." -ForegroundColor Yellow
Write-Host ""
