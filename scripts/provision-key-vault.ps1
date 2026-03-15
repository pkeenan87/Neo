<#
.SYNOPSIS
    Provisions Azure Key Vault for storing Neo tool integration secrets.

.DESCRIPTION
    Creates a Resource Group (if needed) and Key Vault with RBAC authorization,
    soft delete, and purge protection. Assigns the Key Vault Secrets Officer role
    to the specified Web App's Managed Identity. Idempotent — safe to re-run
    without creating duplicates.

.EXAMPLE
    ./provision-key-vault.ps1
    ./provision-key-vault.ps1 -KeyVaultName "neo-vault-prod" -WebAppName "neo-web-prod"
#>

param(
    [ValidateNotNullOrEmpty()]
    [ValidateLength(1, 90)]
    [string]$ResourceGroupName = "neo-rg",

    [ValidateNotNullOrEmpty()]
    [ValidatePattern('^[a-zA-Z][a-zA-Z0-9\-]{1,22}[a-zA-Z0-9]$')]
    [string]$KeyVaultName = "neo-vault",

    [ValidateNotNullOrEmpty()]
    [string]$Location = "eastus",

    [string]$WebAppName = ""
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

# ── Prerequisites ──────────────────────────────────────────

Write-Host "`n=== Neo Key Vault Provisioning ===" -ForegroundColor Cyan

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
Write-Host "Key Vault: $KeyVaultName" -ForegroundColor Yellow
Write-Host "Location: $Location" -ForegroundColor Yellow
Write-Host ""

# ── Resource Group ─────────────────────────────────────────

Write-Host "1/3 Creating resource group..." -ForegroundColor Green
az group create `
    --name $ResourceGroupName `
    --location $Location `
    --output none 2>$null
Write-Host "     Resource group '$ResourceGroupName' ready."

# ── Key Vault ──────────────────────────────────────────────

Write-Host "2/3 Creating Key Vault..." -ForegroundColor Green
$existing = az keyvault show --name $KeyVaultName --resource-group $ResourceGroupName 2>$null | ConvertFrom-Json
if ($existing) {
    Write-Host "     Key Vault '$KeyVaultName' already exists — skipping."
} else {
    az keyvault create `
        --name $KeyVaultName `
        --resource-group $ResourceGroupName `
        --location $Location `
        --enable-rbac-authorization true `
        --enable-soft-delete true `
        --enable-purge-protection true `
        --retention-days 90 `
        --output none
    Write-Host "     Key Vault '$KeyVaultName' created."
}

# ── RSA Encryption Key ─────────────────────────────────────

Write-Host "3/4 Creating RSA encryption key..." -ForegroundColor Green
$existingKey = az keyvault key show --vault-name $KeyVaultName --name neo-api-key-encryption 2>$null | ConvertFrom-Json
if ($existingKey) {
    Write-Host "     Key 'neo-api-key-encryption' already exists — skipping."
} else {
    az keyvault key create `
        --vault-name $KeyVaultName `
        --name neo-api-key-encryption `
        --kty RSA `
        --size 2048 `
        --output none
    Write-Host "     Key 'neo-api-key-encryption' created."
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

    $vaultId = az keyvault show `
        --name $KeyVaultName `
        --resource-group $ResourceGroupName `
        --query id `
        --output tsv

    az role assignment create `
        --role "Key Vault Secrets Officer" `
        --assignee-object-id $principalId `
        --assignee-principal-type ServicePrincipal `
        --scope $vaultId `
        --output none 2>$null
    Write-Host "     Key Vault Secrets Officer role assigned to '$WebAppName'."

    az role assignment create `
        --role "Key Vault Crypto Officer" `
        --assignee-object-id $principalId `
        --assignee-principal-type ServicePrincipal `
        --scope $vaultId `
        --output none 2>$null
    Write-Host "     Key Vault Crypto Officer role assigned to '$WebAppName'."
} else {
    Write-Host "     No -WebAppName specified — skipping role assignment."
    Write-Host "     Run again with -WebAppName to assign Managed Identity access."
}

# ── Output ─────────────────────────────────────────────────

$vaultUrl = "https://${KeyVaultName}.vault.azure.net"

Write-Host "`n=== Provisioning Complete ===" -ForegroundColor Cyan
Write-Host ""
Write-Host "Add this to your .env file:" -ForegroundColor Yellow
Write-Host ""
Write-Host "  KEY_VAULT_URL=$vaultUrl" -ForegroundColor White
Write-Host ""
