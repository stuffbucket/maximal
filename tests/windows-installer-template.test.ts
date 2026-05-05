/**
 * PR-time smoke test for the Windows PowerShell installer (B3a).
 *
 * Doesn't run the script — that needs Windows + a real release. This
 * just guards against drift between install.ps1 and the artifact-name
 * convention Stream A produces, plus the contract points the Pages
 * site (B4) and the setup wizard depend on:
 *
 *   - the script downloads `maximal-<TAG>-windows-x64.zip` (Stream
 *     A's canonical name) and a sidecar `.sha256`
 *   - it verifies the SHA before unpacking
 *   - it installs under %LocalAppData%\Programs\maximal
 *   - it invokes `maximal setup --unattended --skip-auth` so the
 *     installer hook from src/setup.ts fires
 *   - the at-logon scheduled task is named `maximal`
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

  it("downloads the canonical Stream A artifact name", () => {
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

  it(String.raw`installs under %LocalAppData%\Programs\maximal`, () => {
    const ps = read(SCRIPT)
    expect(ps).toContain("$env:LOCALAPPDATA")
    expect(ps).toContain(String.raw`Programs\maximal`)
  })

  it("registers an at-logon scheduled task named maximal", () => {
    const ps = read(SCRIPT)
    expect(ps).toContain("$TaskName     = 'maximal'")
    expect(ps).toContain("New-ScheduledTaskTrigger -AtLogOn")
    expect(ps).toContain("Register-ScheduledTask")
  })

  it("invokes setup --unattended --skip-auth", () => {
    const ps = read(SCRIPT)
    expect(ps).toContain("setup --unattended --skip-auth")
  })

  it("adds the install dir to user PATH", () => {
    const ps = read(SCRIPT)
    expect(ps).toMatch(/SetEnvironmentVariable\(\s*'PATH'.*'User'/s)
  })
})
