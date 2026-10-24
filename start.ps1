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

Write-Host "Starting services..." -ForegroundColor Cyan

# 1. Local store (port 17372) - project data saved to disk (data/)
Start-Process cmd -ArgumentList '/k', 'title Store 17372 && node index.js' -WorkingDirectory (Join-Path $root "local-store")
Write-Host "  Store started" -ForegroundColor Green

# 2. Web dev server (port 5080) - runs in current window
Write-Host "Web: http://localhost:5080" -ForegroundColor Yellow
Write-Host "Press Ctrl+C to stop" -ForegroundColor Gray

Set-Location $webDir
npm run dev
