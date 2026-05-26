# maximal Windows installer (B3a).
#
# Self-contained PowerShell installer. Downloads the latest signed
# release zip from GitHub Releases (or a specific tag with -Version),
# verifies SHA-256, unpacks under %LocalAppData%\Programs\maximal,
# adds that directory to the user's PATH, registers an at-logon
# scheduled task that starts the proxy, and runs `maximal setup
# --unattended --skip-auth` for the Claude Desktop config touches.
#
# v1 ships unsigned (A4 deferred per parent PRD). On first launch
# Windows SmartScreen will warn — the Pages site (B4) carries the
# "More info → Run anyway" instructions.
#
# Usage:
#   # Latest:
#   iex (irm https://<internal>/maximal/install.ps1)
#   # Specific version:
#   $env:COPILOT_API_VERSION = 'v0.2.0'; iex (irm ...)
#   # Uninstall path (after install):
#   maximal uninstall
#
# Spec: docs/spec/archive/internal-distribution-stream-b.md §B3a.

#Requires -Version 5.1

[CmdletBinding()]
param(
  [string]$Version = $env:COPILOT_API_VERSION,
  [string]$Repo = $env:COPILOT_API_REPO,
  [switch]$Force
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

if (-not $Repo) {
  # Default to the repo this script ships from. Override with
  # COPILOT_API_REPO=<owner>/<name> when staging from a fork.
  $Repo = 'stuffbucket/maximal'
}

$InstallDir   = Join-Path $env:LOCALAPPDATA 'Programs\maximal'
$BinPath      = Join-Path $InstallDir 'maximal.exe'
$TaskName     = 'maximal'
$DownloadDir  = Join-Path $env:TEMP "maximal-install-$(Get-Random)"

function Resolve-LatestVersion {
  param([string]$Repo)
  $api = "https://api.github.com/repos/$Repo/releases/latest"
  Write-Host "Resolving latest release from $api ..." -ForegroundColor Cyan
  $headers = @{ 'Accept' = 'application/vnd.github+json' }
  if ($env:GITHUB_TOKEN) { $headers['Authorization'] = "Bearer $env:GITHUB_TOKEN" }
  $rel = Invoke-RestMethod -Uri $api -Headers $headers -UseBasicParsing
  return $rel.tag_name
}

function Download-File {
  param([string]$Url, [string]$Dest)
  Write-Host "  ↓ $Url" -ForegroundColor DarkGray
  Invoke-WebRequest -Uri $Url -OutFile $Dest -UseBasicParsing -MaximumRedirection 10
}

function Verify-Sha256 {
  param([string]$File, [string]$ExpectedSha256File)
  # The .sha256 file ships as `<sha>  <filename>` per Stream A's
  # convention (matches `shasum -a 256` output). Parse out the hex.
  $expectedLine = (Get-Content -LiteralPath $ExpectedSha256File -Raw).Trim()
  $expected = ($expectedLine -split '\s+')[0]
  $actual = (Get-FileHash -Algorithm SHA256 -LiteralPath $File).Hash.ToLower()
  if ($expected.ToLower() -ne $actual) {
    throw "SHA-256 mismatch for $File`n  expected: $expected`n  got:      $actual"
  }
  Write-Host "  ✓ SHA-256 verified" -ForegroundColor Green
}

function Add-UserPath {
  param([string]$Dir)
  $current = [Environment]::GetEnvironmentVariable('PATH', 'User')
  if ($null -eq $current) { $current = '' }
  $segments = $current -split ';' | Where-Object { $_ -ne '' }
  if ($segments -notcontains $Dir) {
    $new = ($segments + $Dir) -join ';'
    [Environment]::SetEnvironmentVariable('PATH', $new, 'User')
    Write-Host "  ✓ Added $Dir to user PATH" -ForegroundColor Green
  } else {
    Write-Host "  ✓ $Dir already on user PATH" -ForegroundColor DarkGray
  }
  # Make it visible in the current session too.
  $env:Path = "$env:Path;$Dir"
}

function Register-StartupTask {
  param([string]$ExePath, [string]$TaskName)
  # Re-register idempotently so re-runs of the installer pick up a
  # new binary path or argument set without leaving the old task in
  # place.
  if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) {
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
  }
  $action   = New-ScheduledTaskAction -Execute $ExePath -Argument 'start'
  $trigger  = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
  $settings = New-ScheduledTaskSettingsSet `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries `
    -StartWhenAvailable `
    -ExecutionTimeLimit ([TimeSpan]::Zero) # no kill timeout
  Register-ScheduledTask `
    -TaskName $TaskName `
    -Action $action `
    -Trigger $trigger `
    -Settings $settings `
    -Description 'Run maximal at user logon' `
    | Out-Null
  Write-Host "  ✓ Registered scheduled task '$TaskName' (triggers at logon)" -ForegroundColor Green
}

# ─────────────────────────────────────────────────────────────────────
# Main flow
# ─────────────────────────────────────────────────────────────────────

if (-not $Version) { $Version = Resolve-LatestVersion -Repo $Repo }
if (-not $Version.StartsWith('v')) { $Version = "v$Version" }

Write-Host "Installing maximal $Version from $Repo" -ForegroundColor Cyan

if ((Test-Path $BinPath) -and -not $Force) {
  Write-Host "  Note: existing install at $BinPath will be overwritten." -ForegroundColor Yellow
}

# 1. Download zip + sha256 ───────────────────────────────────────────
New-Item -ItemType Directory -Force -Path $DownloadDir | Out-Null
$zipName = "maximal-$Version-windows-x64.zip"
$shaName = "$zipName.sha256"
$zipUrl  = "https://github.com/$Repo/releases/download/$Version/$zipName"
$shaUrl  = "https://github.com/$Repo/releases/download/$Version/$shaName"
$zipPath = Join-Path $DownloadDir $zipName
$shaPath = Join-Path $DownloadDir $shaName

Write-Host 'Downloading...' -ForegroundColor Cyan
Download-File -Url $zipUrl -Dest $zipPath
Download-File -Url $shaUrl -Dest $shaPath
Verify-Sha256 -File $zipPath -ExpectedSha256File $shaPath

# 2. Stop any running scheduled task before replacing the binary ─────
if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) {
  Write-Host 'Stopping existing scheduled task ...' -ForegroundColor Cyan
  Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
}
# Best-effort process termination if a previous run is still up.
Get-Process -Name 'maximal' -ErrorAction SilentlyContinue | ForEach-Object {
  $_ | Stop-Process -Force -ErrorAction SilentlyContinue
}

# 3. Unpack to install dir ──────────────────────────────────────────
Write-Host "Unpacking to $InstallDir ..." -ForegroundColor Cyan
New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null
Expand-Archive -Path $zipPath -DestinationPath $InstallDir -Force

if (-not (Test-Path $BinPath)) {
  throw "Install failed: $BinPath not present after unpack"
}
Write-Host "  ✓ Installed $BinPath" -ForegroundColor Green

# 4. PATH + scheduled task ──────────────────────────────────────────
Add-UserPath -Dir $InstallDir
Register-StartupTask -ExePath $BinPath -TaskName $TaskName

# 5. Start it now (so the user doesn't have to log out/in) ──────────
Start-ScheduledTask -TaskName $TaskName

# 6. Setup wizard in unattended mode ────────────────────────────────
Write-Host 'Running first-run setup ...' -ForegroundColor Cyan
& $BinPath setup --unattended --skip-auth
if ($LASTEXITCODE -ne 0) {
  Write-Host "  Setup returned non-zero ($LASTEXITCODE); continuing anyway." -ForegroundColor Yellow
}

# 7. Cleanup tempdir ────────────────────────────────────────────────
Remove-Item -LiteralPath $DownloadDir -Recurse -Force -ErrorAction SilentlyContinue

Write-Host ''
Write-Host 'Install complete.' -ForegroundColor Green
Write-Host '  Run `maximal setup` once from a NEW PowerShell window'
Write-Host '  to authenticate with GitHub (the device-code flow needs an'
Write-Host '  interactive shell, which this installer does not provide).'
Write-Host '  PATH is updated for the next shell; current shell already'
Write-Host '  has the install dir prepended.'
