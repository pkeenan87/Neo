<#
.SYNOPSIS
    Provisions Azure Cosmos DB infrastructure for Neo chat persistence.

.DESCRIPTION
    Creates a Resource Group (if needed), Cosmos DB account (serverless, NoSQL),
    database, and conversations container with partition key and TTL. Assigns
    the Cosmos DB Built-in Data Contributor role to the specified Web App's
    Managed Identity. Idempotent — safe to re-run without creating duplicates.

.EXAMPLE
    ./provision-cosmos-db.ps1
    ./provision-cosmos-db.ps1 -AccountName "neo-cosmos-prod" -WebAppName "neo-web-prod"
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
    [string]$ContainerName = "conversations",

    [ValidateNotNullOrEmpty()]
    [string]$Location = "eastus",

    [ValidateRange(86400, 31536000)]
    [int]$DefaultTtl = 7776000,  # 90 days

    [string]$WebAppName = ""
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

# ── Prerequisites ──────────────────────────────────────────

Write-Host "`n=== Neo Cosmos DB Provisioning ===" -ForegroundColor Cyan

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
Write-Host "Resource Group: $ResourceGroupName" -ForegroundColor Yellow
Write-Host "Account: $AccountName" -ForegroundColor Yellow
Write-Host "Database: $DatabaseName" -ForegroundColor Yellow
Write-Host "Container: $ContainerName" -ForegroundColor Yellow
Write-Host "Location: $Location" -ForegroundColor Yellow
Write-Host "Default TTL: $DefaultTtl seconds ($([math]::Round($DefaultTtl / 86400)) days)" -ForegroundColor Yellow
Write-Host ""

# ── Resource Group ─────────────────────────────────────────

Write-Host "1/5 Creating resource group..." -ForegroundColor Green
az group create `
    --name $ResourceGroupName `
    --location $Location `
    --output none 2>$null
Write-Host "     Resource group '$ResourceGroupName' ready."

# ── Cosmos DB Account ──────────────────────────────────────

Write-Host "2/5 Creating Cosmos DB account (serverless)..." -ForegroundColor Green
$existing = az cosmosdb show --name $AccountName --resource-group $ResourceGroupName 2>$null | ConvertFrom-Json
if ($existing) {
    Write-Host "     Account '$AccountName' already exists — skipping."
} else {
    az cosmosdb create `
        --name $AccountName `
        --resource-group $ResourceGroupName `
        --kind GlobalDocumentDB `
        --capabilities EnableServerless `
        --default-consistency-level Session `
        --locations regionName=$Location failoverPriority=0 isZoneRedundant=false `
        --output none
    Write-Host "     Account '$AccountName' created."
}

# ── Database ───────────────────────────────────────────────

Write-Host "3/5 Creating database..." -ForegroundColor Green
$existingDb = az cosmosdb sql database show `
    --account-name $AccountName `
    --resource-group $ResourceGroupName `
    --name $DatabaseName 2>$null | ConvertFrom-Json
if ($existingDb) {
    Write-Host "     Database '$DatabaseName' already exists — skipping."
} else {
    az cosmosdb sql database create `
        --account-name $AccountName `
        --resource-group $ResourceGroupName `
        --name $DatabaseName `
        --output none
    Write-Host "     Database '$DatabaseName' created."
}

# ── Container ──────────────────────────────────────────────

Write-Host "4/5 Creating container..." -ForegroundColor Green
$existingContainer = az cosmosdb sql container show `
    --account-name $AccountName `
    --resource-group $ResourceGroupName `
    --database-name $DatabaseName `
    --name $ContainerName 2>$null | ConvertFrom-Json
if ($existingContainer) {
    Write-Host "     Container '$ContainerName' already exists — skipping."
} else {
    az cosmosdb sql container create `
        --account-name $AccountName `
        --resource-group $ResourceGroupName `
        --database-name $DatabaseName `
        --name $ContainerName `
        --partition-key-path "/ownerId" `
        --default-ttl $DefaultTtl `
        --output none
    Write-Host "     Container '$ContainerName' created with /ownerId partition key and ${DefaultTtl}s TTL."
}

# ── Managed Identity Role Assignment ───────────────────────

Write-Host "5/5 Assigning Managed Identity role..." -ForegroundColor Green
if ($WebAppName) {
    $principalId = az webapp identity show `
        --name $WebAppName `
        --resource-group $ResourceGroupName `
        --query principalId `
        --output tsv 2>$null

    if (-not $principalId) {
        Write-Host "     Enabling system-assigned Managed Identity on '$WebAppName'..."
        $principalId = az webapp identity assign `
            --name $WebAppName `
            --resource-group $ResourceGroupName `
            --query principalId `
            --output tsv
    }

    # Cosmos DB Built-in Data Contributor role definition ID
    $roleDefinitionId = "00000000-0000-0000-0000-000000000002"
    $cosmosAccountId = az cosmosdb show `
        --name $AccountName `
        --resource-group $ResourceGroupName `
        --query id `
        --output tsv

    az cosmosdb sql role assignment create `
        --account-name $AccountName `
        --resource-group $ResourceGroupName `
        --role-definition-id $roleDefinitionId `
        --principal-id $principalId `
        --scope $cosmosAccountId `
        --output none 2>$null
    Write-Host "     Cosmos DB Data Contributor role assigned to '$WebAppName'."
} else {
    Write-Host "     No -WebAppName specified — skipping role assignment."
    Write-Host "     Run again with -WebAppName to assign Managed Identity access."
}

# ── Output ─────────────────────────────────────────────────

$endpoint = az cosmosdb show `
    --name $AccountName `
    --resource-group $ResourceGroupName `
    --query documentEndpoint `
    --output tsv

Write-Host "`n=== Provisioning Complete ===" -ForegroundColor Cyan
Write-Host ""
Write-Host "Add this to your .env file:" -ForegroundColor Yellow
Write-Host ""
Write-Host "  COSMOS_ENDPOINT=$endpoint" -ForegroundColor White
Write-Host ""
