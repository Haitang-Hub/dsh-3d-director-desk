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

:: --- port conflict warn (5080 web) ---
netstat -ano | findstr /r ":5080 .*LISTENING" >nul 2>nul && (
    echo [WARN] port 5080 is already in use, existing instance may be running
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
:: Verify /health identity before starting/reusing: a foreign service squatting 17383
:: must not make us blindly spawn a second bridge that dies with EADDRINUSE.
netstat -ano | findstr /r ":17383 .*LISTENING" >nul 2>nul && (
    curl -s -m 2 http://127.0.0.1:17383/health 2>nul | findstr "director-desk" >nul 2>nul && (
        echo [OK] director-mcp 17383 already listening - reusing it
    ) || (
        echo [ERR] port 17383 is occupied by another service ^(not director-mcp^) - bridge not started
    )
) || (
    start "director-mcp 17383" cmd /k "pushd "%MCP_DIR%" && set STORE_PORT=17383&& node index.js"
    echo [OK] director-mcp started
)

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
