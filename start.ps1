# 3D Director Desk - Local Startup
$ErrorActionPreference = "Continue"
$root = $PSScriptRoot
$webDir = Join-Path $root "web"
$mcpDir = Join-Path $root "director-mcp"

Write-Host "============ 3D Director Desk - Startup ============" -ForegroundColor Cyan

# --- node check ---
if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    Write-Host "[ERR] node not found in PATH, install Node.js >=18 first" -ForegroundColor Red
    exit 1
}

# --- port conflict warn (17383 dev mcp / 5080 web) ---
foreach ($port in 17383, 5080) {
    if (Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue) {
        Write-Host "[WARN] port $port is already in use, existing instance may be running" -ForegroundColor Yellow
    }
}

# web needs --legacy-peer-deps: antd 6 conflicts with pro-components beta peer range
if (-not (Test-Path "$webDir/node_modules")) {
    Write-Host "[..] Installing web dependencies, first run only..." -ForegroundColor Cyan
    Push-Location $webDir
    npm install --legacy-peer-deps
    $failed = ($LASTEXITCODE -ne 0)
    Pop-Location
    if ($failed) { Write-Host "[ERR] web npm install failed" -ForegroundColor Red; exit 1 }
}

Write-Host "Starting services..." -ForegroundColor Cyan

# 1. director-mcp (dev port 17383; Desktop plugin bridge keeps 17372) - local storage + director bridge
Start-Process cmd -ArgumentList '/k', 'title director-mcp 17383 && set STORE_PORT=17383&& node index.js' -WorkingDirectory $mcpDir
Write-Host "  director-mcp started" -ForegroundColor Green

# 2. open browser once web dev server is up (delayed, non-blocking)
Start-Process cmd -ArgumentList '/c', 'timeout /t 4 >nul && start http://localhost:5080' -WindowStyle Hidden

# 3. Web dev server (port 5080) - runs in current window
Write-Host "Web: http://localhost:5080" -ForegroundColor Yellow
Write-Host "Press Ctrl+C to stop" -ForegroundColor Gray

Set-Location $webDir
npm run dev
