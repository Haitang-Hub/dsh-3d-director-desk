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

:: 1. director-mcp (port 17372; dev and Desktop plugin share one port, healthy bridge is reused)
:: Verify /health identity before starting/reusing: a foreign service squatting 17372
:: must not make us blindly spawn a second bridge that dies with EADDRINUSE.
netstat -ano | findstr /r ":17372 .*LISTENING" >nul 2>nul && (
    curl -s -m 2 http://127.0.0.1:17372/health 2>nul | findstr "director-desk" >nul 2>nul && (
        echo [OK] director-mcp 17372 already listening (dev or plugin) - reusing it
    ) || (
        echo [ERR] port 17372 is occupied by another service ^(not director-mcp^) - bridge not started
    )
) || (
    start "director-mcp 17372" cmd /k "pushd "%MCP_DIR%" && set STORE_PORT=17372&& node index.js"
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
