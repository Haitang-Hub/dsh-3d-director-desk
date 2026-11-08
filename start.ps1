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

# 端口在听不代表是我们家的桥——curl /health 核对 plugin 身份字段，
# 防止其它进程占着 17383 时仍盲目启动导致 EADDRINUSE。
function Test-BridgeHealth([int]$Port, [string]$Plugin) {
    try {
        $health = Invoke-RestMethod -Uri "http://127.0.0.1:$Port/health" -TimeoutSec 2
        return [bool]($health.plugin -eq $Plugin)
    } catch { return $false }
}

# --- port conflict warn (5080 web) ---
if (Get-NetTCPConnection -LocalPort 5080 -State Listen -ErrorAction SilentlyContinue) {
    Write-Host "[WARN] port 5080 is already in use, existing instance may be running" -ForegroundColor Yellow
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
if (Get-NetTCPConnection -LocalPort 17383 -State Listen -ErrorAction SilentlyContinue) {
    if (Test-BridgeHealth 17383 "director-desk") {
        Write-Host "  director-mcp 17383 already listening - reusing it" -ForegroundColor Green
    } else {
        Write-Host "[ERR] port 17383 is occupied by another service (not director-mcp) - bridge not started" -ForegroundColor Red
    }
} else {
    Start-Process cmd -ArgumentList '/k', 'title director-mcp 17383 && set STORE_PORT=17383&& node index.js' -WorkingDirectory $mcpDir
    Write-Host "  director-mcp started" -ForegroundColor Green
}

# 2. open browser once web dev server is up (delayed, non-blocking)
Start-Process cmd -ArgumentList '/c', 'timeout /t 4 >nul && start http://localhost:5080' -WindowStyle Hidden

# 3. Web dev server (port 5080) - runs in current window
Write-Host "Web: http://localhost:5080" -ForegroundColor Yellow
Write-Host "Press Ctrl+C to stop" -ForegroundColor Gray

Set-Location $webDir
npm run dev
