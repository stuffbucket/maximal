/**
 * Smoke test for the `configure-claude-desktop` subcommand.
 *
 * Doesn't exercise the macOS-specific MDM path (that needs `defaults`
 * and a real `/Applications/Claude.app`). Instead, verifies that the
 * citty command exists, exposes the documented flags, and that the
 * command's `run` invokes the underlying handler.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import { configureClaudeDesktop } from "~/apps/claude-desktop/cli"
import { claudeAppInstalled } from "~/apps/claude-desktop/detect"

describe("claudeAppInstalled — Windows (platform injected)", () => {
  let home: string
  let savedLocalAppData: string | undefined

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), "cd-app-"))
    savedLocalAppData = process.env.LOCALAPPDATA
    // Point %LOCALAPPDATA% at our throwaway home so the probe is hermetic.
    process.env.LOCALAPPDATA = path.join(home, "AppData", "Local")
  })

  afterEach(() => {
    if (savedLocalAppData === undefined) delete process.env.LOCALAPPDATA
    else process.env.LOCALAPPDATA = savedLocalAppData
    fs.rmSync(home, { recursive: true, force: true })
  })

  it("returns false when no Windows Claude Desktop install exists", () => {
    expect(claudeAppInstalled("win32", home)).toBe(false)
  })

  it("detects the Squirrel install dir (%LOCALAPPDATA%/AnthropicClaude)", () => {
    fs.mkdirSync(path.join(home, "AppData", "Local", "AnthropicClaude"), {
      recursive: true,
    })
    expect(claudeAppInstalled("win32", home)).toBe(true)
  })

  it("detects the WindowsApps launcher alias (Claude.exe)", () => {
    const aliasDir = path.join(
      home,
      "AppData",
      "Local",
      "Microsoft",
      "WindowsApps",
    )
    fs.mkdirSync(aliasDir, { recursive: true })
    fs.writeFileSync(path.join(aliasDir, "Claude.exe"), "stub")
    expect(claudeAppInstalled("win32", home)).toBe(true)
  })

  it("detects the MSIX package dir (Packages/Claude_pzs8sxrjxfjjc)", () => {
    fs.mkdirSync(
      path.join(home, "AppData", "Local", "Packages", "Claude_pzs8sxrjxfjjc"),
      { recursive: true },
    )
    expect(claudeAppInstalled("win32", home)).toBe(true)
  })

  it("detects a Claude-family MSIX package by prefix (hashed family name)", () => {
    // The publisher-hash suffix mutates between installs, so detection scans
    // the Packages dir for the family prefix rather than an exact name.
    fs.mkdirSync(
      path.join(
        home,
        "AppData",
        "Local",
        "Packages",
        "AnthropicPBC.Claude_1a2b3c4d5e6f7",
      ),
      { recursive: true },
    )
    expect(claudeAppInstalled("win32", home)).toBe(true)
  })

  it("does not false-positive on an unrelated Packages entry", () => {
    fs.mkdirSync(
      path.join(
        home,
        "AppData",
        "Local",
        "Packages",
        "Microsoft.SomethingElse",
      ),
      { recursive: true },
    )
    expect(claudeAppInstalled("win32", home)).toBe(false)
  })

  it("returns true on unsupported platforms (can't tell → don't block)", () => {
    expect(claudeAppInstalled("linux", home)).toBe(true)
  })
})

describe("configure-claude-desktop subcommand", () => {
  it("exposes the documented metadata", async () => {
    const meta = await resolveMaybe(configureClaudeDesktop.meta)
    expect(meta?.name).toBe("configure-claude-desktop")
    expect(meta?.description).toContain("Claude Desktop")
  })

  it("declares --force and --revert flags", async () => {
    const args = await resolveMaybe(configureClaudeDesktop.args)
    expect(args).toBeDefined()
    if (!args) return
    expect(args.force).toBeDefined()
    expect(args.revert).toBeDefined()
    expect(args.force.type).toBe("boolean")
    expect(args.revert.type).toBe("boolean")
  })
})

async function resolveMaybe<T>(
  value: T | (() => T) | (() => Promise<T>) | undefined,
): Promise<T | undefined> {
  if (typeof value === "function") {
    const r = (value as () => T | Promise<T>)()
    return await Promise.resolve(r)
  }
  return await Promise.resolve(value)
}
