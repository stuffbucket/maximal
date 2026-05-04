/**
 * PR-time guard for the B4 install landing page.
 *
 * Doesn't render the page — that needs a real browser + network. This
 * just pins the contract points the page depends on so a release-asset
 * rename in Stream A or a B3a artifact rename can't silently break the
 * primary download button.
 */

import { describe, expect, it } from "bun:test"
import fs from "node:fs"
import path from "node:path"

const ROOT = path.resolve(import.meta.dir, "..")
const PAGE = path.join(ROOT, "pages/install/index.html")

const html = fs.readFileSync(PAGE, "utf8")

describe("install landing page", () => {
  it("matches the asset suffixes Stream A + B3a publish", () => {
    expect(html).toContain("darwin-arm64.dmg")
    expect(html).toContain("darwin-x64.dmg")
    expect(html).toContain("windows-x64.zip")
    expect(html).toContain("install.ps1")
    expect(html).toContain("darwin-arm64.tar.gz")
    expect(html).toContain("darwin-x64.tar.gz")
  })

  it("fetches the GitHub releases API for the latest release", () => {
    expect(html).toContain("api.github.com/repos/")
    expect(html).toContain("/releases/latest")
  })

  it("renders OS-specific first-launch warnings", () => {
    expect(html).toContain("Gatekeeper")
    expect(html).toContain("SmartScreen")
    expect(html).toContain("More info")
    expect(html).toContain("Run anyway")
    expect(html).toContain("Right-click")
  })

  it("documents the verify and uninstall commands", () => {
    expect(html).toContain("copilot-api debug")
    expect(html).toContain("copilot-api uninstall")
  })
})
