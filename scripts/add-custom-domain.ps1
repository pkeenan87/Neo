<#
.SYNOPSIS
    Adds a custom domain to an existing Azure App Service and registers the
    OAuth redirect URI in the Entra ID app registration.

.DESCRIPTION
    Binds a custom domain to the specified App Service, uploads and binds a
    TLS/SSL certificate (PFX), and adds the new redirect URI to the Entra ID
    app registration so OAuth works on both domains. The existing
    azurewebsites.net domain is not affected.

    Idempotent - safe to re-run without creating duplicates.

.EXAMPLE
    $pw = Read-Host -Prompt "PFX password" -AsSecureString
    ./add-custom-domain.ps1 -CustomDomain "neo.companyname.com" -PfxPath "./certs/neo.pfx" -PfxPassword $pw
    ./add-custom-domain.ps1 -CustomDomain "neo.companyname.com" -PfxPath "./certs/neo.pfx" -PfxPassword $pw -WebAppName "neo-prod" -ResourceGroupName "neo-prod-rg"
#>

param(
    [Parameter(Mandatory)]
    [ValidateNotNullOrEmpty()]
    [string]$CustomDomain,

    [Parameter(Mandatory)]
    [ValidateScript({ Test-Path $_ })]
    [string]$PfxPath,

    [Parameter(Mandatory)]
    [System.Security.SecureString]$PfxPassword,

    [ValidateNotNullOrEmpty()]
    [string]$ResourceGroupName = "neo-rg",

    [ValidateNotNullOrEmpty()]
    [string]$WebAppName = "neo-web",

    [string]$EntraAppId = ""
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

$account = az account show 2>&1 | ConvertFrom-Json -ErrorAction SilentlyContinue
if (-not $account) {
    Write-Host "`n  ERROR: Not logged in to Azure CLI. Run 'az login' first.`n" -ForegroundColor Red
    exit 1
}

Write-Host "  Subscription: $($account.name) ($($account.id))" -ForegroundColor Gray

# ─────────────────────────────────────────────────────────────
#  Step 1: DNS verification reminder
# ─────────────────────────────────────────────────────────────

$defaultHostname = "$WebAppName.azurewebsites.net"

Write-Host "`n  IMPORTANT: Before proceeding, ensure these DNS records exist:" -ForegroundColor Yellow
Write-Host "    CNAME  $CustomDomain  ->  $defaultHostname" -ForegroundColor Yellow
Write-Host "    (or)   A record pointing to the App Service IP" -ForegroundColor Yellow
Write-Host "    TXT    asuid.$CustomDomain  ->  (verification ID from Azure portal)`n" -ForegroundColor Yellow

$confirm = Read-Host "  Have you configured DNS? (y/N)"
if ($confirm -ne "y" -and $confirm -ne "Y") {
    Write-Host "  Aborted. Configure DNS first, then re-run this script.`n" -ForegroundColor Red
    exit 0
}

# ─────────────────────────────────────────────────────────────
#  Step 2: Add custom domain binding
# ─────────────────────────────────────────────────────────────

Write-Host "`n  Adding custom domain '$CustomDomain' to App Service '$WebAppName'..." -ForegroundColor Cyan

$existingHostnames = az webapp config hostname list `
    --resource-group $ResourceGroupName `
    --webapp-name $WebAppName `
    --query "[].name" -o tsv 2>&1

if ($existingHostnames -match [regex]::Escape($CustomDomain)) {
    Write-Host "  Custom domain already bound - skipping." -ForegroundColor Gray
} else {
    az webapp config hostname add `
        --resource-group $ResourceGroupName `
        --webapp-name $WebAppName `
        --hostname $CustomDomain

    if ($LASTEXITCODE -ne 0) {
        Write-Host "`n  ERROR: Failed to add custom domain. Check DNS configuration.`n" -ForegroundColor Red
        exit 1
    }
    Write-Host "  Custom domain bound successfully." -ForegroundColor Green
}

# ─────────────────────────────────────────────────────────────
#  Step 3: Upload and bind TLS certificate
# ─────────────────────────────────────────────────────────────

Write-Host "`n  Uploading TLS certificate..." -ForegroundColor Cyan

# Convert SecureString to plaintext only at the point of use
$pfxPasswordPlain = [System.Runtime.InteropServices.Marshal]::PtrToStringAuto(
    [System.Runtime.InteropServices.Marshal]::SecureStringToBSTR($PfxPassword)
)

$thumbprint = az webapp config ssl upload `
    --resource-group $ResourceGroupName `
    --name $WebAppName `
    --certificate-file $PfxPath `
    --certificate-password $pfxPasswordPlain `
    --query thumbprint -o tsv

$pfxPasswordPlain = $null

if ($LASTEXITCODE -ne 0 -or -not $thumbprint) {
    Write-Host "`n  ERROR: Failed to upload certificate.`n" -ForegroundColor Red
    exit 1
}

Write-Host "  Certificate uploaded (thumbprint: $thumbprint)." -ForegroundColor Green

Write-Host "  Binding certificate to '$CustomDomain'..." -ForegroundColor Cyan

az webapp config ssl bind `
    --resource-group $ResourceGroupName `
    --name $WebAppName `
    --certificate-thumbprint $thumbprint `
    --ssl-type SNI

if ($LASTEXITCODE -ne 0) {
    Write-Host "`n  ERROR: Failed to bind certificate.`n" -ForegroundColor Red
    exit 1
}

Write-Host "  TLS binding complete." -ForegroundColor Green

# ─────────────────────────────────────────────────────────────
#  Step 4: Add redirect URI to Entra ID app registration
# ─────────────────────────────────────────────────────────────

if ($EntraAppId) {
    Write-Host "`n  Adding OAuth redirect URI to Entra ID app '$EntraAppId'..." -ForegroundColor Cyan

    $newRedirectUri = "https://$CustomDomain/api/auth/callback/microsoft-entra-id"

    # Get existing redirect URIs (fail hard if this errors to avoid wiping URIs)
    $appShowRaw = az ad app show --id $EntraAppId --query "web.redirectUris" -o json 2>&1
    if ($LASTEXITCODE -ne 0) {
        Write-Host "`n  ERROR: Failed to query Entra ID app '$EntraAppId'. Check the app ID and permissions.`n" -ForegroundColor Red
        exit 1
    }
    $existingUris = $appShowRaw | ConvertFrom-Json
    if ($null -eq $existingUris) { $existingUris = @() }

    if ($existingUris -contains $newRedirectUri) {
        Write-Host "  Redirect URI already registered - skipping." -ForegroundColor Gray
    } else {
        $updatedUris = @($existingUris) + @($newRedirectUri)

        az ad app update --id $EntraAppId --web-redirect-uris @($updatedUris)

        if ($LASTEXITCODE -ne 0) {
            Write-Host "`n  ERROR: Failed to update Entra ID redirect URIs." -ForegroundColor Red
            Write-Host "  AUTH_URL has NOT been updated. Fix the Entra ID registration first:" -ForegroundColor Red
            Write-Host "    $newRedirectUri`n" -ForegroundColor Red
            exit 1
        }
        Write-Host "  Redirect URI added: $newRedirectUri" -ForegroundColor Green
    }
} else {
    Write-Host "`n  NOTE: -EntraAppId not provided. You must manually add this redirect URI:" -ForegroundColor Yellow
    Write-Host "    https://$CustomDomain/api/auth/callback/microsoft-entra-id" -ForegroundColor Yellow
    Write-Host "  Go to: Azure Portal > Entra ID > App registrations > your app > Authentication`n" -ForegroundColor Yellow
}

# ─────────────────────────────────────────────────────────────
#  Step 5: Update AUTH_URL app setting
# ─────────────────────────────────────────────────────────────
# AUTH_URL controls which domain Auth.js uses as the OAuth redirect URI base.
# Changing it to the custom domain means browser-based OAuth on the
# azurewebsites.net domain will no longer work. This is intentional because
# azurewebsites.net is used only for the Teams bot, which authenticates via
# Bot Framework JWT (not browser OAuth).
#
# To roll back:
#   az webapp config appsettings set --resource-group <RG> `
#       --name <APP> --settings "AUTH_URL=https://<app>.azurewebsites.net"

Write-Host "`n  Updating AUTH_URL app setting to 'https://$CustomDomain'..." -ForegroundColor Cyan

az webapp config appsettings set `
    --resource-group $ResourceGroupName `
    --name $WebAppName `
    --settings "AUTH_URL=https://$CustomDomain"

if ($LASTEXITCODE -ne 0) {
    Write-Host "`n  WARNING: Failed to update AUTH_URL. Set it manually in App Settings.`n" -ForegroundColor Yellow
} else {
    Write-Host "  AUTH_URL updated." -ForegroundColor Green
}

# ─────────────────────────────────────────────────────────────
#  Summary
# ─────────────────────────────────────────────────────────────

Write-Host "`n  ===== Custom Domain Setup Complete =====" -ForegroundColor Green
Write-Host ""
Write-Host "  Custom domain:   https://$CustomDomain" -ForegroundColor White
Write-Host "  Fallback domain: https://$defaultHostname" -ForegroundColor White
Write-Host ""
Write-Host "  Verification checklist:" -ForegroundColor Cyan
Write-Host "    [ ] https://$CustomDomain loads the app (internal network)" -ForegroundColor White
Write-Host "    [ ] https://$defaultHostname still loads the app" -ForegroundColor White
Write-Host "    [ ] OAuth login works from https://$CustomDomain" -ForegroundColor White
Write-Host "    [ ] OAuth login works from https://$defaultHostname" -ForegroundColor White
Write-Host "    [ ] Teams bot still works via https://$defaultHostname" -ForegroundColor White
Write-Host "    [ ] CLI users updated NEO_SERVER to https://$CustomDomain" -ForegroundColor White
Write-Host ""
Write-Host "  Entra ID redirect URIs (both must be registered):" -ForegroundColor Cyan
Write-Host "    https://$CustomDomain/api/auth/callback/microsoft-entra-id" -ForegroundColor White
Write-Host "    https://$defaultHostname/api/auth/callback/microsoft-entra-id" -ForegroundColor White
Write-Host ""
