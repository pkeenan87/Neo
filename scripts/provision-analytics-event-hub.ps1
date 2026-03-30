<#
.SYNOPSIS
    Provisions a second Azure Event Hub for Neo analytics events.

.DESCRIPTION
    Creates an Event Hub (neo-analytics) within the existing Event Hub Namespace
    for high-volume analytics events (tool_execution, token_usage, skill_invocation,
    session_started, session_ended). Reuses the same namespace as the primary
    neo-logs hub. Idempotent — safe to re-run without creating duplicates.

    This is optional. If not provisioned, all events route to the primary hub.

.EXAMPLE
    ./provision-analytics-event-hub.ps1
    ./provision-analytics-event-hub.ps1 -NamespaceName "neo-prod-eventhub-ns" -EventHubName "neo-analytics"
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
    [string]$EventHubName = "neo-analytics",

    [ValidateRange(1, 32)]
    [int]$PartitionCount = 2,

    [ValidateRange(1, 7)]
    [int]$MessageRetentionDays = 1,

    [ValidateNotNullOrEmpty()]
    [string]$AuthRuleName = "neo-analytics-send-policy"
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
#  Verify Namespace exists
# ─────────────────────────────────────────────────────────────

Write-Host "`n  Verifying Event Hub Namespace: $NamespaceName..." -ForegroundColor Cyan
$nsJson = az eventhubs namespace show `
    --name $NamespaceName `
    --resource-group $ResourceGroupName `
    --output json 2>$null

if (-not $nsJson) {
    Write-Host "`n  ERROR: Event Hub Namespace '$NamespaceName' not found." -ForegroundColor Red
    Write-Host "  Run provision-event-hub.ps1 first to create the namespace.`n" -ForegroundColor Red
    exit 1
}
Write-Host "  Namespace found." -ForegroundColor Green

# ─────────────────────────────────────────────────────────────
#  Event Hub
# ─────────────────────────────────────────────────────────────

Write-Host "`n  Creating Analytics Event Hub: $EventHubName (partitions: $PartitionCount, retention: ${MessageRetentionDays}d)..." -ForegroundColor Cyan
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
Write-Host "  Analytics Event Hub ready." -ForegroundColor Green

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
Write-Host "  Analytics Event Hub provisioning complete!" -ForegroundColor Green
Write-Host "  ============================================" -ForegroundColor Green
Write-Host ""
Write-Host "  Namespace:         $NamespaceName (existing)"
Write-Host "  Event Hub:         $EventHubName"
Write-Host "  Partitions:        $PartitionCount"
Write-Host "  Retention:         ${MessageRetentionDays} day(s)"
Write-Host "  Auth Rule:         $AuthRuleName (Send-only)"
Write-Host ""
Write-Host "  Add these to your .env file:" -ForegroundColor Yellow
Write-Host ""
Write-Host "  EVENT_HUB_ANALYTICS_CONNECTION_STRING=`"$connString`"" -ForegroundColor Gray
Write-Host "  EVENT_HUB_ANALYTICS_NAME=`"$EventHubName`"" -ForegroundColor Gray
Write-Host ""
Write-Host "  Event routing:" -ForegroundColor Yellow
Write-Host "    neo-logs       <- operational, destructive_action, budget_alert" -ForegroundColor Gray
Write-Host "    neo-analytics  <- tool_execution, token_usage, skill_invocation, session_started, session_ended" -ForegroundColor Gray
Write-Host ""
