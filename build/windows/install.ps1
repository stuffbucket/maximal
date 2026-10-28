# maximal Windows installer.
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
# macOS menu-bar app. This installer puts the `maximal` CLI and its isolated
# broker sibling on PATH.
#
# Windows Authenticode signing remains deferred. On first launch,
# Windows SmartScreen will warn; the Pages site carries the
# "More info → Run anyway" instructions.
#
# Usage:
#   # Latest:
#   iex (irm https://<internal>/maximal/install.ps1)
#   # Specific version:
#   $env:COPILOT_API_VERSION = 'v0.2.0'; iex (irm ...)
#   # Uninstall path (after install):
#   # Apps & features, or directly:
#   maximal uninstall

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

$InstallDir      = Join-Path $env:LOCALAPPDATA 'Programs\maximal'
$BinPath         = Join-Path $InstallDir 'maximal.exe'
$BrokerPath      = Join-Path $InstallDir 'maximal-mcp-broker.exe'
$UninstallerPath = Join-Path $InstallDir 'uninstall.ps1'
$DownloadDir     = Join-Path $env:TEMP "maximal-install-$(Get-Random)"
# The PowerShell installer owns this named ARP key. The MSI uses Windows
# Installer product registration and is detected separately through its marker.
$ArpKey       = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\maximal'
$MsiMarkerKey = 'HKCU:\Software\stuffbucket\maximal'

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
  # The .sha256 file ships as `<sha>  <filename>` with the release archive's
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
  # @() keeps this an array. With a single PATH entry (Windows' default user
  # PATH) the pipeline returns a plain string, and `+ $Dir` below would glue
  # the two together with no separator.
  $segments = @($current -split ';' | Where-Object { $_ -ne '' })
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

function Write-Uninstaller {
  param([string]$Path)
  # The installed helper owns only artifacts created by this PowerShell
  # installer. `maximal uninstall` first reverts application integrations and
  # stops the isolated broker; after that process exits, the helper can remove
  # the formerly-running executable, its own file, the user PATH entry, and the
  # PowerShell installer's ARP key. MSI installs continue to be owned by
  # msiexec and never use this helper.
  $script = @'
#Requires -Version 5.1

$ErrorActionPreference = 'Continue'
Set-StrictMode -Version Latest

$InstallDir = Split-Path -Parent $PSCommandPath
$BinPath = Join-Path $InstallDir 'maximal.exe'
$BrokerPath = Join-Path $InstallDir 'maximal-mcp-broker.exe'
$ArpKey = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\maximal'
$MsiMarkerKey = 'HKCU:\Software\stuffbucket\maximal'
$exitCode = 0

# If an MSI was installed after this PowerShell package, its Windows Installer
# registration owns the shared binary directory and PATH entry. Remove only
# the obsolete PowerShell-installer metadata; msiexec must own the binaries.
$msiOwned = (Get-ItemPropertyValue $MsiMarkerKey 'installed' -ErrorAction SilentlyContinue) -eq 1
if ($msiOwned) {
  Remove-Item -LiteralPath $ArpKey -Recurse -Force -ErrorAction SilentlyContinue
  Remove-Item -LiteralPath $PSCommandPath -Force -ErrorAction SilentlyContinue
  exit 0
}

if (Test-Path -LiteralPath $BinPath) {
  & $BinPath uninstall --force --unattended
  if ($LASTEXITCODE -ne 0) { $exitCode = $LASTEXITCODE }
}

# The CLI performs graceful, ownership-aware cleanup first. Terminate any
# remaining manually-started proxy or broker before deleting locked files.
Get-Process -Name 'maximal', 'maximal-mcp-broker' -ErrorAction SilentlyContinue |
  Stop-Process -Force -ErrorAction SilentlyContinue
Start-Sleep -Milliseconds 500

$currentPath = [Environment]::GetEnvironmentVariable('PATH', 'User')
if ($null -eq $currentPath) { $currentPath = '' }
$normalizedInstallDir = $InstallDir.TrimEnd([char[]]'\')
$segments = @($currentPath -split ';' | Where-Object {
  $_ -and $_.Trim().TrimEnd([char[]]'\') -ine $normalizedInstallDir
})
$newPath = $segments -join ';'
if ($newPath -ne $currentPath) {
  [Environment]::SetEnvironmentVariable('PATH', $newPath, 'User')
}

Remove-Item -LiteralPath $ArpKey -Recurse -Force -ErrorAction SilentlyContinue
foreach ($file in @($BrokerPath, $BinPath)) {
  Remove-Item -LiteralPath $file -Force -ErrorAction SilentlyContinue
}

$selfPath = $PSCommandPath
Remove-Item -LiteralPath $selfPath -Force -ErrorAction SilentlyContinue
Remove-Item -LiteralPath $InstallDir -Force -ErrorAction SilentlyContinue
exit $exitCode
'@
  Set-Content -LiteralPath $Path -Value $script -Encoding UTF8
  Write-Host "  ✓ Installed uninstaller $Path" -ForegroundColor Green
}

function Register-ArpEntry {
  param(
    [string]$InstallDir,
    [string]$ExePath,
    [string]$UninstallerPath,
    [string]$Version,
    [string]$ArpKey
  )
  # Add/Remove Programs entry so `maximal` shows up in
  # "Apps & features" and uninstall is discoverable — parity with the MSI's
  # ARP row. The helper waits for `maximal uninstall` before deleting the
  # running CLI itself and the remaining installer-owned state.
  $ver = $Version.TrimStart('v')
  $uninstall = "powershell.exe -NoProfile -ExecutionPolicy Bypass -File `"$UninstallerPath`""
  New-Item -Path $ArpKey -Force | Out-Null
  Set-ItemProperty -Path $ArpKey -Name 'DisplayName'     -Value 'maximal'
  Set-ItemProperty -Path $ArpKey -Name 'DisplayVersion'  -Value $ver
  Set-ItemProperty -Path $ArpKey -Name 'Publisher'       -Value 'stuffbucket'
  Set-ItemProperty -Path $ArpKey -Name 'InstallLocation' -Value $InstallDir
  Set-ItemProperty -Path $ArpKey -Name 'DisplayIcon'     -Value $ExePath
  Set-ItemProperty -Path $ArpKey -Name 'UninstallString' -Value $uninstall
  Set-ItemProperty -Path $ArpKey -Name 'QuietUninstallString' -Value $uninstall
  Set-ItemProperty -Path $ArpKey -Name 'NoModify' -Value 1 -Type DWord
  Set-ItemProperty -Path $ArpKey -Name 'NoRepair' -Value 1 -Type DWord
  Write-Host "  ✓ Registered Add/Remove Programs entry" -ForegroundColor Green
}

# ─────────────────────────────────────────────────────────────────────
# Main flow
# ─────────────────────────────────────────────────────────────────────

if ((Get-ItemPropertyValue $MsiMarkerKey 'installed' -ErrorAction SilentlyContinue) -eq 1) {
  throw 'An MSI-managed maximal installation already owns this directory. Uninstall or upgrade it with Windows Installer.'
}

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
#    file locks release before we overwrite either executable.
Get-Process -Name 'maximal', 'maximal-mcp-broker' -ErrorAction SilentlyContinue |
  ForEach-Object {
    $_ | Stop-Process -Force -ErrorAction SilentlyContinue
  }

# 3. Unpack to install dir ──────────────────────────────────────────
Write-Host "Unpacking to $InstallDir ..." -ForegroundColor Cyan
New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null
Expand-Archive -Path $zipPath -DestinationPath $InstallDir -Force

foreach ($binaryPath in @($BinPath, $BrokerPath)) {
  if (-not (Test-Path $binaryPath)) {
    throw "Install failed: $binaryPath not present after unpack"
  }
  Write-Host "  ✓ Installed $binaryPath" -ForegroundColor Green
}

# 4. PATH + dedicated PowerShell uninstaller + Add/Remove Programs entry
Add-UserPath -Dir $InstallDir
Write-Uninstaller -Path $UninstallerPath
Register-ArpEntry `
  -InstallDir $InstallDir `
  -ExePath $BinPath `
  -UninstallerPath $UninstallerPath `
  -Version $Version `
  -ArpKey $ArpKey

# 5. Cleanup tempdir ────────────────────────────────────────────────
Remove-Item -LiteralPath $DownloadDir -Recurse -Force -ErrorAction SilentlyContinue

Write-Host ''
Write-Host 'Install complete.' -ForegroundColor Green
Write-Host '  `maximal` is on your PATH (open a NEW shell to pick it up).'
Write-Host '  For the menu-bar/tray app + guided setup, install the Windows'
Write-Host '  app (maximal-<version>-windows-x64-setup.exe). To use just the'
Write-Host '  CLI, run `maximal setup` to authenticate with GitHub.'
