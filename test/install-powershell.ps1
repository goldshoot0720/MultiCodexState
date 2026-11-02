# Offline installer regression checks. Run with Windows PowerShell 5.1 or pwsh:
# powershell -NoProfile -ExecutionPolicy Bypass -File test/install-powershell.ps1
$ErrorActionPreference = 'Stop'
$installer = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\install.ps1'))
$sandbox = Join-Path ([IO.Path]::GetTempPath()) ('mcs-installer-' + [guid]::NewGuid())
$toolsDir = Join-Path $sandbox 'tools'
$fixture = Join-Path $toolsDir 'node_modules\multi-codex-state'
$engine = (Get-Process -Id $PID).Path
$keys = @('PATH', 'MCS_TEST_INSTALLER', 'MCS_TEST_DIR', 'MCS_TEST_GIT_FAIL', 'MCS_TEST_NPM_MODE')
$saved = @{}
foreach ($key in $keys) { $saved[$key] = [Environment]::GetEnvironmentVariable($key, 'Process') }

function Write-Fixture($path, $content) {
    [IO.File]::WriteAllText($path, ($content -replace "`r?`n", "`r`n"), [Text.Encoding]::ASCII)
}

function Check($label, $condition, $output) {
    if (-not $condition) { throw "$label failed:`n$output" }
    Write-Host "PASS $label"
}

try {
    New-Item -ItemType Directory -Path (Join-Path $fixture 'bin') -Force | Out-Null
    New-Item -ItemType Directory -Path (Join-Path $fixture '.git') -Force | Out-Null
    Write-Fixture (Join-Path $fixture 'package.json') '{"name":"multi-codex-state"}'
    Write-Fixture (Join-Path $fixture 'bin\multicodexstate.js') @'
console.log(JSON.stringify({authJson: 'fixture-auth', accountsDir: 'fixture-accounts'}));
'@
    Write-Fixture (Join-Path $toolsDir 'git.cmd') @'
@echo off
echo simulated git progress 1>&2
if "%MCS_TEST_GIT_FAIL%"=="1" exit /b 23
exit /b 0
'@
    Write-Fixture (Join-Path $toolsDir 'npm.cmd') @'
@echo off
if "%MCS_TEST_NPM_MODE%"=="install-fail" goto installFailure
if "%~1"=="install" (
  echo simulated npm diagnostic 1>&2
  exit /b 0
)
if "%MCS_TEST_NPM_MODE%"=="eexist" (
  echo npm error code EEXIST 1>&2
  exit /b 17
)
if "%MCS_TEST_NPM_MODE%"=="link-fail" (
  echo npm error code EACCES 1>&2
  exit /b 19
)
exit /b 0
:installFailure
echo simulated npm diagnostic 1>&2
exit /b 31
'@
    $shim = Join-Path $toolsDir 'MultiCodexState.cmd'
    Write-Fixture $shim @'
@echo off
node "%~dp0node_modules\multi-codex-state\bin\multicodexstate.js" %*
exit /b %errorlevel%
'@
    $runner = Join-Path $sandbox 'run.ps1'
    Write-Fixture $runner @'
$ErrorActionPreference = 'Stop'
$PSNativeCommandUseErrorActionPreference = $true
function Invoke-RestMethod { [pscustomobject]@{ sha = ('a' * 40) } }
& ([scriptblock]::Create([IO.File]::ReadAllText($env:MCS_TEST_INSTALLER))) -InstallDir $env:MCS_TEST_DIR -NoPath
'@
    $env:PATH = "$toolsDir;$env:PATH"
    $env:MCS_TEST_INSTALLER = $installer
    $env:MCS_TEST_DIR = $fixture
    $env:MCS_TEST_GIT_FAIL = '0'
    $env:MCS_TEST_NPM_MODE = 'ok'

    $output = & $engine -NoProfile -ExecutionPolicy Bypass -File $runner 2>&1 | Out-String
    $code = $LASTEXITCODE
    Check 'stderr with exit 0 updates and installs successfully' ($code -eq 0 -and $output.Contains('[ok] source updated') -and $output.Contains('[ok] command registered') -and $output.Contains('[ok] smoke test passed')) $output

    $env:MCS_TEST_NPM_MODE = 'eexist'
    $output = & $engine -NoProfile -ExecutionPolicy Bypass -File $runner 2>&1 | Out-String
    Check 'EEXIST accepts the verified existing command' ($LASTEXITCODE -eq 0 -and $output.Contains('verified existing link') -and $output.Contains('[ok] smoke test passed')) $output

    $otherFixture = Join-Path $sandbox 'other-install'
    New-Item -ItemType Directory -Path $otherFixture -Force | Out-Null
    Copy-Item -LiteralPath (Join-Path $fixture 'package.json') -Destination $otherFixture
    Copy-Item -LiteralPath (Join-Path $fixture 'bin') -Destination $otherFixture -Recurse
    New-Item -ItemType Directory -Path (Join-Path $otherFixture '.git') -Force | Out-Null
    $env:MCS_TEST_DIR = $otherFixture
    $output = & $engine -NoProfile -ExecutionPolicy Bypass -File $runner 2>&1 | Out-String
    Check 'EEXIST does not accept a working command for another installation' ($output.Contains('npm link failed (exit code 17)') -and -not $output.Contains('verified existing link')) $output
    $env:MCS_TEST_DIR = $fixture

    Write-Fixture $shim "@echo off`nexit /b 7"
    $output = & $engine -NoProfile -ExecutionPolicy Bypass -File $runner 2>&1 | Out-String
    Check 'EEXIST does not accept a broken command' ($output.Contains('npm link failed (exit code 17)') -and -not $output.Contains('verified existing link')) $output

    $env:MCS_TEST_NPM_MODE = 'link-fail'
    $output = & $engine -NoProfile -ExecutionPolicy Bypass -File $runner 2>&1 | Out-String
    Check 'other link failures retain diagnostics and direct-run instructions' ($output.Contains('npm error code EACCES') -and $output.Contains('Run directly:') -and -not $output.Contains('command registered')) $output

    $env:MCS_TEST_NPM_MODE = 'install-fail'
    $output = & $engine -NoProfile -ExecutionPolicy Bypass -File $runner 2>&1 | Out-String
    Check 'dependency failure stops with its exit code and diagnostics' ($LASTEXITCODE -eq 1 -and $output.Contains('npm install failed (exit code 31)') -and $output.Contains('simulated npm diagnostic') -and -not $output.Contains('Installation complete!')) $output

    $env:MCS_TEST_GIT_FAIL = '1'
    $output = & $engine -NoProfile -ExecutionPolicy Bypass -File $runner 2>&1 | Out-String
    Check 'failed update preserves the existing installation' ($LASTEXITCODE -eq 1 -and $output.Contains('Keeping the existing installation') -and (Test-Path -LiteralPath (Join-Path $fixture 'package.json')) -and -not $output.Contains('Installation complete!')) $output
}
finally {
    foreach ($key in $keys) { [Environment]::SetEnvironmentVariable($key, $saved[$key], 'Process') }
    # Only remove the explicitly created temporary fixture, with no junctions.
    $resolvedSandbox = [IO.Path]::GetFullPath($sandbox)
    $tempRoot = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\') + '\'
    if (-not $resolvedSandbox.StartsWith($tempRoot, [StringComparison]::OrdinalIgnoreCase)) { throw 'Invalid fixture path' }
    if (Test-Path -LiteralPath $resolvedSandbox) { Remove-Item -LiteralPath $resolvedSandbox -Recurse -Force }
}
