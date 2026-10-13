<#
.SYNOPSIS
Install tasks-hub for the current user on Windows, without administrator rights.

.DESCRIPTION
Downloads the release archive from GitHub, checks it against SHA256SUMS, and hands over to
`tasks-hub install`, which copies the program to its fixed place (%LOCALAPPDATA%\tasks-desktop\bin,
or $env:TASKS_DESKTOP_INSTALL_DIR) in one step and brings a running hub back from there. Run it
again to repair or to update: an installation that is there is found and replaced, never a second
one beside it.

Run it in your own PowerShell, not elevated and not from inside another program's sandbox (a
packaged app redirects AppData and the registry, and the hub would be installed for that app only).

.PARAMETER Version
The release tag to install (default: the latest published one).

.PARAMETER Repo
Where the releases are (default: StefanBartl/tasks-desktop).

.PARAMETER Archive
A release archive (.zip) you already have: nothing is downloaded. The checksum then comes from
-Sums, -Sha256, or a SHA256SUMS file next to the archive.

.PARAMETER Sums
A SHA256SUMS file ("<hash>  <file>" per line).

.PARAMETER Sha256
The expected SHA-256 of the archive.

.PARAMETER Autostart
Start the hub with your login (the Run key of the current user).

.PARAMETER Shortcut
Put a link "Tasks" on the desktop.

.EXAMPLE
.\install.ps1 -Autostart -Shortcut
#>
[CmdletBinding()]
param(
    [string] $Version = '',
    [string] $Repo = 'StefanBartl/tasks-desktop',
    [string] $Archive = '',
    [string] $Sums = '',
    [string] $Sha256 = '',
    [switch] $Autostart,
    [switch] $Shortcut
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Stop-Install([string] $Message) {
    throw "install.ps1: $Message"
}

# The program belongs to one user: elevated, it would be the administrator account.
$principal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
if ($principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    Stop-Install 'do not run this elevated: it installs for one user, without administrator rights'
}
if ($Repo -notmatch '^[A-Za-z0-9._-]+/[A-Za-z0-9._-]+$') {
    Stop-Install '-Repo must be OWNER/NAME'
}

$work = Join-Path ([IO.Path]::GetTempPath()) ('tasks-desktop-install-' + [Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $work | Out-Null
try {
    if ($Archive -eq '') {
        $cpu = $env:PROCESSOR_ARCHITECTURE
        if ($cpu -ne 'AMD64') {
            Stop-Install "no release for Windows on $cpu"
        }
        $triple = 'x86_64-pc-windows-msvc'
        [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
        if ($Version -eq '') {
            Write-Output "looking for the latest release of $Repo"
            $latest = Invoke-RestMethod -Uri "https://api.github.com/repos/$Repo/releases/latest" -UseBasicParsing
            $Version = [string] $latest.tag_name
            if ($Version -eq '') { Stop-Install 'no published release found (pass -Version TAG)' }
        }
        # A tag is a plain word: it goes into a URL and a file name.
        if ($Version -notmatch '^[A-Za-z0-9._-]+$') {
            Stop-Install "the version has a character that is not allowed: $Version"
        }
        $name = 'tasks-hub-{0}-{1}.zip' -f $Version.TrimStart('v'), $triple
        $base = "https://github.com/$Repo/releases/download/$Version"
        Write-Output "downloading $name"
        Invoke-WebRequest -Uri "$base/$name" -OutFile (Join-Path $work $name) -UseBasicParsing
        Invoke-WebRequest -Uri "$base/SHA256SUMS" -OutFile (Join-Path $work 'SHA256SUMS') -UseBasicParsing
        $Archive = Join-Path $work $name
        $Sums = Join-Path $work 'SHA256SUMS'
    }
    elseif (-not (Test-Path -LiteralPath $Archive -PathType Leaf)) {
        Stop-Install "no such file: $Archive"
    }

    # The checksum: never skipped. A file you have already needs one of the three sources.
    $actual = (Get-FileHash -LiteralPath $Archive -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($Sha256 -eq '') {
        if ($Sums -eq '') {
            $beside = Join-Path (Split-Path -Parent (Resolve-Path -LiteralPath $Archive)) 'SHA256SUMS'
            if (Test-Path -LiteralPath $beside -PathType Leaf) { $Sums = $beside }
        }
        if ($Sums -eq '') { Stop-Install "no checksum for ${Archive}: give -Sums FILE or -Sha256 HEX" }
        if (-not (Test-Path -LiteralPath $Sums -PathType Leaf)) { Stop-Install "no such file: $Sums" }
        $file = Split-Path -Leaf $Archive
        foreach ($line in Get-Content -LiteralPath $Sums) {
            # Lines are "<hash>  <file>"; the file name must match whole.
            if ($line -match '^([0-9A-Fa-f]{64})\s+\*?(.+)$' -and $Matches[2] -eq $file) {
                $Sha256 = $Matches[1]
                break
            }
        }
        if ($Sha256 -eq '') { Stop-Install "$file is not listed in $Sums" }
    }
    $expected = $Sha256.ToLowerInvariant()
    if ($actual -ne $expected) {
        Stop-Install "the checksum of $Archive does not match (expected $expected, got $actual): nothing was installed"
    }
    Write-Output 'checksum ok'

    $unpacked = Join-Path $work 'unpacked'
    Expand-Archive -LiteralPath $Archive -DestinationPath $unpacked
    $program = Join-Path $unpacked 'tasks-hub.exe'
    if (-not (Test-Path -LiteralPath $program -PathType Leaf)) {
        Stop-Install 'the archive holds no tasks-hub.exe'
    }
    $newVersion = (& $program --version)
    if ($LASTEXITCODE -ne 0) { Stop-Install 'the program in the archive does not run' }

    # An installation that is there: told, then replaced in place (repair or update).
    if ($env:TASKS_DESKTOP_INSTALL_DIR) {
        $dir = $env:TASKS_DESKTOP_INSTALL_DIR
    }
    else {
        $dir = Join-Path $env:LOCALAPPDATA 'tasks-desktop\bin'
    }
    $existing = Join-Path $dir 'tasks-hub.exe'
    if (Test-Path -LiteralPath $existing -PathType Leaf) {
        $oldVersion = (& $existing --version 2>$null)
        if ($LASTEXITCODE -ne 0) { $oldVersion = 'unreadable' }
        if ($oldVersion -eq $newVersion) {
            Write-Output "found $oldVersion in ${dir}: repairing it"
        }
        else {
            Write-Output "found $oldVersion in ${dir}: replacing it with $newVersion"
        }
    }

    # `install` copies beside the target, moves over it, and brings a running hub back (it never
    # leaves the hub down); its exit status is ours.
    $flags = @()
    if ($Autostart) { $flags += '--autostart' }
    if ($Shortcut) { $flags += '--shortcut' }
    & $program install @flags
    if ($LASTEXITCODE -ne 0) { Stop-Install 'tasks-hub install failed (see above)' }

    Write-Output ''
    Write-Output "installed $newVersion in $dir"
    Write-Output "start it with: & '$existing' start --open"
}
finally {
    Remove-Item -LiteralPath $work -Recurse -Force -ErrorAction SilentlyContinue
}
