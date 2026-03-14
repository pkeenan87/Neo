# sign.ps1 — Sign a file with Authenticode using the machine's code-signing certificate
# Usage: powershell -ExecutionPolicy Bypass -File build/sign.ps1 -FilePath <path>
# Optional: -SkipSign to skip signing (for dev builds without a cert)

param(
    [Parameter(Mandatory = $true)]
    [string]$FilePath,

    [switch]$SkipSign
)

$ErrorActionPreference = "Stop"

if ($SkipSign) {
    Write-Host "Signing skipped (-SkipSign flag set)" -ForegroundColor Yellow
    exit 0
}

if (-not (Test-Path $FilePath)) {
    Write-Error "File not found: $FilePath"
    exit 1
}

$cert = Get-ChildItem Cert:\CurrentUser\My -CodeSigningCert | Select-Object -First 1

if (-not $cert) {
    Write-Error "No code-signing certificate found in Cert:\CurrentUser\My. Install a code-signing cert or use -SkipSign for unsigned builds."
    exit 1
}

Write-Host "Signing $FilePath with certificate: $($cert.Subject)" -ForegroundColor Cyan

$result = Set-AuthenticodeSignature `
    -FilePath $FilePath `
    -Certificate $cert `
    -TimestampServer "http://timestamp.digicert.com"

if ($result.Status -ne "Valid") {
    Write-Error "Signing failed for $FilePath — status: $($result.Status), message: $($result.StatusMessage)"
    exit 1
}

Write-Host "Signed successfully: $FilePath" -ForegroundColor Green
