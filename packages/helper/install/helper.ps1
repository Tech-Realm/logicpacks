# LogicPacks helper installer for Windows: irm https://logicpacks.io/helper.ps1 | iex
# Installs lp.exe, one standalone executable (no Node, npm or anything else needed), in
# %USERPROFILE%\.logicpacks\helper\bin and adds that folder to the user PATH. No admin rights.
# It checks the SHA-256 against https://downloads.logicpacks.io/helper/latest.json; re-running it
# upgrades lp in place. Works in Windows PowerShell 5.1 and PowerShell 7.
# Optional: $env:LP_SERVER (and $env:LP_TOKEN) to sign in during install, $env:LP_HELPER_URL to
# install from another copy ($env:LP_HELPER_SHA256 to pin it), $env:LP_HELPER_NO_WATCHER = 1 /
# $env:LP_HELPER_NO_HOOKS = 1 to skip parts of `lp install`, which runs only with $env:LP_HELPER_INSTALL = 1.
# By default this only puts the lp command in place: it changes no agent's settings.
# Runs inside the caller's PowerShell (iex), so it throws instead of calling exit.
& {
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

function Fail($message) { throw "LogicPacks helper: $message" }

if (-not [Environment]::Is64BitOperatingSystem) { Fail 'lp needs 64-bit Windows.' }
$HelperHome = if ($env:LP_HELPER_HOME) { $env:LP_HELPER_HOME } else { Join-Path $env:USERPROFILE '.logicpacks\helper' }
$Base = if ($env:LOGICPACKS_DOWNLOADS) { $env:LOGICPACKS_DOWNLOADS } else { 'https://downloads.logicpacks.io' }
$BinDir = Join-Path $HelperHome 'bin'
$Target = Join-Path $BinDir 'lp.exe'
[Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12

if ($env:LP_HELPER_URL) {
  $Source = $env:LP_HELPER_URL
  $Expected = $env:LP_HELPER_SHA256
} else {
  $Manifest = Invoke-RestMethod -UseBasicParsing -Uri "$Base/helper/latest.json"
  $Build = $Manifest.files.'windows-x64'
  if (-not $Build -or -not $Build.url -or -not $Build.sha256) { Fail 'the release manifest has no windows-x64 build.' }
  $Source = $Build.url
  $Expected = $Build.sha256
}

$Tmp = Join-Path ([System.IO.Path]::GetTempPath()) ('lp-' + [guid]::NewGuid().ToString('N') + '.exe')
try {
  if ($Source -match '^https?://') {
    # curl.exe (built into Windows 10 1803 and later) is much faster than Invoke-WebRequest in
    # Windows PowerShell 5.1 and shows progress; its progress on stderr is not a PowerShell error.
    $Curl = Get-Command curl.exe -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($Curl) {
      $ErrorActionPreference = 'Continue'
      & $Curl.Source -fL --retry 3 --progress-bar -o $Tmp $Source
      $ErrorActionPreference = 'Stop'
      if ($LASTEXITCODE -ne 0) { Fail "could not download $Source (curl exit code $LASTEXITCODE)." }
    } else {
      Invoke-WebRequest -UseBasicParsing -Uri $Source -OutFile $Tmp
    }
  } else {
    Copy-Item -LiteralPath ($Source -replace '^file:///?', '') -Destination $Tmp
  }
  if ($Expected) {
    $Actual = (Get-FileHash -Algorithm SHA256 -LiteralPath $Tmp).Hash.ToLower()
    if ($Actual -ne $Expected.ToLower()) { Fail "checksum mismatch for $Source (expected $Expected, got $Actual). Nothing was installed." }
  }
  if (-not ((& $Tmp help 2>$null) -match 'LogicPacks')) { Fail "$Source is not a working lp.exe for this computer." }

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
  Move-Item -Force -LiteralPath $Tmp -Destination $Target
} finally {
  if (Test-Path -LiteralPath $Tmp) { Remove-Item -Force -LiteralPath $Tmp }
}
Get-ChildItem -LiteralPath $BinDir -Filter 'lp.exe.old-*' -ErrorAction SilentlyContinue | Remove-Item -Force -ErrorAction SilentlyContinue

# lp.cmd for cmd; an sh wrapper named lp for Git Bash, which Claude Code uses for its shell and
# hooks on Windows. Both start lp.exe and quote its path, so spaces in the profile path work.
$Ascii = New-Object System.Text.UTF8Encoding($false)
[System.IO.File]::WriteAllText((Join-Path $BinDir 'lp.cmd'), "@echo off`r`n`"%~dp0lp.exe`" %*`r`n", $Ascii)
$PosixTarget = $Target -replace '\\', '/'
[System.IO.File]::WriteAllText((Join-Path $BinDir 'lp'), "#!/bin/sh`nexec `"$PosixTarget`" `"`$@`"`n", $Ascii)

# Put the bin folder on the user's PATH (new shells) and this session's PATH.
$UserPath = [Environment]::GetEnvironmentVariable('Path', 'User')
if (-not (($UserPath -split ';') -contains $BinDir)) {
  $NewPath = if ([string]::IsNullOrEmpty($UserPath)) { $BinDir } else { "$($UserPath.TrimEnd(';'));$BinDir" }
  [Environment]::SetEnvironmentVariable('Path', $NewPath, 'User')
}
if (-not (($env:Path -split ';') -contains $BinDir)) { $env:Path = "$env:Path;$BinDir" }

# Point a watcher or MCP server that an older lp installed at this one (adds nothing new).
& $Target install --refresh --yes | Out-Null
# The older helper was a Node script.
$OldScript = Join-Path $HelperHome 'lp.mjs'
if (Test-Path -LiteralPath $OldScript) { Remove-Item -Force -LiteralPath $OldScript -ErrorAction SilentlyContinue }

if ($env:LP_HELPER_INSTALL) {
  $InstallArgs = @('install', '--yes')
  if ($env:LP_HELPER_NO_HOOKS) { $InstallArgs += '--no-hooks' }
  if ($env:LP_HELPER_NO_WATCHER) { $InstallArgs += '--no-watcher' }
  & $Target @InstallArgs
}
if (-not ((& lp.exe help) -match 'LogicPacks')) { Fail 'lp.exe on the PATH did not start after installing.' }
Write-Host "Installed $Target ($(& $Target version)). No agent settings were changed (the bin folder was added to your user PATH)."

if ($env:LP_SERVER) {
  $LoginArgs = @('login', '--host', $env:LP_SERVER)
  if ($env:LP_TOKEN) { $LoginArgs += @('--token', $env:LP_TOKEN) }
  & $Target @LoginArgs
} else {
  Write-Host ''
  Write-Host 'Next: lp.exe login'
}
if ($PSVersionTable.PSVersion.Major -lt 6) { Write-Host 'In Windows PowerShell, type lp.exe: lp is a built-in alias for Out-Printer there.' }
Write-Host "LogicPacks helper installed. Run lp.exe status to check it."
}
# Windows PowerShell 5.1 has a built-in alias lp (Out-Printer) that wins over lp.exe. iex runs this
# line in your session, so plain lp works here; in new Windows PowerShell windows type lp.exe.
if (Test-Path Alias:lp) { Remove-Item Alias:lp -Force -ErrorAction SilentlyContinue }
