# 3D Director Desk - Local Startup
$ErrorActionPreference = "Continue"
$root = $PSScriptRoot
$webDir = Join-Path $root "web"

# web needs --legacy-peer-deps: antd 6 conflicts with pro-components beta peer range
if (-not (Test-Path "$webDir/node_modules")) {
    Write-Host "Installing web dependencies, first run only..." -ForegroundColor Cyan
    Push-Location $webDir
    npm install --legacy-peer-deps
    $failed = ($LASTEXITCODE -ne 0)
    Pop-Location
    if ($failed) { Write-Host "web npm install failed" -ForegroundColor Red; exit 1 }
}

Write-Host "Web: http://localhost:5080" -ForegroundColor Yellow
Write-Host "Press Ctrl+C to stop" -ForegroundColor Gray

Set-Location $webDir
npm run dev
