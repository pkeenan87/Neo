<#
.SYNOPSIS
    Builds and deploys the Neo web application to Azure App Service.

.DESCRIPTION
    Builds the Next.js app in standalone mode, packages the output as a zip,
    and deploys to an existing Azure Web App via zip deploy. Run
    provision-azure.ps1 first to create the Azure resources.

.EXAMPLE
    ./deploy-azure.ps1
    ./deploy-azure.ps1 -WebAppName "neo-prod" -SkipBuild
#>

param(
    [ValidateNotNullOrEmpty()]
    [ValidateLength(1, 90)]
    [string]$ResourceGroupName = "neo-rg",

    [ValidateNotNullOrEmpty()]
    [ValidatePattern('^[a-z0-9][a-z0-9\-]{0,58}[a-z0-9]$')]
    [string]$WebAppName = "neo-web",

    [switch]$SkipBuild
)

$ErrorActionPreference = "Stop"

$RepoRoot = Split-Path -Parent $PSScriptRoot
$WebDir = Join-Path $RepoRoot "web"

if (-not (Test-Path $WebDir)) {
    Write-Host "`n  ERROR: Could not locate 'web/' directory at '$WebDir'." -ForegroundColor Red
    Write-Host "  Ensure deploy-azure.ps1 lives in the scripts/ subdirectory of the repo.`n" -ForegroundColor Red
    exit 1
}

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

# Verify the Web App exists
$webAppCheck = az webapp show --name $WebAppName --resource-group $ResourceGroupName --output json 2>$null
if (-not $webAppCheck) {
    Write-Host "`n  ERROR: Web App '$WebAppName' not found in resource group '$ResourceGroupName'." -ForegroundColor Red
    Write-Host "  Run provision-azure.ps1 first to create the Azure resources.`n" -ForegroundColor Red
    exit 1
}

Write-Host "  Web App '$WebAppName' found." -ForegroundColor Gray

# Verify project structure
if (-not (Test-Path (Join-Path $WebDir "package.json"))) {
    Write-Host "`n  ERROR: web/package.json not found." -ForegroundColor Red
    Write-Host "  Make sure this script is located in the scripts/ directory of the Neo repo.`n" -ForegroundColor Red
    exit 1
}

if (-not (Get-Command npm -ErrorAction SilentlyContinue)) {
    Write-Host "`n  ERROR: npm is not installed." -ForegroundColor Red
    exit 1
}

# ─────────────────────────────────────────────────────────────
#  Build
# ─────────────────────────────────────────────────────────────

$StandaloneDir = Join-Path $WebDir ".next" "standalone"

if ($SkipBuild) {
    Write-Host "`n  Skipping build (-SkipBuild flag set)." -ForegroundColor Yellow

    if (-not (Test-Path $StandaloneDir)) {
        Write-Host "`n  ERROR: .next/standalone/ not found. Cannot skip build — run without -SkipBuild first.`n" -ForegroundColor Red
        exit 1
    }

    # server.js may be at the standalone root or nested in a subdirectory (monorepo)
    $ServerJs = Get-ChildItem -Path $StandaloneDir -Filter "server.js" -Recurse -File | Select-Object -First 1
    if (-not $ServerJs) {
        Write-Host "`n  ERROR: server.js not found in .next/standalone/. The previous build appears incomplete.`n" -ForegroundColor Red
        exit 1
    }

    $BuildAge = (Get-Date) - (Get-Item $StandaloneDir).LastWriteTime
    if ($BuildAge.TotalHours -gt 24) {
        Write-Host "  WARNING: Build artifact is $([math]::Round($BuildAge.TotalHours, 0)) hours old. Consider rebuilding." -ForegroundColor Yellow
    }
} else {
    Write-Host "`n  Installing dependencies (npm ci — exact lockfile install)..." -ForegroundColor Cyan
    Push-Location $WebDir
    try {
        npm ci
        if ($LASTEXITCODE -ne 0) {
            throw "npm ci failed with exit code $LASTEXITCODE. Lockfile may be out of sync with package.json — run 'npm install' locally and commit the updated lockfile."
        }
        Write-Host "  Dependencies installed." -ForegroundColor Green

        Write-Host "`n  Building Next.js application..." -ForegroundColor Cyan
        npm run build
        if ($LASTEXITCODE -ne 0) {
            throw "npm run build failed with exit code $LASTEXITCODE"
        }
        Write-Host "  Build complete." -ForegroundColor Green
    } finally {
        Pop-Location
    }

    # Verify standalone output exists after build
    if (-not (Test-Path $StandaloneDir)) {
        Write-Host "`n  ERROR: .next/standalone/ not found after build." -ForegroundColor Red
        Write-Host "  Ensure output: 'standalone' is set in web/next.config.js`n" -ForegroundColor Red
        exit 1
    }
}

# Next.js monorepo builds can nest server.js under a subdirectory matching
# the package folder name (e.g. standalone/web/server.js instead of
# standalone/server.js). Detect and resolve the actual server root.
$ServerRoot = $StandaloneDir
if (-not (Test-Path (Join-Path $StandaloneDir "server.js"))) {
    $NestedServer = Get-ChildItem -Path $StandaloneDir -Filter "server.js" -Recurse -File | Select-Object -First 1
    if ($NestedServer) {
        $ServerRoot = $NestedServer.DirectoryName
        Write-Host "  Detected monorepo layout — server.js found at: $($NestedServer.FullName)" -ForegroundColor Yellow
    } else {
        Write-Host "`n  ERROR: server.js not found anywhere in standalone output.`n" -ForegroundColor Red
        exit 1
    }
}

# ─────────────────────────────────────────────────────────────
#  Package
# ─────────────────────────────────────────────────────────────

Write-Host "`n  Packaging deployment artifact..." -ForegroundColor Cyan

$StagingDir = Join-Path ([System.IO.Path]::GetTempPath()) "neo-deploy-$([System.IO.Path]::GetRandomFileName())"
$ZipPath = "$StagingDir.zip"

try {
    # Copy the server root (contains server.js and trimmed node_modules).
    # When Next.js nests under a subdirectory, $ServerRoot points to that
    # subdirectory so the zip root will always contain server.js directly.
    Copy-Item -Path $ServerRoot -Destination $StagingDir -Recurse

    # Copy public/ assets (not included in standalone)
    $PublicDir = Join-Path $WebDir "public"
    if (Test-Path $PublicDir) {
        Copy-Item -Path $PublicDir -Destination (Join-Path $StagingDir "public") -Recurse
    }

    # Copy .next/static/ (not included in standalone)
    $StaticDir = Join-Path $WebDir ".next" "static"
    if (Test-Path $StaticDir) {
        $DestStatic = Join-Path $StagingDir ".next" "static"
        New-Item -ItemType Directory -Path (Join-Path $StagingDir ".next") -Force | Out-Null
        Copy-Item -Path $StaticDir -Destination $DestStatic -Recurse
    }

    # Copy skills/ directory (skill markdown files read at runtime)
    $SkillsDir = Join-Path $WebDir "skills"
    if (Test-Path $SkillsDir) {
        Copy-Item -Path $SkillsDir -Destination (Join-Path $StagingDir "skills") -Recurse
        $SkillCount = (Get-ChildItem -Path $SkillsDir -Filter "*.md" -File).Count
        Write-Host "  Copied $SkillCount skill file(s)." -ForegroundColor Green
    }

    # Also copy node_modules from the standalone root if server root is nested,
    # since Next.js hoists shared dependencies to the standalone root.
    if ($ServerRoot -ne $StandaloneDir) {
        $RootNodeModules = Join-Path $StandaloneDir "node_modules"
        $StagingNodeModules = Join-Path $StagingDir "node_modules"
        if ((Test-Path $RootNodeModules) -and -not (Test-Path $StagingNodeModules)) {
            Copy-Item -Path $RootNodeModules -Destination $StagingNodeModules -Recurse
        }
    }

    # Create zip
    Compress-Archive -Path (Join-Path $StagingDir "*") -DestinationPath $ZipPath -Force

    $ZipSize = [math]::Round((Get-Item $ZipPath).Length / 1MB, 1)
    Write-Host "  Package created: $ZipSize MB" -ForegroundColor Green

    # ─────────────────────────────────────────────────────────
    #  Deploy
    # ─────────────────────────────────────────────────────────

    Write-Host "`n  Deploying to $WebAppName..." -ForegroundColor Cyan
    az webapp deploy `
        --resource-group $ResourceGroupName `
        --name $WebAppName `
        --src-path $ZipPath `
        --type zip `
        --output none
    if ($LASTEXITCODE -ne 0) {
        Write-Host "`n  ERROR: Deployment failed.`n" -ForegroundColor Red
        exit 1
    }

    Write-Host "  Deployment complete." -ForegroundColor Green

    # Configure the startup command so Azure runs the Next.js standalone server
    # instead of looking for a default entry point.
    Write-Host "`n  Configuring startup command..." -ForegroundColor Cyan
    az webapp config set `
        --resource-group $ResourceGroupName `
        --name $WebAppName `
        --startup-file "node server.js" `
        --output none
    if ($LASTEXITCODE -ne 0) {
        Write-Host "  WARNING: Failed to set startup command. You may need to set it manually in Azure Portal." -ForegroundColor Yellow
        Write-Host "  Set Startup Command to: node server.js" -ForegroundColor Yellow
    } else {
        Write-Host "  Startup command set to: node server.js" -ForegroundColor Green
    }

} finally {
    # ─────────────────────────────────────────────────────────
    #  Cleanup
    # ─────────────────────────────────────────────────────────

    try {
        if (Test-Path $StagingDir) { Remove-Item -Path $StagingDir -Recurse -Force }
        if (Test-Path $ZipPath) { Remove-Item -Path $ZipPath -Force }
    } catch {
        Write-Host "  WARNING: Failed to clean up temp files at '$StagingDir'." -ForegroundColor Yellow
    }
}

# ─────────────────────────────────────────────────────────────
#  Summary
# ─────────────────────────────────────────────────────────────

Write-Host "`n  ============================================" -ForegroundColor Green
Write-Host "  Deployment complete!" -ForegroundColor Green
Write-Host "  ============================================" -ForegroundColor Green
Write-Host ""
Write-Host "  Web App: $WebAppName"
Write-Host "  URL:     https://$WebAppName.azurewebsites.net"
Write-Host ""
Write-Host "  It may take a minute for the app to start.`n" -ForegroundColor Yellow
