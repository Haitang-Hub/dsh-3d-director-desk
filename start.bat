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

:: --- port already serving: verify it is OUR app before reusing ---
:: A foreign/zombie process squatting 5080 returns a blank page; verify identity
:: (the theme_store marker is present in both dev and built index.html).
netstat -ano | findstr /r ":5080 .*LISTENING" >nul 2>nul
if not errorlevel 1 (
    curl -s -m 3 http://127.0.0.1:5080/ 2>nul | findstr /c:"3d-director-desk:theme_store" >nul 2>nul
    if not errorlevel 1 (
        echo [OK] web 5080 is serving our app - reusing the running instance
        echo Web: http://localhost:5080
        start "" http://localhost:5080
        pause
        exit /b 0
    ) else (
        echo [WARN] port 5080 is occupied by another service ^(not this app^) - not reusing
        echo        Please free port 5080 ^(or close the conflicting program^), then run again.
        pause
        exit /b 1
    )
)

:: web install (pro-components beta removed; no peer conflict, --legacy-peer-deps not needed)
if not exist "%WEB_DIR%\node_modules" (
    echo [..] Installing web dependencies, first run only
    pushd "%WEB_DIR%"
    call npm install
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
set "MCP_HEALTHY="
netstat -ano | findstr /r ":17372 .*LISTENING" >nul 2>nul
if not errorlevel 1 (
    curl -s -m 2 http://127.0.0.1:17372/health 2>nul | findstr "director-desk" >nul 2>nul
    if not errorlevel 1 (
        set "MCP_HEALTHY=1"
        echo [OK] director-mcp 17372 already listening ^(dev or plugin^) - reusing it
    ) else (
        echo [ERR] port 17372 is occupied by another service ^(not director-mcp^) - bridge not started
    )
)
if not defined MCP_HEALTHY (
    netstat -ano | findstr /r ":17372 .*LISTENING" >nul 2>nul
    if errorlevel 1 (
        start "director-mcp 17372" /D "%MCP_DIR%" cmd /k "set STORE_PORT=17372&& node index.js"
        echo [OK] director-mcp started
    )
)

:: 2. open browser once web dev server is up (delayed, non-blocking)
start "" cmd /c "timeout /t 4 >nul && start http://localhost:5080"

:: 3. Web dev server (blocking, current window)
echo Web: http://localhost:5080
echo Press Ctrl+C to stop
echo.

pushd "%WEB_DIR%"
call npm run dev
if errorlevel 1 (
    popd
    echo.
    echo [ERR] web dev server exited unexpectedly, see the messages above
    pause
    exit /b 1
)
popd

endlocal
