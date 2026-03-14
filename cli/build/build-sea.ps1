# build-sea.ps1 — Build the Node.js Single Executable Application
# Run from the cli/ directory: powershell -ExecutionPolicy Bypass -File build/build-sea.ps1

$ErrorActionPreference = "Stop"

# Verify bundle exists (produced by 'npm run build:bundle')
if (-not (Test-Path "dist/neo-bundle.cjs")) {
    throw "dist/neo-bundle.cjs not found. Run 'npm run build:bundle' first."
}

Write-Host "=== Step 1: Generate SEA blob ===" -ForegroundColor Cyan
node --experimental-sea-config sea-config.json
if ($LASTEXITCODE -ne 0) { throw "SEA blob generation failed" }

Write-Host "=== Step 2: Copy node.exe ===" -ForegroundColor Cyan
$nodeExe = (Get-Command node).Source
Copy-Item $nodeExe -Destination "dist/neo.exe" -Force

Write-Host "=== Step 3: Remove existing signature ===" -ForegroundColor Cyan
# signtool is part of Windows SDK; if unavailable the exe may still work unsigned
try {
    $output = signtool remove /s "dist/neo.exe" 2>&1
    Write-Host "  signtool: $output" -ForegroundColor Gray
} catch {
    Write-Host "  signtool remove skipped: $_ (exe may already be unsigned)" -ForegroundColor Yellow
}

Write-Host "=== Step 4: Inject SEA blob ===" -ForegroundColor Cyan
npx postject dist/neo.exe NODE_SEA_BLOB dist/sea-prep.blob --sentinel-fuse NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2
if ($LASTEXITCODE -ne 0) { throw "postject injection failed" }

Write-Host "`n=== SEA build complete: dist/neo.exe ===" -ForegroundColor Green
