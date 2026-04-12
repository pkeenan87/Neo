<#
.SYNOPSIS
    Provisions and deploys the CSV cleanup Azure Function.

.DESCRIPTION
    Creates (or reuses) an Azure Function App on a Consumption plan and
    deploys the timer-triggered CSV cleanup function. The function runs
    daily at 03:00 UTC and deletes orphaned CSV blobs from the
    neo-csv-uploads container when the parent conversation no longer
    exists in Cosmos DB.

    Uses the same Resource Group and Storage Account as the Neo web app.
    Assigns Managed Identity roles for both Cosmos DB (read) and Blob
    Storage (contributor). Idempotent — safe to re-run.

.EXAMPLE
    ./provision-csv-cleanup.ps1
    ./provision-csv-cleanup.ps1 -FunctionAppName "neo-csv-cleanup-prod" -CosmosAccountName "neo-cosmos-prod"
#>

param(
    [ValidateNotNullOrEmpty()]
    [ValidateLength(1, 90)]
    [string]$ResourceGroupName = "neo-rg",

    [ValidateNotNullOrEmpty()]
    [ValidateLength(2, 60)]
    [string]$FunctionAppName = "neo-csv-cleanup",

    [ValidateNotNullOrEmpty()]
    [ValidatePattern('^[a-z0-9]{3,24}$')]
    [string]$StorageAccountName = "neoclireleases",

    [ValidateNotNullOrEmpty()]
    [string]$CsvContainerName = "neo-csv-uploads",

    [ValidateNotNullOrEmpty()]
    [string]$CosmosAccountName = "neo-cosmos",

    [ValidateNotNullOrEmpty()]
    [string]$CosmosDatabase = "neo-db",

    [ValidateNotNullOrEmpty()]
    [string]$CosmosContainer = "conversations",

    [ValidateNotNullOrEmpty()]
    [string]$Location = "eastus",

    [switch]$SkipDeploy
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$FunctionDir = Join-Path $PSScriptRoot ".." "functions" "csv-cleanup"

# ── Prerequisites ──────────────────────────────────────────

Write-Host "`n=== Neo CSV Cleanup Function Provisioning ===" -ForegroundColor Cyan

if (-not (Get-Command az -ErrorAction SilentlyContinue)) {
    Write-Error "Azure CLI ('az') is not installed. Install from https://aka.ms/install-azure-cli"
    exit 1
}

if (-not $SkipDeploy) {
    if (-not (Get-Command func -ErrorAction SilentlyContinue)) {
        Write-Error "Azure Functions Core Tools ('func') is not installed. Install from https://learn.microsoft.com/azure/azure-functions/functions-run-local"
        exit 1
    }
}

$account = az account show 2>$null | ConvertFrom-Json
if (-not $account) {
    Write-Error "Not logged in to Azure CLI. Run 'az login' first."
    exit 1
}

Write-Host "Subscription: $($account.name) ($($account.id))" -ForegroundColor Yellow
Write-Host "Resource Group: $ResourceGroupName" -ForegroundColor Yellow
Write-Host "Function App: $FunctionAppName" -ForegroundColor Yellow
Write-Host "Storage Account: $StorageAccountName" -ForegroundColor Yellow
Write-Host "CSV Container: $CsvContainerName" -ForegroundColor Yellow
Write-Host "Cosmos Account: $CosmosAccountName" -ForegroundColor Yellow
Write-Host "Location: $Location" -ForegroundColor Yellow
Write-Host ""

# ── 1. Create Function App ────────────────────────────────

Write-Host "1/6 Creating Function App..." -ForegroundColor Green

$existing = az functionapp show `
    --name $FunctionAppName `
    --resource-group $ResourceGroupName 2>$null | ConvertFrom-Json

if ($existing) {
    Write-Host "     Function App '$FunctionAppName' already exists — skipping creation."
} else {
    # The storage account used for AzureWebJobsStorage must already exist.
    # We reuse the same account as the web app's blob storage.
    az functionapp create `
        --name $FunctionAppName `
        --resource-group $ResourceGroupName `
        --storage-account $StorageAccountName `
        --consumption-plan-location $Location `
        --runtime node `
        --runtime-version 20 `
        --functions-version 4 `
        --os-type Linux `
        --output none
    Write-Host "     Function App '$FunctionAppName' created."
}

# ── 2. Enable Managed Identity ────────────────────────────

Write-Host "2/6 Enabling Managed Identity..." -ForegroundColor Green

$principalId = az functionapp identity show `
    --name $FunctionAppName `
    --resource-group $ResourceGroupName `
    --query principalId `
    --output tsv 2>$null

if (-not $principalId) {
    $principalId = az functionapp identity assign `
        --name $FunctionAppName `
        --resource-group $ResourceGroupName `
        --query principalId `
        --output tsv
    Write-Host "     Managed Identity enabled (principal: $principalId)."
} else {
    Write-Host "     Managed Identity already enabled (principal: $principalId)."
}

# ── 3. Assign Cosmos DB Data Reader ───────────────────────

Write-Host "3/6 Assigning Cosmos DB Built-in Data Reader role..." -ForegroundColor Green

$cosmosAccountId = az cosmosdb show `
    --name $CosmosAccountName `
    --resource-group $ResourceGroupName `
    --query id `
    --output tsv

# Built-in Data Reader role definition ID (same across all Cosmos accounts).
# 000...001 = Contributor (read+write), 000...002 = Reader (read-only).
# The cleanup function only needs existence checks, so Reader suffices.
$cosmosReaderRoleId = "00000000-0000-0000-0000-000000000002"

# Scope to the specific conversations container rather than the whole
# Cosmos account. This prevents the function identity from reading
# data in any other database or container on the same account.
$cosmosScope = "$cosmosAccountId/dbs/$CosmosDatabase/colls/$CosmosContainer"

# Check if assignment already exists to avoid duplicates
$existingAssignment = az cosmosdb sql role assignment list `
    --account-name $CosmosAccountName `
    --resource-group $ResourceGroupName `
    --query "[?principalId=='$principalId' && roleDefinitionId.contains(@, '$cosmosReaderRoleId')]" `
    --output tsv 2>$null

if ($existingAssignment) {
    Write-Host "     Cosmos DB Data Reader role already assigned — skipping."
} else {
    az cosmosdb sql role assignment create `
        --account-name $CosmosAccountName `
        --resource-group $ResourceGroupName `
        --role-definition-id $cosmosReaderRoleId `
        --principal-id $principalId `
        --scope $cosmosScope `
        --output none
    Write-Host "     Cosmos DB Data Reader role assigned (scoped to $CosmosDatabase/$CosmosContainer)."
}

# ── 4. Assign Blob Storage Contributor ────────────────────

Write-Host "4/6 Assigning Storage Blob Data Contributor role..." -ForegroundColor Green

$storageAccountId = az storage account show `
    --name $StorageAccountName `
    --resource-group $ResourceGroupName `
    --query id `
    --output tsv

# Scope to the specific CSV container, not the whole account.
# No narrower built-in role exists — Blob Data Contributor is the
# minimum that includes both List and Delete.
$containerScope = "$storageAccountId/blobServices/default/containers/$CsvContainerName"

$existingStorageRole = az role assignment list `
    --assignee $principalId `
    --role "Storage Blob Data Contributor" `
    --scope $containerScope `
    --query "[0].id" `
    --output tsv 2>$null

if ($existingStorageRole) {
    Write-Host "     Storage Blob Data Contributor already assigned — skipping."
} else {
    az role assignment create `
        --role "Storage Blob Data Contributor" `
        --assignee-object-id $principalId `
        --assignee-principal-type ServicePrincipal `
        --scope $containerScope `
        --output none
    Write-Host "     Storage Blob Data Contributor assigned on '$CsvContainerName'."
}

# ── 5. Configure App Settings ─────────────────────────────

Write-Host "5/6 Configuring app settings..." -ForegroundColor Green

$cosmosEndpoint = az cosmosdb show `
    --name $CosmosAccountName `
    --resource-group $ResourceGroupName `
    --query documentEndpoint `
    --output tsv

az functionapp config appsettings set `
    --name $FunctionAppName `
    --resource-group $ResourceGroupName `
    --settings `
        "COSMOS_ENDPOINT=$cosmosEndpoint" `
        "COSMOS_DATABASE=$CosmosDatabase" `
        "COSMOS_CONTAINER=$CosmosContainer" `
        "STORAGE_ACCOUNT_NAME=$StorageAccountName" `
        "CSV_CONTAINER_NAME=$CsvContainerName" `
    --output none
Write-Host "     App settings configured."

# ── 6. Build & Deploy ─────────────────────────────────────

if ($SkipDeploy) {
    Write-Host "6/6 Skipping deployment (-SkipDeploy)." -ForegroundColor Yellow
} else {
    Write-Host "6/6 Building and deploying function code..." -ForegroundColor Green

    Push-Location $FunctionDir
    try {
        npm ci --production=false 2>&1 | Out-Null
        npm run build 2>&1 | Out-Null

        func azure functionapp publish $FunctionAppName `
            --typescript `
            --node
    } finally {
        Pop-Location
    }
    Write-Host "     Deployment complete."
}

# ── Done ──────────────────────────────────────────────────

Write-Host "`n=== Provisioning Complete ===" -ForegroundColor Cyan
Write-Host ""
Write-Host "The CSV cleanup function will run daily at 03:00 UTC." -ForegroundColor Yellow
Write-Host "It sweeps the '$CsvContainerName' container for blobs whose" -ForegroundColor Yellow
Write-Host "parent conversation no longer exists in Cosmos DB." -ForegroundColor Yellow
Write-Host ""
Write-Host "To trigger a manual run:" -ForegroundColor Yellow
Write-Host "  az functionapp function invoke \" -ForegroundColor White
Write-Host "    --name $FunctionAppName \" -ForegroundColor White
Write-Host "    --resource-group $ResourceGroupName \" -ForegroundColor White
Write-Host "    --function-name csvCleanup" -ForegroundColor White
Write-Host ""
Write-Host "To view logs:" -ForegroundColor Yellow
Write-Host "  func azure functionapp logstream $FunctionAppName" -ForegroundColor White
Write-Host ""
