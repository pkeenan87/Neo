<#
.SYNOPSIS
    Provisions Azure Blob Storage for hosting Neo CLI installer releases.

.DESCRIPTION
    Creates a Resource Group (if needed), Storage Account, and blob container
    for CLI release artifacts (e.g. neo-setup.exe). Assigns the Storage Blob
    Data Reader role to the specified Web App's Managed Identity so the
    /api/downloads and /api/cli/version routes can access the blobs.
    Idempotent — safe to re-run without creating duplicates.

.EXAMPLE
    ./provision-blob-storage.ps1
    ./provision-blob-storage.ps1 -StorageAccountName "neoreleasesprod" -WebAppName "neo-web-prod"
#>

param(
    [ValidateNotNullOrEmpty()]
    [ValidateLength(1, 90)]
    [string]$ResourceGroupName = "neo-rg",

    [ValidateNotNullOrEmpty()]
    [ValidatePattern('^[a-z0-9]{3,24}$')]
    [string]$StorageAccountName = "neoclireleases",

    [ValidateNotNullOrEmpty()]
    [string]$ContainerName = "cli-releases",

    [ValidateNotNullOrEmpty()]
    [string]$Location = "eastus",

    [ValidateSet("Standard_LRS", "Standard_GRS", "Standard_ZRS")]
    [string]$Sku = "Standard_LRS",

    [string]$WebAppName = ""
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

# ── Prerequisites ──────────────────────────────────────────

Write-Host "`n=== Neo CLI Blob Storage Provisioning ===" -ForegroundColor Cyan

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
Write-Host "Storage Account: $StorageAccountName" -ForegroundColor Yellow
Write-Host "Container: $ContainerName" -ForegroundColor Yellow
Write-Host "Location: $Location" -ForegroundColor Yellow
Write-Host "SKU: $Sku" -ForegroundColor Yellow
Write-Host ""

# ── Resource Group ─────────────────────────────────────────

Write-Host "1/4 Creating resource group..." -ForegroundColor Green
az group create `
    --name $ResourceGroupName `
    --location $Location `
    --output none 2>$null
Write-Host "     Resource group '$ResourceGroupName' ready."

# ── Storage Account ────────────────────────────────────────

Write-Host "2/4 Creating storage account..." -ForegroundColor Green
$existing = az storage account show `
    --name $StorageAccountName `
    --resource-group $ResourceGroupName 2>$null | ConvertFrom-Json
if ($existing) {
    Write-Host "     Storage account '$StorageAccountName' already exists — skipping."
} else {
    az storage account create `
        --name $StorageAccountName `
        --resource-group $ResourceGroupName `
        --location $Location `
        --sku $Sku `
        --kind StorageV2 `
        --min-tls-version TLS1_2 `
        --allow-blob-public-access false `
        --https-only true `
        --output none
    Write-Host "     Storage account '$StorageAccountName' created."
}

# ── Blob Container ─────────────────────────────────────────

Write-Host "3/4 Creating blob container..." -ForegroundColor Green
$existingContainer = az storage container show `
    --name $ContainerName `
    --account-name $StorageAccountName `
    --auth-mode login 2>$null | ConvertFrom-Json
if ($existingContainer) {
    Write-Host "     Container '$ContainerName' already exists — skipping."
} else {
    az storage container create `
        --name $ContainerName `
        --account-name $StorageAccountName `
        --auth-mode login `
        --output none
    Write-Host "     Container '$ContainerName' created."
}

# ── Managed Identity Role Assignment ───────────────────────

Write-Host "4/4 Assigning Managed Identity role..." -ForegroundColor Green
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

    $storageAccountId = az storage account show `
        --name $StorageAccountName `
        --resource-group $ResourceGroupName `
        --query id `
        --output tsv

    az role assignment create `
        --role "Storage Blob Data Reader" `
        --assignee-object-id $principalId `
        --assignee-principal-type ServicePrincipal `
        --scope $storageAccountId `
        --output none 2>$null
    Write-Host "     Storage Blob Data Reader role assigned to '$WebAppName'."
} else {
    Write-Host "     No -WebAppName specified — skipping role assignment."
    Write-Host "     Run again with -WebAppName to assign Managed Identity access."
}

# ── Output ─────────────────────────────────────────────────

Write-Host "`n=== Provisioning Complete ===" -ForegroundColor Cyan
Write-Host ""
Write-Host "Add this to your .env file:" -ForegroundColor Yellow
Write-Host ""
Write-Host "  CLI_STORAGE_ACCOUNT=$StorageAccountName" -ForegroundColor White
Write-Host "  CLI_STORAGE_CONTAINER=$ContainerName" -ForegroundColor White
Write-Host ""
Write-Host "Upload your CLI installer:" -ForegroundColor Yellow
Write-Host ""
Write-Host "  az storage blob upload \" -ForegroundColor White
Write-Host "    --account-name $StorageAccountName \" -ForegroundColor White
Write-Host "    --container-name $ContainerName \" -ForegroundColor White
Write-Host "    --name neo-setup.exe \" -ForegroundColor White
Write-Host "    --file dist/NeoSetup-<version>.exe \" -ForegroundColor White
Write-Host "    --auth-mode login \" -ForegroundColor White
Write-Host "    --overwrite" -ForegroundColor White
Write-Host ""
