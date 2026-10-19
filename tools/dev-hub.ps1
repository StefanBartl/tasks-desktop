<#
.SYNOPSIS
  Build this checkout and run the hub from target/, to look at the interface.

.DESCRIPTION
  Builds the UI, makes cargo embed it, builds the hub, points it at the local engine checkouts and
  runs it. Nothing is installed: no `install`, no `autostart`, no registry or AppData entry.

  Run it in a normal terminal. A Claude session (the Claude app redirects AppData and HKCU) is
  refused on purpose.

.PARAMETER Release
  Build and run the release profile instead of debug.

.PARAMETER NoBuild
  Skip the UI and cargo builds and run what is in target/.

.PARAMETER Background
  `start --open` (hub in the background, browser opened) instead of `serve` (until Ctrl-C). Stop it
  with `tasks-hub stop`.

.PARAMETER Vault
  The vault the engine reads ($TASKS_VAULT). Default: the vault already set, else $REPOS_DIR/tasks-vault.

.EXAMPLE
  .\tools\dev-hub.ps1
  .\tools\dev-hub.ps1 -Background
  .\tools\dev-hub.ps1 -NoBuild -Release
#>
[CmdletBinding()]
param(
  [switch]$Release,
  [switch]$NoBuild,
  [switch]$Background,
  [string]$Vault
)

$ErrorActionPreference = 'Stop'

if ($env:CLAUDECODE) {
  throw 'Run this in a normal terminal, not in a Claude session (the app redirects AppData and the registry).'
}

$root = Split-Path -Parent $PSScriptRoot
$repos = if ($env:REPOS_DIR) { $env:REPOS_DIR } else { 'E:/repos' }
$buildProfile = if ($Release) { 'release' } else { 'debug' }

# What was set before: the script changes the environment of this process only while it runs.
$envNames = @('TASKS_ENGINE_DIR', 'LIB_NVIM_DIR', 'TASKS_VAULT')
$envBefore = @{}
foreach ($name in $envNames) { $envBefore[$name] = [Environment]::GetEnvironmentVariable($name, 'Process') }

# The engine and its library from the local checkouts, so the hub sees their newest commits
# (engine.lock pins the commit the CI checks out, not the one you run here).
if (-not $env:TASKS_ENGINE_DIR) { $env:TASKS_ENGINE_DIR = "$repos/tasks.nvim" }
if (-not $env:LIB_NVIM_DIR) { $env:LIB_NVIM_DIR = "$repos/lib.nvim" }
if ($Vault) { $env:TASKS_VAULT = $Vault }
elseif (-not $env:TASKS_VAULT) { $env:TASKS_VAULT = "$repos/tasks-vault" }


function Invoke-Step([string]$Label, [scriptblock]$Body) {
  Write-Host "==> $Label" -ForegroundColor Cyan
  & $Body
  if ($LASTEXITCODE -ne 0) { throw "$Label failed (exit code $LASTEXITCODE)" }
}

Push-Location $root
try {
  foreach ($dir in @($env:TASKS_ENGINE_DIR, $env:LIB_NVIM_DIR, $env:TASKS_VAULT)) {
    if (-not (Test-Path -LiteralPath $dir -PathType Container)) { throw "Folder not found: $dir" }
  }

  if (-not $NoBuild) {
    # A node_modules without its .bin shims (an interrupted or foreign install, or a fresh clone) makes
    # `vite` an unknown command: the build then dies with "Der Befehl vite ... nicht gefunden". The
    # lockfile is the truth, so link (and fetch what is missing) from it before building.
    if (-not (Get-ChildItem -LiteralPath 'ui/node_modules/.bin' -Filter 'vite*' -ErrorAction SilentlyContinue)) {
      Invoke-Step 'ui: pnpm install (vite is not linked)' { pnpm --dir ui install --frozen-lockfile }
    }
    Invoke-Step 'ui: pnpm build' { pnpm --dir ui build }
    # Without this the binary keeps the interface it embedded last time.
    (Get-Item -LiteralPath 'crates/tasks-hub/src/ui.rs').LastWriteTime = Get-Date
    $cargoArgs = @('build', '--locked')
    if ($Release) { $cargoArgs += '--release' }
    Invoke-Step "cargo $($cargoArgs -join ' ')" { cargo @cargoArgs }
  }

  $exe = Join-Path $root "target/$buildProfile/tasks-hub.exe"
  if (-not (Test-Path -LiteralPath $exe)) { throw "Not built yet: $exe (run without -NoBuild)" }

  Write-Host "engine: $env:TASKS_ENGINE_DIR"
  Write-Host "vault:  $env:TASKS_VAULT"
  if ($Background) {
    # A hub that runs already (an earlier run, the installed copy) is found and kept: it may be an older build.
    $started = & $exe start --open | Out-String
    if ($LASTEXITCODE -ne 0) { throw "tasks-hub start --open failed (exit code $LASTEXITCODE)" }
    Write-Host $started
    if ($started -match 'already running') {
        Write-Warning "A hub was already running, so this is not necessarily the build above. Stop it with: & '$exe' stop, then run this again."
    }
    Write-Host "Running in the background. Stop it with: & '$exe' stop"
  }
  else {
    Write-Host 'Running until Ctrl-C; the pairing link is printed below (or: tasks-hub open in a second terminal).'
    & $exe serve
  }
}
finally {
  Pop-Location
  foreach ($name in $envNames) { [Environment]::SetEnvironmentVariable($name, $envBefore[$name], 'Process') }
}
