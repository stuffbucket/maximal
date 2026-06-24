# maximal Windows installer (B3a).
#
# Self-contained PowerShell installer for the maximal CLI. Downloads the
# release zip from GitHub Releases (or a specific tag with -Version),
# verifies SHA-256, unpacks under %LocalAppData%\Programs\maximal, adds
# that directory to the user's PATH, and registers an Add/Remove Programs
# entry.
#
# CLI-ONLY: it does NOT register a scheduled task, run `maximal setup`, or
# create a Start Menu shortcut. The Tauri tray app (the NSIS installer,
# maximal-<ver>-windows-x64-setup.exe) is the canonical Windows experience
# and owns running the proxy, auto-start, and first-run setup — like the
# macOS menu-bar app. This installer just puts `maximal` on PATH.
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
  # Override the download origin. When set, the zip + sha256 are fetched
  # from "<BaseUrl>/<zipName>" instead of the GitHub Releases URL. Lets
  # the dev harness (.github/workflows/windows-installer-dev.yml) point
  # the installer at a locally-served, un-released build. Empty = the
  # normal GitHub Releases path (unchanged behavior).
  [string]$BaseUrl = $env:COPILOT_API_BASE_URL,
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
$DownloadDir  = Join-Path $env:TEMP "maximal-install-$(Get-Random)"
# ARP key kept in lock-step with the MSI (build/windows/maximal.wxs) so
# both CLI installers leave an Add/Remove Programs entry.
$ArpKey       = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\maximal'

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

function Register-ArpEntry {
  param([string]$InstallDir, [string]$ExePath, [string]$Version, [string]$ArpKey)
  # Add/Remove Programs entry so `maximal` shows up in
  # "Apps & features" and uninstall is discoverable — parity with the
  # MSI's ARP row. UninstallString points at `maximal uninstall`, the
  # CLI's own teardown (removes PATH + task + files).
  $ver = $Version.TrimStart('v')
  New-Item -Path $ArpKey -Force | Out-Null
  Set-ItemProperty -Path $ArpKey -Name 'DisplayName'     -Value 'maximal'
  Set-ItemProperty -Path $ArpKey -Name 'DisplayVersion'  -Value $ver
  Set-ItemProperty -Path $ArpKey -Name 'Publisher'       -Value 'stuffbucket'
  Set-ItemProperty -Path $ArpKey -Name 'InstallLocation' -Value $InstallDir
  Set-ItemProperty -Path $ArpKey -Name 'DisplayIcon'     -Value $ExePath
  Set-ItemProperty -Path $ArpKey -Name 'UninstallString' -Value "`"$ExePath`" uninstall"
  Set-ItemProperty -Path $ArpKey -Name 'NoModify' -Value 1 -Type DWord
  Set-ItemProperty -Path $ArpKey -Name 'NoRepair' -Value 1 -Type DWord
  Write-Host "  ✓ Registered Add/Remove Programs entry" -ForegroundColor Green
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
if ($BaseUrl) {
  $origin = $BaseUrl.TrimEnd('/')
  $zipUrl = "$origin/$zipName"
  $shaUrl = "$origin/$shaName"
} else {
  $zipUrl = "https://github.com/$Repo/releases/download/$Version/$zipName"
  $shaUrl = "https://github.com/$Repo/releases/download/$Version/$shaName"
}
$zipPath = Join-Path $DownloadDir $zipName
$shaPath = Join-Path $DownloadDir $shaName

Write-Host 'Downloading...' -ForegroundColor Cyan
Download-File -Url $zipUrl -Dest $zipPath
Download-File -Url $shaUrl -Dest $shaPath
Verify-Sha256 -File $zipPath -ExpectedSha256File $shaPath

# 2. Best-effort process termination if a previous copy is still up, so
#    the file lock releases before we overwrite the binary.
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

# 4. PATH + Add/Remove Programs entry ───────────────────────────────
Add-UserPath -Dir $InstallDir
Register-ArpEntry -InstallDir $InstallDir -ExePath $BinPath -Version $Version -ArpKey $ArpKey

# 5. Cleanup tempdir ────────────────────────────────────────────────
Remove-Item -LiteralPath $DownloadDir -Recurse -Force -ErrorAction SilentlyContinue

Write-Host ''
Write-Host 'Install complete.' -ForegroundColor Green
Write-Host '  `maximal` is on your PATH (open a NEW shell to pick it up).'
Write-Host '  For the menu-bar/tray app + guided setup, install the Windows'
Write-Host '  app (maximal-<version>-windows-x64-setup.exe). To use just the'
Write-Host '  CLI, run `maximal setup` to authenticate with GitHub.'
