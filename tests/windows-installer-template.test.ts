/**
 * PR-time smoke test for the Windows PowerShell installer.
 *
 * Doesn't run the script — that needs Windows + a real release. This
 * just guards against drift between install.ps1 and the artifact-name
 * convention produced by the release workflow, plus the contract points the
 * Pages site and setup wizard depend on:
 *
 *   - the script downloads `maximal-<TAG>-windows-x64.zip` and a sidecar
 *     `.sha256`
 *   - it verifies the SHA before unpacking
 *   - it installs both sibling executables under
 *     %LocalAppData%\Programs\maximal
 *   - it adds that directory to the user PATH and registers the product
 *   - its ARP helper removes both binaries, PATH, ARP, and itself after the
 *     running CLI exits
 *   - it does not own startup or first-run setup
 */

import { describe, expect, it } from "bun:test"
import fs from "node:fs"
import path from "node:path"

const ROOT = path.resolve(import.meta.dir, "..")
const SCRIPT = path.join(ROOT, "build/windows/install.ps1")

function read(p: string): string {
  return fs.readFileSync(p, "utf8")
}

describe("windows installer template", () => {
  it("install.ps1 exists", () => {
    expect(fs.existsSync(SCRIPT)).toBe(true)
  })

  it("declares PS 5.1 and strict mode", () => {
    const ps = read(SCRIPT)
    expect(ps).toContain("#Requires -Version 5.1")
    expect(ps).toContain("Set-StrictMode -Version Latest")
    expect(ps).toContain("$ErrorActionPreference = 'Stop'")
  })

  it("downloads the canonical release artifact name", () => {
    const ps = read(SCRIPT)
    expect(ps).toContain("maximal-$Version-windows-x64.zip")
    expect(ps).toContain("$zipName.sha256")
  })

  it("verifies SHA-256 before unpacking", () => {
    const ps = read(SCRIPT)
    const verifyIdx = ps.indexOf("Verify-Sha256")
    const expandIdx = ps.indexOf("Expand-Archive")
    expect(verifyIdx).toBeGreaterThan(-1)
    expect(expandIdx).toBeGreaterThan(-1)
    expect(verifyIdx).toBeLessThan(expandIdx)
  })

  it(
    String.raw`installs both binaries under %LocalAppData%\Programs\maximal`,
    () => {
      const ps = read(SCRIPT)
      expect(ps).toContain("$env:LOCALAPPDATA")
      expect(ps).toContain(String.raw`Programs\maximal`)
      expect(ps).toContain("$BinPath")
      expect(ps).toContain("$BrokerPath")
      expect(ps).toContain("maximal-mcp-broker.exe")
      expect(ps).toContain("foreach ($binaryPath in @($BinPath, $BrokerPath))")
    },
  )

  it("stops both executable images before replacing files", () => {
    const ps = read(SCRIPT)
    expect(ps).toContain("Get-Process -Name 'maximal', 'maximal-mcp-broker'")
  })

  it("adds the install dir to user PATH", () => {
    const ps = read(SCRIPT)
    expect(ps).toMatch(/SetEnvironmentVariable\(\s*'PATH'.*'User'/s)
  })

  // Without @(), a one-entry PATH splits to a string and `$segments + $Dir`
  // concatenates: "...\WindowsAppsC:\Users\...\Programs\maximal".
  it("splits PATH into an array before appending", () => {
    const ps = read(SCRIPT)
    expect(ps).toContain(
      "$segments = @($current -split ';' | Where-Object { $_ -ne '' })",
    )
  })

  it("registers an Add/Remove Programs entry", () => {
    const ps = read(SCRIPT)
    expect(ps).toContain("Register-ArpEntry")
    expect(ps).toContain(String.raw`CurrentVersion\Uninstall\maximal`)
    expect(ps).toContain("$UninstallerPath")
    expect(ps).toContain("powershell.exe -NoProfile -ExecutionPolicy Bypass")
  })

  it("installs an ownership-scoped self-removing uninstaller", () => {
    const ps = read(SCRIPT)
    expect(ps).toContain("function Write-Uninstaller")
    expect(ps).toContain("& $BinPath uninstall --force --unattended")
    expect(ps).toContain("Get-Process -Name 'maximal', 'maximal-mcp-broker'")
    expect(ps).toContain(
      "[Environment]::SetEnvironmentVariable('PATH', $newPath, 'User')",
    )
    expect(ps).toContain("Remove-Item -LiteralPath $ArpKey -Recurse -Force")
    expect(ps).toContain("foreach ($file in @($BrokerPath, $BinPath))")
    expect(ps).toContain("Remove-Item -LiteralPath $selfPath -Force")
  })

  it("does not delete MSI-owned binaries", () => {
    const ps = read(SCRIPT)
    expect(ps).toContain("$MsiMarkerKey")
    expect(ps).toContain("An MSI-managed maximal installation already owns")
    expect(ps).toContain("if ($msiOwned)")
    expect(ps).toContain("msiexec must own the binaries")
  })

  // CLI-only: the tray app (NSIS installer) owns running the proxy,
  // auto-start, and first-run setup. The CLI installer must NOT register a
  // scheduled task, run setup, or drop a Start Menu shortcut.
  it("does NOT register a scheduled task, run setup, or make a shortcut", () => {
    const ps = read(SCRIPT)
    expect(ps).not.toContain("Register-ScheduledTask")
    expect(ps).not.toContain("New-ScheduledTaskTrigger")
    expect(ps).not.toContain("setup --unattended")
    expect(ps).not.toContain("CreateShortcut")
  })
})
