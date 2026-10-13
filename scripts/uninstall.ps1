<#
.SYNOPSIS
Remove tasks-hub for the current user on Windows, without administrator rights.

.DESCRIPTION
Asks the installed program to take its place in the system away (`tasks-hub uninstall`: stop the
hub, the login entry, the link on the desktop), then removes the program file from the install
folder (%LOCALAPPDATA%\tasks-desktop\bin, or $env:TASKS_DESKTOP_INSTALL_DIR). Your settings stay
unless you ask: -PurgeSettings removes the files of the app in the settings folder. The vault and
your tasks are never touched. A second run finds nothing to do and says so; it is not an error.

If taking the system entries away fails, the program is NOT removed (a login entry that points at
a missing program is worse than a program that is still there): read the message and run it again.

.PARAMETER PurgeSettings
Also remove the settings of the app (%APPDATA%\tasks-desktop, only the files the app makes).

.EXAMPLE
.\uninstall.ps1 -PurgeSettings
#>
[CmdletBinding()]
param(
    [switch] $PurgeSettings
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Stop-Uninstall([string] $Message) {
    throw "uninstall.ps1: $Message"
}

$principal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
if ($principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    Stop-Uninstall 'do not run this elevated: it removes the installation of one user'
}

if ($env:TASKS_DESKTOP_INSTALL_DIR) {
    $dir = $env:TASKS_DESKTOP_INSTALL_DIR
}
else {
    $dir = Join-Path $env:LOCALAPPDATA 'tasks-desktop\bin'
}
$program = Join-Path $dir 'tasks-hub.exe'
if (-not (Test-Path -LiteralPath $program -PathType Leaf)) {
    Write-Output "nothing to remove: no tasks-hub.exe in $dir"
    return
}

$flags = @()
if ($PurgeSettings) { $flags += '--purge-settings' }
& $program uninstall @flags
if ($LASTEXITCODE -ne 0) {
    Stop-Uninstall "tasks-hub uninstall failed (see above): the program stays in $dir"
}

# Only the files the installer puts there; a folder that holds anything else stays.
foreach ($name in 'tasks-hub.exe', 'tasks-hub.exe.new') {
    Remove-Item -LiteralPath (Join-Path $dir $name) -Force -ErrorAction SilentlyContinue
}
if (-not (Get-ChildItem -LiteralPath $dir -Force -ErrorAction SilentlyContinue)) {
    Remove-Item -LiteralPath $dir -Force -ErrorAction SilentlyContinue
    # The parent only when it is the folder the installer makes (never a folder you chose).
    $parent = Split-Path -Parent $dir
    if ((Split-Path -Leaf $dir) -eq 'bin' -and (Split-Path -Leaf $parent) -eq 'tasks-desktop') {
        if (-not (Get-ChildItem -LiteralPath $parent -Force -ErrorAction SilentlyContinue)) {
            Remove-Item -LiteralPath $parent -Force -ErrorAction SilentlyContinue
        }
    }
}

Write-Output ''
Write-Output "removed $program"
if (-not $PurgeSettings) {
    Write-Output 'your settings were kept (-PurgeSettings removes them); your vault was not touched'
}
