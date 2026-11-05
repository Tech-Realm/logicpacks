# Puts the lp helper that ships inside the LogicPacks Windows app on the user's PATH.
# The NSIS installer (apps/desktop/resources/installer.nsh) runs it as the installing user after
# every install or upgrade; it needs no admin rights and no Node.
#   powershell -NoProfile -ExecutionPolicy Bypass -File install-lp.ps1 [-Source <lp.exe>]
# It copies lp.exe to %USERPROFILE%\.logicpacks\helper\bin (the same place helper.ps1 uses), writes
# lp.cmd (cmd, PowerShell) and lp (Git Bash) next to it, adds that folder to the user PATH, and
# re-points a watcher or MCP server that an older lp already installed. It changes no agent settings.
param([string]$Source = (Join-Path $PSScriptRoot 'lp.exe'), [switch]$RemovePath)
$ErrorActionPreference = 'Stop'

$HelperHome = if ($env:LP_HELPER_HOME) { $env:LP_HELPER_HOME } else { Join-Path $env:USERPROFILE '.logicpacks\helper' }
$BinDir = Join-Path $HelperHome 'bin'
$Target = Join-Path $BinDir 'lp.exe'
if ($RemovePath) {
  # Uninstall: take the helper folder off the user PATH (no stray separators left behind).
  $Kept = ([Environment]::GetEnvironmentVariable('Path', 'User') -split ';') | Where-Object { $_ -and $_ -ne $BinDir }
  [Environment]::SetEnvironmentVariable('Path', ($Kept -join ';'), 'User')
  exit 0
}
New-Item -ItemType Directory -Force -Path $BinDir | Out-Null

# A running watcher holds lp.exe open: stop it (the refresh below starts it again).
Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |
  Where-Object { ($_.Name -eq 'lp.exe' -and $_.CommandLine -like '* watch*') -or ($_.Name -eq 'node.exe' -and $_.CommandLine -like '*lp.mjs*watch*') } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }

if (Test-Path -LiteralPath $Target) {
  # Another lp.exe (an MCP server, say) may still run: Windows lets a running exe be renamed.
  try { Remove-Item -Force -LiteralPath $Target } catch {
    Rename-Item -Force -LiteralPath $Target -NewName ('lp.exe.old-' + [guid]::NewGuid().ToString('N'))
  }
}
Copy-Item -Force -LiteralPath $Source -Destination $Target
Get-ChildItem -LiteralPath $BinDir -Filter 'lp.exe.old-*' -ErrorAction SilentlyContinue |
  Remove-Item -Force -ErrorAction SilentlyContinue

$Ascii = New-Object System.Text.UTF8Encoding($false)
[System.IO.File]::WriteAllText((Join-Path $BinDir 'lp.cmd'), "@echo off`r`n`"%~dp0lp.exe`" %*`r`n", $Ascii)
$PosixTarget = $Target -replace '\\', '/'
[System.IO.File]::WriteAllText((Join-Path $BinDir 'lp'), "#!/bin/sh`nexec `"$PosixTarget`" `"`$@`"`n", $Ascii)

$UserPath = [Environment]::GetEnvironmentVariable('Path', 'User')
if (-not (($UserPath -split ';') -contains $BinDir)) {
  $NewPath = (@($UserPath -split ';' | Where-Object { $_ }) + $BinDir) -join ';'
  [Environment]::SetEnvironmentVariable('Path', $NewPath, 'User')
}

& $Target install --refresh --yes | Out-Null
# The older helper was a Node script; the watcher and MCP entries now start lp.exe instead.
$OldScript = Join-Path $HelperHome 'lp.mjs'
if (Test-Path -LiteralPath $OldScript) { Remove-Item -Force -LiteralPath $OldScript -ErrorAction SilentlyContinue }
exit 0
