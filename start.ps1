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

# 1. director-mcp (port 17372) - local project storage + director bridge
Start-Process cmd -ArgumentList '/k', 'title director-mcp 17372 && node index.js' -WorkingDirectory (Join-Path $root "director-mcp")
Write-Host "  director-mcp started" -ForegroundColor Green

# 2. Web dev server (port 5080) - runs in current window
Write-Host "Web: http://localhost:5080" -ForegroundColor Yellow
Write-Host "Press Ctrl+C to stop" -ForegroundColor Gray

Set-Location $webDir
npm run dev
