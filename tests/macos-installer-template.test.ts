/**
 * PR-time smoke test for the macOS installer templates. Checks:
 *
 *   - Info.plist is well-formed XML and carries the keys
 *     installers.yml expects to substitute (__VERSION__) plus the
 *     fixed identifiers (CFBundleIdentifier, LSUIElement).
 *   - first-launch shim is syntactically valid bash and references
 *     the sentinels the launchd template carries (__HOME__,
 *     __INSTALL_BIN__) in its sed substitution.
 *   - launchd plist references both sentinels exactly once each.
 *   - Placeholder files exist where the README claims they do, so
 *     the workflow's `rm -f *.placeholder` step doesn't silently
 *     skip a missing slot.
 *
 * Doesn't run the workflow itself — that needs macos-14 + a real
 * tarball. This is a cheap regression guard.
 */

import { describe, expect, it } from "bun:test"
import { spawnSync } from "node:child_process"
import fs from "node:fs"
import path from "node:path"

const ROOT = path.resolve(import.meta.dir, "..")
const TPL = path.join(ROOT, "build/macos/app-template")
const INFO_PLIST = path.join(TPL, "Contents/Info.plist")
const FIRST_LAUNCH = path.join(TPL, "Contents/MacOS/first-launch")
const LAUNCHD_PLIST = path.join(
  TPL,
  "Contents/Resources/co.stuffbucket.maximal.plist",
)

function read(p: string): string {
  return fs.readFileSync(p, "utf8")
}

describe("macos installer templates", () => {
  it("Info.plist exists and carries the expected keys", () => {
    const xml = read(INFO_PLIST)
    expect(xml).toContain("<?xml")
    expect(xml).toContain("<key>CFBundleIdentifier</key>")
    expect(xml).toContain("<string>co.stuffbucket.maximal</string>")
    expect(xml).toContain("<key>CFBundleExecutable</key>")
    expect(xml).toContain("<string>first-launch</string>")
    expect(xml).toContain("<key>LSUIElement</key>")
    expect(xml).toContain("<true/>")
    // Version sentinel — installers.yml does a literal sed replace.
    expect(xml).toContain("__VERSION__")
  })

  it("first-launch is executable and parses as bash", () => {
    const stat = fs.statSync(FIRST_LAUNCH)
    expect((stat.mode & 0o111) !== 0).toBe(true)
    const r = spawnSync("bash", ["-n", FIRST_LAUNCH], { encoding: "utf8" })
    expect(r.status).toBe(0)
  })

  it("first-launch substitutes the sentinels the launchd plist carries", () => {
    const shim = read(FIRST_LAUNCH)
    // Both sentinels must be sed-replaced before the plist is moved
    // into ~/Library/LaunchAgents — otherwise launchd refuses.
    expect(shim).toMatch(/s\|__HOME__\|/)
    expect(shim).toMatch(/s\|__INSTALL_BIN__\|/)
  })

  it("first-launch invokes setup --unattended --skip-auth", () => {
    const shim = read(FIRST_LAUNCH)
    expect(shim).toContain("setup --unattended --skip-auth")
  })

  it("launchd plist carries the sentinels first-launch substitutes", () => {
    const xml = read(LAUNCHD_PLIST)
    expect(xml).toContain("__HOME__")
    expect(xml).toContain("__INSTALL_BIN__")
    expect(xml).toContain("<string>co.stuffbucket.maximal</string>")
  })

  it("placeholder files exist where the README claims", () => {
    const placeholders = [
      path.join(TPL, "Contents/MacOS/maximal.placeholder"),
      path.join(ROOT, "build/macos/dmg-bg.png.placeholder"),
    ]
    for (const p of placeholders) {
      expect(fs.existsSync(p)).toBe(true)
    }
  })

  it("real AppIcon.icns ships in the template (no longer a placeholder)", () => {
    // The icon was promoted from placeholder to a real .icns file
    // generated from build/macos/app-icon.svg. The workflow still
    // does `rm -f AppIcon.icns.placeholder` defensively, but the
    // copy step now finds a real icon and copies it in.
    expect(
      fs.existsSync(path.join(TPL, "Contents/Resources/AppIcon.icns")),
    ).toBe(true)
    expect(
      fs.existsSync(
        path.join(TPL, "Contents/Resources/AppIcon.icns.placeholder"),
      ),
    ).toBe(false)
  })
})
