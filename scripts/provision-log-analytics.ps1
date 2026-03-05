<#
.SYNOPSIS
    Deploys a custom Log Analytics table and Data Collection Rule for Neo
    structured logs.

.DESCRIPTION
    Creates a custom table (NeoLogs_CL) in an existing Log Analytics workspace
    that matches the LogEntry schema from web/lib/logger.ts, then creates a
    Data Collection Rule (DCR) that writes to that table. Idempotent — safe to
    re-run without creating duplicates.

    The table schema maps directly to the application's LogEntry interface:
      - TimeGenerated (datetime)   — mapped from "timestamp"
      - Level         (string)     — "debug" | "info" | "warn" | "error"
      - Component     (string)     — source component name
      - Message       (string)     — log message text
      - Metadata      (dynamic)    — optional PII-sanitized key-value pairs

    Prerequisites:
      - Azure CLI (az) installed and logged in
      - An existing Log Analytics workspace (provision with provision-azure.ps1)
      - Contributor or higher role on the resource group

.EXAMPLE
    ./provision-log-analytics.ps1
    ./provision-log-analytics.ps1 -WorkspaceName "neo-prod-workspace" -Location "westus2"
    ./provision-log-analytics.ps1 -RetentionDays 90 -TotalRetentionDays 365
#>

param(
    [ValidateNotNullOrEmpty()]
    [ValidateLength(1, 90)]
    [string]$ResourceGroupName = "neo-rg",

    [ValidateNotNullOrEmpty()]
    [ValidateLength(1, 63)]
    [string]$WorkspaceName = "neo-log-workspace",

    [ValidateNotNullOrEmpty()]
    [string]$Location = "eastus",

    [ValidateNotNullOrEmpty()]
    [string]$TableName = "NeoLogs_CL",

    [ValidateNotNullOrEmpty()]
    [string]$DcrName = "neo-logs-dcr",

    [ValidateRange(30, 730)]
    [int]$RetentionDays = 30,

    [ValidateRange(30, 2556)]
    [int]$TotalRetentionDays = 90
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

$SubscriptionId = $account.id
Write-Host "  Subscription: $($account.name) ($SubscriptionId)" -ForegroundColor Gray

# ─────────────────────────────────────────────────────────────
#  Validate workspace exists
# ─────────────────────────────────────────────────────────────

Write-Host "`n  Verifying Log Analytics workspace: $WorkspaceName..." -ForegroundColor Cyan

$workspaceJson = az monitor log-analytics workspace show `
    --resource-group $ResourceGroupName `
    --workspace-name $WorkspaceName `
    --output json 2>$null

if (-not $workspaceJson) {
    Write-Host "`n  ERROR: Log Analytics workspace '$WorkspaceName' not found in resource group '$ResourceGroupName'." -ForegroundColor Red
    Write-Host "  Create one first with:" -ForegroundColor Red
    Write-Host "    az monitor log-analytics workspace create --resource-group $ResourceGroupName --workspace-name $WorkspaceName --location $Location`n" -ForegroundColor Gray
    exit 1
}

$workspace = $workspaceJson | ConvertFrom-Json
$WorkspaceId = $workspace.customerId
$WorkspaceResourceId = $workspace.id
Write-Host "  Workspace found. ID: $WorkspaceId" -ForegroundColor Green

# ─────────────────────────────────────────────────────────────
#  Custom table — NeoLogs_CL
# ─────────────────────────────────────────────────────────────

Write-Host "`n  Creating custom table: $TableName..." -ForegroundColor Cyan

# Table schema matching web/lib/logger.ts LogEntry interface.
# TimeGenerated is required for all custom log tables and maps to the
# application's "timestamp" field. Metadata is stored as dynamic (JSON)
# to accommodate the allowlisted key-value pairs.
$tablePayload = @{
    properties = @{
        schema = @{
            name = $TableName
            columns = @(
                @{ name = "TimeGenerated"; type = "datetime"; description = "Event timestamp (ISO 8601) — mapped from LogEntry.timestamp" }
                @{ name = "Level";         type = "string";   description = "Log level: debug | info | warn | error" }
                @{ name = "Component";     type = "string";   description = "Source component (e.g. executors, session-store, injection-guard)" }
                @{ name = "Message";       type = "string";   description = "Log message text" }
                @{ name = "Metadata";      type = "dynamic";  description = "PII-sanitized metadata (sessionId, toolName, severity, etc.)" }
            )
        }
        retentionInDays      = $RetentionDays
        totalRetentionInDays = $TotalRetentionDays
    }
} | ConvertTo-Json -Depth 10

$tablePayloadFile = [System.IO.Path]::GetTempFileName()
try {
    Set-Content -Path $tablePayloadFile -Value $tablePayload -Encoding UTF8

    az rest `
        --method PUT `
        --url "https://management.azure.com${WorkspaceResourceId}/tables/${TableName}?api-version=2022-10-01" `
        --body "@$tablePayloadFile" `
        --output none

    if ($LASTEXITCODE -ne 0) {
        Write-Host "`n  ERROR: Failed to create custom table '$TableName'.`n" -ForegroundColor Red
        exit 1
    }
} finally {
    Remove-Item -Path $tablePayloadFile -Force -ErrorAction SilentlyContinue
}

Write-Host "  Custom table '$TableName' ready." -ForegroundColor Green

# ─────────────────────────────────────────────────────────────
#  Data Collection Endpoint (DCE)
# ─────────────────────────────────────────────────────────────

$DceName = "$DcrName-endpoint"

Write-Host "`n  Creating Data Collection Endpoint: $DceName..." -ForegroundColor Cyan
az monitor data-collection endpoint create `
    --name $DceName `
    --resource-group $ResourceGroupName `
    --location $Location `
    --public-network-access "Enabled" `
    --output none

if ($LASTEXITCODE -ne 0) {
    Write-Host "`n  ERROR: Failed to create Data Collection Endpoint '$DceName'.`n" -ForegroundColor Red
    exit 1
}

$dceJson = az monitor data-collection endpoint show `
    --name $DceName `
    --resource-group $ResourceGroupName `
    --output json | ConvertFrom-Json

$DceId = $dceJson.id
$DceEndpoint = $dceJson.logsIngestion.endpoint

Write-Host "  Data Collection Endpoint ready." -ForegroundColor Green
Write-Host "  Ingestion endpoint: $DceEndpoint" -ForegroundColor Gray

# ─────────────────────────────────────────────────────────────
#  Data Collection Rule (DCR)
# ─────────────────────────────────────────────────────────────

Write-Host "`n  Creating Data Collection Rule: $DcrName..." -ForegroundColor Cyan

# The DCR defines:
#   1. streamDeclarations — the incoming payload shape (matches LogEntry)
#   2. destinations       — the target Log Analytics workspace
#   3. dataFlows          — maps the stream to the custom table with a
#                           KQL transform that renames "timestamp" to
#                           TimeGenerated and projects all columns
$dcrPayload = @{
    location   = $Location
    properties = @{
        dataCollectionEndpointId = $DceId
        streamDeclarations = @{
            "Custom-$TableName" = @{
                columns = @(
                    @{ name = "timestamp"; type = "datetime" }
                    @{ name = "level";     type = "string" }
                    @{ name = "component"; type = "string" }
                    @{ name = "message";   type = "string" }
                    @{ name = "metadata";  type = "dynamic" }
                )
            }
        }
        destinations = @{
            logAnalytics = @(
                @{
                    workspaceResourceId = $WorkspaceResourceId
                    name                = "neo-workspace"
                }
            )
        }
        dataFlows = @(
            @{
                streams       = @( "Custom-$TableName" )
                destinations  = @( "neo-workspace" )
                transformKql  = "source | project TimeGenerated = timestamp, Level = level, Component = component, Message = message, Metadata = metadata"
                outputStream  = "Custom-$TableName"
            }
        )
    }
} | ConvertTo-Json -Depth 10

$dcrPayloadFile = [System.IO.Path]::GetTempFileName()
try {
    Set-Content -Path $dcrPayloadFile -Value $dcrPayload -Encoding UTF8

    az rest `
        --method PUT `
        --url "https://management.azure.com/subscriptions/${SubscriptionId}/resourceGroups/${ResourceGroupName}/providers/Microsoft.Insights/dataCollectionRules/${DcrName}?api-version=2022-06-01" `
        --body "@$dcrPayloadFile" `
        --output none

    if ($LASTEXITCODE -ne 0) {
        Write-Host "`n  ERROR: Failed to create Data Collection Rule '$DcrName'.`n" -ForegroundColor Red
        exit 1
    }
} finally {
    Remove-Item -Path $dcrPayloadFile -Force -ErrorAction SilentlyContinue
}

Write-Host "  Data Collection Rule '$DcrName' ready." -ForegroundColor Green

# ─────────────────────────────────────────────────────────────
#  Retrieve DCR immutable ID
# ─────────────────────────────────────────────────────────────

Write-Host "`n  Retrieving DCR details..." -ForegroundColor Cyan

$dcrJson = az rest `
    --method GET `
    --url "https://management.azure.com/subscriptions/${SubscriptionId}/resourceGroups/${ResourceGroupName}/providers/Microsoft.Insights/dataCollectionRules/${DcrName}?api-version=2022-06-01" `
    --output json | ConvertFrom-Json

$DcrImmutableId = $dcrJson.properties.immutableId
$DcrResourceId = $dcrJson.id

# ─────────────────────────────────────────────────────────────
#  Summary
# ─────────────────────────────────────────────────────────────

Write-Host "`n  ============================================" -ForegroundColor Green
Write-Host "  Log Analytics deployment complete!" -ForegroundColor Green
Write-Host "  ============================================" -ForegroundColor Green
Write-Host ""
Write-Host "  Resource Group:       $ResourceGroupName"
Write-Host "  Workspace:            $WorkspaceName"
Write-Host "  Workspace ID:         $WorkspaceId"
Write-Host "  Custom Table:         $TableName"
Write-Host "  Retention:            $RetentionDays days (total: $TotalRetentionDays days)"
Write-Host "  DCE Name:             $DceName"
Write-Host "  DCE Endpoint:         $DceEndpoint"
Write-Host "  DCR Name:             $DcrName"
Write-Host "  DCR Immutable ID:     $DcrImmutableId"
Write-Host ""
Write-Host "  Table schema (maps to web/lib/logger.ts LogEntry):" -ForegroundColor Yellow
Write-Host "    TimeGenerated  (datetime)  <- LogEntry.timestamp"
Write-Host "    Level          (string)    <- LogEntry.level"
Write-Host "    Component      (string)    <- LogEntry.component"
Write-Host "    Message        (string)    <- LogEntry.message"
Write-Host "    Metadata       (dynamic)   <- LogEntry.metadata (PII-sanitized)"
Write-Host ""
Write-Host "  To ingest logs via the DCR, use:" -ForegroundColor Yellow
Write-Host "    Endpoint:    $DceEndpoint" -ForegroundColor Gray
Write-Host "    DCR ID:      $DcrImmutableId" -ForegroundColor Gray
Write-Host "    Stream:      Custom-$TableName" -ForegroundColor Gray
Write-Host ""
Write-Host "  To query the table in Log Analytics:" -ForegroundColor Yellow
Write-Host "    $TableName | where Level == `"error`" | order by TimeGenerated desc" -ForegroundColor Gray
Write-Host ""
