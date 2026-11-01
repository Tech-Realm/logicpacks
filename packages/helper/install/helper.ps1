# LogicPacks helper installer for Windows: irm https://logicpacks.io/helper.ps1 | iex
# Optional: $env:LP_SERVER (and $env:LP_TOKEN) to sign in during install, $env:LP_HELPER_URL to
# install from another copy, $env:LP_HELPER_SHA256 to pin it, $env:LP_HELPER_NO_WATCHER = 1 /
# $env:LP_HELPER_NO_HOOKS = 1 to skip parts of `lp install`, which runs only with $env:LP_HELPER_INSTALL = 1.
# By default this only puts the lp command in place: it changes no agent's settings.
# Runs inside the caller's PowerShell (iex), so it throws instead of calling exit.
$ErrorActionPreference = 'Stop'

function Fail($message) { throw "LogicPacks helper: $message" }

$HelperHome = if ($env:LP_HELPER_HOME) { $env:LP_HELPER_HOME } else { Join-Path $env:USERPROFILE '.logicpacks\helper' }
$Source = if ($env:LP_HELPER_URL) { $env:LP_HELPER_URL } else { 'https://logicpacks.io/helper/lp.mjs' }
$BinDir = Join-Path $HelperHome 'bin'

$NodeCommand = Get-Command node -ErrorAction SilentlyContinue
if (-not $NodeCommand) {
  Fail 'Node.js 18 or newer is needed. Install the LTS from https://nodejs.org (or: winget install OpenJS.NodeJS.LTS), open a new PowerShell and run this again.'
}
$Node = $NodeCommand.Source
# No double quotes in native arguments: Windows PowerShell 5.1 strips them.
$NodeMajor = [int](& $Node -p 'parseInt(process.versions.node)')
if ($NodeMajor -lt 18) { Fail "Node.js 18 or newer is needed; found $(& $Node -v)." }

New-Item -ItemType Directory -Force -Path $BinDir | Out-Null
$Tmp = Join-Path ([System.IO.Path]::GetTempPath()) ("lp-helper-" + [guid]::NewGuid().ToString('N') + '.mjs')
try {
  if ($Source -match '^https?://') {
    [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
    Invoke-WebRequest -UseBasicParsing -Uri $Source -OutFile $Tmp
  } else {
    Copy-Item -LiteralPath ($Source -replace '^file:///?', '') -Destination $Tmp
  }
  if ($env:LP_HELPER_SHA256) {
    $actual = (Get-FileHash -Algorithm SHA256 -LiteralPath $Tmp).Hash.ToLower()
    if ($actual -ne $env:LP_HELPER_SHA256.ToLower()) { Fail "checksum mismatch for $Source" }
  }
  & $Node --check $Tmp 2>$null
  if ($LASTEXITCODE -ne 0) { Fail "$Source is not a valid helper script" }
  Move-Item -Force -LiteralPath $Tmp -Destination (Join-Path $HelperHome 'lp.mjs')
} finally {
  if (Test-Path -LiteralPath $Tmp) { Remove-Item -Force -LiteralPath $Tmp }
}

$Script = Join-Path $HelperHome 'lp.mjs'
# lp.cmd for PowerShell and cmd; an sh wrapper named lp for Git Bash, which Claude Code uses for
# its shell and hooks on Windows. Both quote their paths, so spaces in the profile path work.
$Ascii = New-Object System.Text.UTF8Encoding($false)
[System.IO.File]::WriteAllText((Join-Path $BinDir 'lp.cmd'), "@echo off`r`n`"$Node`" `"$Script`" %*`r`n", $Ascii)
$PosixNode = $Node -replace '\\', '/'
$PosixScript = $Script -replace '\\', '/'
[System.IO.File]::WriteAllText((Join-Path $BinDir 'lp'), "#!/bin/sh`nexec `"$PosixNode`" `"$PosixScript`" `"`$@`"`n", $Ascii)

# Put the bin folder on the user's PATH (new shells) and this session's PATH.
$UserPath = [Environment]::GetEnvironmentVariable('Path', 'User')
if (-not (($UserPath -split ';') -contains $BinDir)) {
  $NewPath = if ([string]::IsNullOrEmpty($UserPath)) { $BinDir } else { "$UserPath;$BinDir" }
  [Environment]::SetEnvironmentVariable('Path', $NewPath, 'User')
}
if (-not (($env:Path -split ';') -contains $BinDir)) { $env:Path = "$env:Path;$BinDir" }

$Lp = Join-Path $BinDir 'lp.cmd'
if ($env:LP_HELPER_INSTALL) {
  $InstallArgs = @('install', '--yes')
  if ($env:LP_HELPER_NO_HOOKS) { $InstallArgs += '--no-hooks' }
  if ($env:LP_HELPER_NO_WATCHER) { $InstallArgs += '--no-watcher' }
  & $Lp @InstallArgs
}
Write-Host "Installed $Lp (the lp command) in $HelperHome. No agent settings were changed (the bin folder was added to your user PATH)."

if ($env:LP_SERVER) {
  $LoginArgs = @('login', '--host', $env:LP_SERVER)
  if ($env:LP_TOKEN) { $LoginArgs += @('--token', $env:LP_TOKEN) }
  & $Lp @LoginArgs
} else {
  Write-Host ''
  Write-Host 'Next: lp.cmd login'
}
# Windows PowerShell 5.1 has a built-in alias lp (Out-Printer) that wins over lp.cmd: drop it in
# this session; in new PowerShell windows type lp.cmd (cmd, Git Bash and PowerShell 7 take lp).
if (Test-Path Alias:lp) {
  Remove-Item Alias:lp -Force -ErrorAction SilentlyContinue
  Write-Host 'In Windows PowerShell, type lp.cmd: lp is a built-in alias for Out-Printer there.'
}
Write-Host "LogicPacks helper installed in $HelperHome. Run lp.cmd status to check it."
