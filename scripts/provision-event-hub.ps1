<#
.SYNOPSIS
    Provisions Azure Event Hub infrastructure for Neo structured logging.

.DESCRIPTION
    Creates a Resource Group (if needed), Event Hub Namespace, Event Hub, and
    Send-only authorization rule. Idempotent — safe to re-run without creating
    duplicates. Outputs the connection string for .env configuration.

.EXAMPLE
    ./provision-event-hub.ps1
    ./provision-event-hub.ps1 -NamespaceName "neo-prod-eventhub-ns" -Sku "Standard" -Location "westus2"
#>

param(
    [ValidateNotNullOrEmpty()]
    [ValidateLength(1, 90)]
    [string]$ResourceGroupName = "neo-rg",

    [ValidateNotNullOrEmpty()]
    [ValidateLength(1, 50)]
    [string]$NamespaceName = "neo-eventhub-ns",

    [ValidateNotNullOrEmpty()]
    [ValidateLength(1, 256)]
    [string]$EventHubName = "neo-logs",

    [ValidateNotNullOrEmpty()]
    [string]$Location = "eastus",

    [ValidateSet("Basic", "Standard")]
    [string]$Sku = "Basic",

    [ValidateRange(1, 32)]
    [int]$PartitionCount = 2,

    [ValidateRange(1, 7)]
    [int]$MessageRetentionDays = 1,

    [ValidateNotNullOrEmpty()]
    [string]$AuthRuleName = "neo-send-policy"
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
#  Event Hub Namespace
# ─────────────────────────────────────────────────────────────

Write-Host "`n  Creating Event Hub Namespace: $NamespaceName (SKU: $Sku)..." -ForegroundColor Cyan
az eventhubs namespace create `
    --name $NamespaceName `
    --resource-group $ResourceGroupName `
    --location $Location `
    --sku $Sku `
    --output none
if ($LASTEXITCODE -ne 0) {
    Write-Host "`n  ERROR: Failed to create Event Hub Namespace '$NamespaceName'.`n" -ForegroundColor Red
    exit 1
}
Write-Host "  Event Hub Namespace ready." -ForegroundColor Green

# ─────────────────────────────────────────────────────────────
#  Event Hub
# ─────────────────────────────────────────────────────────────

Write-Host "`n  Creating Event Hub: $EventHubName (partitions: $PartitionCount, retention: ${MessageRetentionDays}d)..." -ForegroundColor Cyan
az eventhubs eventhub create `
    --name $EventHubName `
    --namespace-name $NamespaceName `
    --resource-group $ResourceGroupName `
    --partition-count $PartitionCount `
    --message-retention $MessageRetentionDays `
    --output none
if ($LASTEXITCODE -ne 0) {
    Write-Host "`n  ERROR: Failed to create Event Hub '$EventHubName'.`n" -ForegroundColor Red
    exit 1
}
Write-Host "  Event Hub ready." -ForegroundColor Green

# ─────────────────────────────────────────────────────────────
#  Send-only Authorization Rule
# ─────────────────────────────────────────────────────────────

Write-Host "`n  Creating Send-only auth rule: $AuthRuleName..." -ForegroundColor Cyan
az eventhubs eventhub authorization-rule create `
    --name $AuthRuleName `
    --eventhub-name $EventHubName `
    --namespace-name $NamespaceName `
    --resource-group $ResourceGroupName `
    --rights Send `
    --output none
if ($LASTEXITCODE -ne 0) {
    Write-Host "`n  ERROR: Failed to create authorization rule '$AuthRuleName'.`n" -ForegroundColor Red
    exit 1
}
Write-Host "  Authorization rule ready." -ForegroundColor Green

# ─────────────────────────────────────────────────────────────
#  Retrieve Connection String
# ─────────────────────────────────────────────────────────────

Write-Host "`n  Retrieving connection string..." -ForegroundColor Cyan
$connString = az eventhubs eventhub authorization-rule keys list `
    --name $AuthRuleName `
    --eventhub-name $EventHubName `
    --namespace-name $NamespaceName `
    --resource-group $ResourceGroupName `
    --query primaryConnectionString `
    --output tsv
if ($LASTEXITCODE -ne 0) {
    Write-Host "`n  ERROR: Failed to retrieve connection string.`n" -ForegroundColor Red
    exit 1
}

# ─────────────────────────────────────────────────────────────
#  Summary
# ─────────────────────────────────────────────────────────────

Write-Host "`n  ============================================" -ForegroundColor Green
Write-Host "  Event Hub provisioning complete!" -ForegroundColor Green
Write-Host "  ============================================" -ForegroundColor Green
Write-Host ""
Write-Host "  Resource Group:    $ResourceGroupName"
Write-Host "  Namespace:         $NamespaceName ($Sku)"
Write-Host "  Event Hub:         $EventHubName"
Write-Host "  Partitions:        $PartitionCount"
Write-Host "  Retention:         ${MessageRetentionDays} day(s)"
Write-Host "  Auth Rule:         $AuthRuleName (Send-only)"
Write-Host ""
Write-Host "  Add these to your .env file:" -ForegroundColor Yellow
Write-Host ""
Write-Host "  EVENT_HUB_CONNECTION_STRING=`"$connString`"" -ForegroundColor Gray
Write-Host "  EVENT_HUB_NAME=`"$EventHubName`"" -ForegroundColor Gray
Write-Host ""
