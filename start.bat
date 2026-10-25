@echo off
setlocal
chcp 65001 >nul

echo ============================================================
echo  3D Director Desk - Startup
echo ============================================================
echo.

set "WEB_DIR=%~dp0web"

:: web needs --legacy-peer-deps: antd 6 conflicts with pro-components beta peer range
if not exist "%WEB_DIR%\node_modules" (
    echo [..] Installing web dependencies, first run only
    pushd "%WEB_DIR%"
    call npm install --legacy-peer-deps
    if errorlevel 1 (
        popd
        echo [ERR] web npm install failed
        exit /b 1
    )
    popd
)

echo Starting services...
echo.

:: 1. director-mcp (port 17372) - local project storage + director bridge
start "director-mcp 17372" cmd /k "pushd "%~dp0director-mcp" && node index.js"
echo [OK] director-mcp started
echo.

:: 2. Web dev server (blocking, current window)
echo Web: http://localhost:5080
echo Press Ctrl+C to stop
echo.

pushd "%WEB_DIR%"
call npm run dev
popd

endlocal
