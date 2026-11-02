#Requires -Version 5.1
<#
.SYNOPSIS
    MultiCodexState installer for Windows (PowerShell).

.DESCRIPTION
    Installs MultiCodexState — a multi-account manager for the Codex CLI.

    One-liner:
        irm https://raw.githubusercontent.com/goldshoot0720/MultiCodexState/main/install.ps1 | iex

    Or with options:
        & ([scriptblock]::Create((irm .../install.ps1))) -InstallDir 'C:\Tools\MultiCodexState'

.PARAMETER InstallDir
    Where to install. Default: $env:USERPROFILE\.multicodexstate

.PARAMETER Repo
    Source repository (owner/name). Default: goldshoot0720/MultiCodexState

.PARAMETER Branch
    Branch or tag to install. Default: main

.PARAMETER NoPath
    Skip adding the install directory to the user PATH.

.PARAMETER Force
    Reinstall even if the directory already exists.
#>
param(
    [string]$InstallDir = "$env:USERPROFILE\.multicodexstate",
    [string]$Repo = "goldshoot0720/MultiCodexState",
    [string]$Branch = "main",
    [switch]$NoPath,
    [switch]$Force
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
$ProgressPreference = 'SilentlyContinue'

$STATE_HOME = "$env:USERPROFILE\.codex"
$GITHUB_BASE = "https://raw.githubusercontent.com"

function Write-Step($msg) { Write-Host "  $msg" -ForegroundColor Cyan }
function Write-Ok($msg)   { Write-Host "  [ok] $msg" -ForegroundColor Green }
function Write-Warn2($msg) { Write-Host "  [!!] $msg" -ForegroundColor Yellow }

# Windows PowerShell turns redirected native stderr into ErrorRecords. Git
# progress and npm diagnostics must not bypass our exit-code checks under Stop.
function Invoke-InstallerNative {
    param([string]$FilePath, [string[]]$ArgumentList)

    $ErrorActionPreference = 'Continue'
    $PSNativeCommandUseErrorActionPreference = $false
    $output = @(& $FilePath @ArgumentList 2>&1 | ForEach-Object { "$_" })
    [pscustomobject]@{ ExitCode = $LASTEXITCODE; Output = $output }
}

Write-Host ""
Write-Host "  MultiCodexState installer" -ForegroundColor White
Write-Host "  ------------------------" -ForegroundColor DarkGray
Write-Host ""

# --- 1. Prerequisites ---------------------------------------------------

Write-Step "Checking prerequisites..."

if (-not [Environment]::Is64BitProcess) {
    Write-Host "  32-bit Windows is not supported." -ForegroundColor Red
    exit 1
}

$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) {
    Write-Host "  Node.js 18+ is required but 'node' was not found on PATH." -ForegroundColor Red
    Write-Host "  Install it from https://nodejs.org and re-run this script." -ForegroundColor Gray
    exit 1
}

$nodeVersion = (& node --version).TrimStart('v')
$nodeMajor = [int]($nodeVersion.Split('.')[0])
if ($nodeMajor -lt 18) {
    Write-Host "  Node.js 18+ is required (found v$nodeVersion)." -ForegroundColor Red
    exit 1
}
Write-Ok "node v$nodeVersion"

$npm = Get-Command npm.cmd -ErrorAction SilentlyContinue
if (-not $npm) {
    Write-Host "  npm was not found on PATH (it ships with Node.js)." -ForegroundColor Red
    exit 1
}
Write-Ok "npm available"

$git = Get-Command git -ErrorAction SilentlyContinue
if (-not $git) {
    Write-Host "  git is required but was not found on PATH." -ForegroundColor Red
    Write-Host "  Install it from https://git-scm.com and re-run this script." -ForegroundColor Gray
    exit 1
}
Write-Ok "git available"

# --- 2. Fetch source ----------------------------------------------------

if ((Test-Path $InstallDir) -and -not $Force) {
    if (Test-Path (Join-Path $InstallDir "package.json")) {
        Write-Warn2 "Already installed at $InstallDir"
        Write-Step "Updating instead (use -Force to reinstall from scratch)..."
    }
}

if ((Test-Path (Join-Path $InstallDir ".git")) -and -not $Force) {
    Write-Step "Pulling latest from $Branch..."

    # Prefer the immutable commit SHA — see the clone path below for why.
    $updSha = $null
    try {
        $updApi = Invoke-RestMethod -UseBasicParsing -TimeoutSec 20 `
            -Uri "https://api.github.com/repos/$Repo/commits/$Branch" `
            -Headers @{ 'Accept' = 'application/vnd.github+json'; 'User-Agent' = 'MultiCodexState-installer' }
        $updSha = $updApi.sha
    }
    catch { }

    try {
        $fetchRef = if ($updSha) { $updSha } else { $Branch }
        $fetch = Invoke-InstallerNative git @('-C', $InstallDir, 'fetch', '--depth', '1', 'origin', $fetchRef)
        if ($fetch.ExitCode -ne 0) { throw ($fetch.Output -join "`n") }
        $checkout = Invoke-InstallerNative git @('-C', $InstallDir, 'checkout', '-q', 'FETCH_HEAD')
        if ($checkout.ExitCode -ne 0) { throw ($checkout.Output -join "`n") }
        Write-Ok "source updated"
    }
    catch {
        Write-Warn2 "git update failed: $($_.Exception.Message)"
        Write-Warn2 "Keeping the existing installation. Resolve the update error and retry."
        exit 1
    }
}

if (-not (Test-Path (Join-Path $InstallDir "package.json"))) {
    Write-Step "Downloading source to $InstallDir..."
    if (Test-Path $InstallDir) { Remove-Item -Recurse -Force $InstallDir }
    New-Item -ItemType Directory -Force -Path (Split-Path $InstallDir -Parent) | Out-Null

    $cloneExit = 1
    try {
        # Resolve the branch to a concrete commit SHA first. Branch-name URLs
        # are served through a CDN with a long TTL, so right after a fix is
        # pushed a fresh clone can still pull the previous (broken) revision.
        # The SHA is immutable and therefore never stale.
        $sha = $null
        try {
            $api = Invoke-RestMethod -UseBasicParsing -TimeoutSec 20 `
                -Uri "https://api.github.com/repos/$Repo/commits/$Branch" `
                -Headers @{ 'Accept' = 'application/vnd.github+json'; 'User-Agent' = 'MultiCodexState-installer' }
            $sha = $api.sha
        }
        catch {
            Write-Warn2 "Could not resolve $Branch to a commit SHA; using the branch name directly."
        }

        if ($sha) {
            Write-Step "Fetching commit $($sha.Substring(0, 7)) on $Branch..."
            $clone = Invoke-InstallerNative git @('init', '-q', $InstallDir)
            if ($clone.ExitCode -ne 0) { throw ($clone.Output -join "`n") }
            $clone = Invoke-InstallerNative git @('-C', $InstallDir, 'remote', 'add', 'origin', "https://github.com/$Repo.git")
            if ($clone.ExitCode -ne 0) { throw ($clone.Output -join "`n") }
            $clone = Invoke-InstallerNative git @('-C', $InstallDir, 'fetch', '-q', '--depth', '1', 'origin', $sha)
            if ($clone.ExitCode -ne 0) { throw ($clone.Output -join "`n") }
            $clone = Invoke-InstallerNative git @('-C', $InstallDir, 'checkout', '-q', 'FETCH_HEAD')
            $cloneExit = $clone.ExitCode
        }
        else {
            $clone = Invoke-InstallerNative git @('clone', '--depth', '1', '--branch', $Branch, "https://github.com/$Repo.git", $InstallDir)
            $cloneExit = $clone.ExitCode
        }
    }
    catch {
        Write-Warn2 "git download failed: $($_.Exception.Message)"
    }

    if ($cloneExit -ne 0 -or -not (Test-Path (Join-Path $InstallDir "package.json"))) {
        Write-Host "  Failed to fetch https://github.com/$Repo.git (exit code $cloneExit)" -ForegroundColor Red
        Write-Host "  Check the repository name, the branch '$Branch', and your network connection." -ForegroundColor Gray
        exit 1
    }
    Write-Ok "source downloaded"
}

# --- 3. Install dependencies -------------------------------------------

Write-Step "Installing dependencies (chalk)..."
Push-Location $InstallDir
try {
    $install = Invoke-InstallerNative $npm.Source @('install', '--no-audit', '--no-fund', '--loglevel=error')
    $npmExit = $install.ExitCode
}
finally {
    Pop-Location
}

if ($npmExit -ne 0) {
    Write-Host "  npm install failed (exit code $npmExit)" -ForegroundColor Red
    $install.Output | ForEach-Object { Write-Host "       $_" -ForegroundColor DarkGray }
    exit 1
}
Write-Ok "dependencies installed"

# --- 4. Register the command globally ----------------------------------

Write-Step "Registering the 'MultiCodexState' command..."
Push-Location $InstallDir
try {
    $link = Invoke-InstallerNative $npm.Source @('link', '--no-audit', '--no-fund', '--loglevel=error')
    $linkExit = $link.ExitCode
}
finally {
    Pop-Location
}

if ($linkExit -ne 0) {
    # An older npm shim can cause EEXIST while still launching this install.
    # Verify both execution and target before accepting it; never overwrite an
    # unrelated command with npm link --force.
    $registered = Get-Command MultiCodexState.cmd -ErrorAction SilentlyContinue
    $existingWorks = $false
    if ($registered -and ($link.Output -match 'EEXIST')) {
        $probe = Invoke-InstallerNative $registered.Source @('where', '--json')
        if ($probe.ExitCode -eq 0) {
            try {
                $resolved = ($probe.Output -join "`n") | ConvertFrom-Json
                # Check the shim's target as well as its output: another copy
                # can report the same Codex home.
                $shimTarget = Join-Path (Split-Path $registered.Source -Parent) 'node_modules\multi-codex-state'
                $target = Invoke-InstallerNative node @('-e', "console.log(require('fs').realpathSync(process.argv[1]))", $shimTarget)
                $installTarget = Invoke-InstallerNative node @('-e', "console.log(require('fs').realpathSync(process.argv[1]))", $InstallDir)
                $existingWorks = $target.ExitCode -eq 0 -and $installTarget.ExitCode -eq 0 -and
                    ($target.Output -join '') -eq ($installTarget.Output -join '') -and
                    $resolved.accountsDir -and $resolved.authJson
            }
            catch { $existingWorks = $false }
        }
    }
    if ($existingWorks) {
        Write-Ok "command already registered (verified existing link after npm EEXIST)"
    }
    else {
        Write-Warn2 "npm link failed (exit code $linkExit)"
        $link.Output | ForEach-Object { Write-Host "       $_" -ForegroundColor DarkGray }
        Write-Warn2 "Run directly: node `"$InstallDir\bin\multicodexstate.js`""
    }
}
else {
    Write-Ok "command registered"
}

# --- 5. Verify ----------------------------------------------------------

Write-Step "Verifying installation..."
$smoke = Invoke-InstallerNative node @((Join-Path $InstallDir "bin\multicodexstate.js"), 'where', '--json')
if ($smoke.ExitCode -eq 0) {
    Write-Ok "smoke test passed"
}
else {
    Write-Warn2 "smoke test returned a non-zero exit code"
    $smoke.Output | ForEach-Object { Write-Host "       $_" -ForegroundColor DarkGray }
}

# --- 6. PATH fallback ---------------------------------------------------

if (-not $NoPath) {
    $binDir = Join-Path $InstallDir "bin"
    $userPath = [Environment]::GetEnvironmentVariable("PATH", "User")
    if ($userPath -notlike "*$binDir*") {
        Write-Step "Note: to run without npm link, add $binDir to PATH"
    }
}

# --- Done ---------------------------------------------------------------

$codexHome = if ($env:CODEX_HOME) { $env:CODEX_HOME } else { $STATE_HOME }
$codexCli = Join-Path $codexHome "bin\codex.exe"

Write-Host ""
Write-Host "  Installation complete!" -ForegroundColor Green
Write-Host ""
Write-Host "  Next steps" -ForegroundColor White
Write-Host "    MultiCodexState              # show help" -ForegroundColor Gray
Write-Host "    MultiCodexState login work   # sign in and archive the account" -ForegroundColor Gray
Write-Host "    MultiCodexState list --usage # accounts + live quota" -ForegroundColor Gray
Write-Host ""
Write-Host "  Install dir : $InstallDir" -ForegroundColor DarkGray
Write-Host "  Account dir : $(Join-Path $codexHome 'accounts')" -ForegroundColor DarkGray

if (-not (Test-Path $codexCli)) {
    Write-Host ""
    Write-Warn2 "Codex CLI not found at $codexCli"
    Write-Host "         Install it first: https://x.ai/cli" -ForegroundColor Gray
}

Write-Host ""
if ($env:MultiCodexState_INSTALLED_BY_IRM) {
    Write-Host "  Tip: open a new terminal so PATH changes take effect." -ForegroundColor DarkGray
    Write-Host ""
}
