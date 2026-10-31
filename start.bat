@echo off
setlocal
chcp 65001 >nul

echo ============================================================
echo  3D Director Desk - Startup
echo ============================================================
echo.

:: --- node check ---
where node >nul 2>nul
if errorlevel 1 (
    echo [ERR] node not found in PATH, install Node.js ^>=18 first
    pause
    exit /b 1
)

set "WEB_DIR=%~dp0web"
set "MCP_DIR=%~dp0director-mcp"

:: --- port conflict warn (17383 dev mcp / 5080 web) ---
for %%P in (17383 5080) do (
    netstat -ano | findstr /r ":%%P .*LISTENING" >nul 2>nul && (
        echo [WARN] port %%P is already in use, existing instance may be running
    )
)

:: web needs --legacy-peer-deps: antd 6 conflicts with pro-components beta peer range
if not exist "%WEB_DIR%\node_modules" (
    echo [..] Installing web dependencies, first run only
    pushd "%WEB_DIR%"
    call npm install --legacy-peer-deps
    if errorlevel 1 (
        popd
        echo [ERR] web npm install failed
        pause
        exit /b 1
    )
    popd
)

echo Starting services...
echo.

:: 1. director-mcp (dev port 17383; Desktop plugin bridge keeps 17372)
start "director-mcp 17383" cmd /k "pushd "%MCP_DIR%" && set STORE_PORT=17383&& node index.js"
echo [OK] director-mcp started

:: 2. open browser once web dev server is up (delayed, non-blocking)
start "" cmd /c "timeout /t 4 >nul && start http://localhost:5080"

:: 3. Web dev server (blocking, current window)
echo Web: http://localhost:5080
echo Press Ctrl+C to stop
echo.

pushd "%WEB_DIR%"
call npm run dev
popd

endlocal
