# build-installer.ps1 — Compile the Inno Setup installer and sign it
# Run from the cli/ directory: powershell -ExecutionPolicy Bypass -File build/build-installer.ps1

$ErrorActionPreference = "Stop"

# Read version from package.json
$packageJson = Get-Content -Raw "package.json" | ConvertFrom-Json
$version = $packageJson.version
Write-Host "Building installer for version $version" -ForegroundColor Cyan

# Find Inno Setup compiler
$iscc = "iscc"
$innoDefault = "C:\Program Files (x86)\Inno Setup 6\ISCC.exe"
if (Test-Path $innoDefault) {
    $iscc = $innoDefault
} else {
    # Check if iscc is on PATH
    try {
        Get-Command iscc -ErrorAction Stop | Out-Null
    } catch {
        Write-Error "Inno Setup compiler (iscc) not found. Install Inno Setup 6 from https://jrsoftware.org/isdl.php"
        exit 1
    }
}

# Verify neo.exe exists before compiling
if (-not (Test-Path "dist/neo.exe")) {
    Write-Error "dist/neo.exe not found. Run 'npm run build:sea' before building the installer."
    exit 1
}

Write-Host "=== Compiling installer ===" -ForegroundColor Cyan
& $iscc "/DAppVersion=$version" "build/installer.iss"
if ($LASTEXITCODE -ne 0) { throw "Inno Setup compilation failed" }

# Sign the installer
$installerPath = "dist/NeoSetup-$version.exe"
Write-Host "=== Signing installer ===" -ForegroundColor Cyan
& powershell -ExecutionPolicy Bypass -File "build/sign.ps1" -FilePath $installerPath
if ($LASTEXITCODE -ne 0) { throw "Installer signing failed" }

Write-Host "`n=== Installer built: $installerPath ===" -ForegroundColor Green
