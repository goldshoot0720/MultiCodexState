@echo off
setlocal enabledelayedexpansion

REM ===================================================================
REM  MultiCodexState installer for Windows CMD
REM  Use this when PowerShell is unavailable.
REM
REM  Usage:
REM    curl -fsSL https://raw.githubusercontent.com/goldshoot0720/MultiCodexState/main/install.cmd -o install.cmd && install.cmd && del install.cmd
REM ===================================================================

set "REPO=goldshoot0720/MultiCodexState"
set "BRANCH=main"
set "INSTALL_DIR=%USERPROFILE%\.multicodexstate"
set "CODEX_HOME_DIR=%USERPROFILE%\.codex"

REM Allow overrides via arguments: install.cmd [installDir]
if not "%~1"=="" set "INSTALL_DIR=%~1"

echo.
echo   MultiCodexState installer
echo   ------------------------
echo.

REM --- Prerequisites ---------------------------------------------------

where node >nul 2>&1
if !ERRORLEVEL! neq 0 (
    echo   Node.js 18+ is required but 'node' was not found on PATH. >&2
    echo   Install it from https://nodejs.org and re-run this script. >&2
    exit /b 1
)

for /f "tokens=*" %%v in ('node --version') do set "NODE_VER=%%v"
set "NODE_VER=!NODE_VER:v=!"
for /f "tokens=1 delims=." %%m in ("!NODE_VER!") do set "NODE_MAJOR=%%m"
if !NODE_MAJOR! LSS 18 (
    echo   Node.js 18+ is required ^(found v!NODE_VER!^). >&2
    exit /b 1
)
echo   [ok] node v!NODE_VER!

where npm >nul 2>&1
if !ERRORLEVEL! neq 0 (
    echo   npm was not found on PATH ^(it ships with Node.js^). >&2
    exit /b 1
)
echo   [ok] npm available

where git >nul 2>&1
if !ERRORLEVEL! neq 0 (
    echo   git is required but was not found on PATH. >&2
    echo   Install it from https://git-scm.com and re-run this script. >&2
    exit /b 1
)
echo   [ok] git available

REM --- Fetch source ----------------------------------------------------

if exist "!INSTALL_DIR!\package.json" (
    echo.
    echo   Already installed at !INSTALL_DIR! - updating...

    set "UPD_SHA="
    for /f "usebackq tokens=*" %%s in (`powershell -NoProfile -ExecutionPolicy Bypass -Command "try { $ProgressPreference='SilentlyContinue'; (Invoke-RestMethod -UseBasicParsing -TimeoutSec 20 -Headers @{'User-Agent'='MultiCodexState-installer';'Accept'='application/vnd.github+json'} -Uri 'https://api.github.com/repos/!REPO!/commits/!BRANCH!').sha } catch { }" 2^>nul`) do set "UPD_SHA=%%s"

    if exist "!INSTALL_DIR!\.git" (
        if defined UPD_SHA (
            git -C "!INSTALL_DIR!" fetch --depth 1 origin !UPD_SHA! >nul 2>&1
        ) else (
            git -C "!INSTALL_DIR!" fetch --depth 1 origin !BRANCH! >nul 2>&1
        )
        if !ERRORLEVEL! equ 0 (
            git -C "!INSTALL_DIR!" checkout -q FETCH_HEAD >nul 2>&1
            echo   [ok] source updated
        ) else (
            echo   [!!] update failed, reinstalling from scratch
            rmdir /s /q "!INSTALL_DIR!"
        )
    ) else (
        rmdir /s /q "!INSTALL_DIR!"
    )
)
if not exist "!INSTALL_DIR!\package.json" (
    echo   Downloading source to !INSTALL_DIR!...
    if exist "!INSTALL_DIR!" rmdir /s /q "!INSTALL_DIR!"

    REM Resolve the branch to a concrete commit SHA first. Branch-name URLs
    REM go through a CDN with a long TTL, so a fresh clone right after a fix
    REM can still bring down the previous revision. A SHA never goes stale.
    set "SHA="
    for /f "usebackq tokens=*" %%s in (`powershell -NoProfile -ExecutionPolicy Bypass -Command "try { $ProgressPreference='SilentlyContinue'; (Invoke-RestMethod -UseBasicParsing -TimeoutSec 20 -Headers @{'User-Agent'='MultiCodexState-installer';'Accept'='application/vnd.github+json'} -Uri 'https://api.github.com/repos/!REPO!/commits/!BRANCH!').sha } catch { }" 2^>nul`) do set "SHA=%%s"

    if defined SHA (
        echo   Fetching commit !SHA:~0,7! on !BRANCH!...
        git init -q "!INSTALL_DIR!" >nul 2>&1
        git -C "!INSTALL_DIR!" remote add origin "https://github.com/!REPO!.git" >nul 2>&1
        git -C "!INSTALL_DIR!" fetch --depth 1 origin !SHA! >nul 2>&1
        if !ERRORLEVEL! equ 0 (
            git -C "!INSTALL_DIR!" checkout -q FETCH_HEAD >nul 2>&1
        ) else (
            echo   [!!] SHA fetch failed, falling back to the branch name
            rmdir /s /q "!INSTALL_DIR!"
        )
    )

    if not exist "!INSTALL_DIR!\package.json" (
        git clone --depth 1 --branch !BRANCH! "https://github.com/!REPO!.git" "!INSTALL_DIR!" >nul 2>&1
    )

    if not exist "!INSTALL_DIR!\package.json" (
        echo   Failed to clone https://github.com/!REPO!.git >&2
        echo   Check the repository name and your network connection. >&2
        exit /b 1
    )
    echo   [ok] source downloaded
)

REM --- Dependencies ----------------------------------------------------

echo   Installing dependencies ^(chalk^)...
pushd "!INSTALL_DIR!"
call npm install --no-audit --no-fund --loglevel=error >nul 2>&1
set "NPM_EXIT=!ERRORLEVEL!"
popd

if !NPM_EXIT! neq 0 (
    echo   npm install failed ^(exit code !NPM_EXIT!^) >&2
    exit /b 1
)
echo   [ok] dependencies installed

REM --- Register command ------------------------------------------------

echo   Registering the 'MultiCodexState' command...
pushd "!INSTALL_DIR!"
call npm link --no-audit --no-fund --loglevel=error >nul 2>&1
set "LINK_EXIT=!ERRORLEVEL!"
popd

if !LINK_EXIT! neq 0 (
    echo   [!!] npm link failed - you can still run: node "!INSTALL_DIR!\bin\gs.js"
) else (
    echo   [ok] command registered
)

REM --- Verify ----------------------------------------------------------

echo   Verifying installation...
node "!INSTALL_DIR!\bin\gs.js" where >nul 2>&1
if !ERRORLEVEL! equ 0 (
    echo   [ok] smoke test passed
) else (
    echo   [!!] smoke test returned a non-zero exit code
)

REM --- Done ------------------------------------------------------------

echo.
echo   Installation complete!
echo.
echo   Next steps
echo     MultiCodexState              # show help
echo     MultiCodexState login work   # sign in and archive the account
echo     MultiCodexState list --usage # accounts + live quota
echo.
echo   Install dir : !INSTALL_DIR!
echo   Account dir : !CODEX_HOME_DIR!\accounts

if not exist "!CODEX_HOME_DIR!\bin\codex.exe" (
    echo.
    echo   [!!] Codex CLI not found at !CODEX_HOME_DIR!\bin\codex.exe
    echo        Install it first: https://x.ai/cli
)

echo.
endlocal
exit /b 0
