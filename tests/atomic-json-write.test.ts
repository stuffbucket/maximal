/**
 * Regression tests for the consolidated atomic JSON writer (#231). Proves the
 * shared helper — used by BOTH app config writers, Claude Code
 * (`writeClaudeCodeSettings`) and Claude Desktop (`applyConfigLibraryProfile`)
 * — is BOTH symlink-safe AND crash-recoverable.
 *
 * Two properties matter here, and the initial #231 fix got them backwards:
 *
 *  - O_EXCL is the real symlink guard: the kernel refuses to open THROUGH a
 *    symlink at the final path component. A regular stale `<file>.tmp` (left
 *    by a write that crashed between open and rename) is NOT an attack — it is
 *    a benign artifact, and the writer must self-heal by clearing it and
 *    succeeding, not hard-fail forever with a misleading "symlink attack".
 *
 *  - `unlink` clears that stale temp WITHOUT following a symlink to its target,
 *    so it is itself symlink-safe: a planted symlink temp is removed (not
 *    followed/clobbered), and the real write lands at the intended path.
 *
 * So the honest tests below assert crash-recovery (stale regular/symlink temp
 * is cleared, write succeeds at the intended path, symlink's target untouched)
 * rather than asserting the write throws on a pre-existing temp.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import { writeClaudeCodeSettings } from "~/apps/claude-code/config"
import {
  applyConfigLibraryProfile,
  getClaude3pDir,
} from "~/apps/claude-desktop/config"
import { atomicWriteJson } from "~/lib/atomic-json"

let dir: string

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "maximal-atomic-json-"))
})

afterEach(() => {
  try {
    fs.rmSync(dir, { recursive: true, force: true })
  } catch {
    /* best effort */
  }
})

describe("atomicWriteJson (shared helper)", () => {
  it("writes pretty JSON with a trailing newline, mode 0600, no .tmp leak", () => {
    const file = path.join(dir, "out.json")
    atomicWriteJson(file, { a: 1, b: ["x"] })
    const raw = fs.readFileSync(file, "utf8")
    expect(raw).toBe(`${JSON.stringify({ a: 1, b: ["x"] }, null, 2)}\n`)
    expect(raw.endsWith("\n")).toBe(true)
    expect(fs.statSync(file).mode & 0o777).toBe(0o600)
    expect(fs.existsSync(`${file}.tmp`)).toBe(false)
  })

  it("creates missing parent directories", () => {
    const file = path.join(dir, "nested", "deep", "out.json")
    atomicWriteJson(file, { ok: true })
    // eslint-disable-next-line unicorn/prefer-json-parse-buffer
    expect(JSON.parse(fs.readFileSync(file, "utf8"))).toEqual({ ok: true })
  })

  it("self-heals a stale REGULAR <file>.tmp (crash recovery): clears it and writes", () => {
    const file = path.join(dir, "out.json")
    // A prior write crashed between open and rename, leaving a stale temp.
    fs.writeFileSync(`${file}.tmp`, "stale garbage from a crashed write")
    atomicWriteJson(file, { a: 1 })
    // eslint-disable-next-line unicorn/prefer-json-parse-buffer
    expect(JSON.parse(fs.readFileSync(file, "utf8"))).toEqual({ a: 1 })
    expect(fs.statSync(file).mode & 0o777).toBe(0o600)
    expect(fs.existsSync(`${file}.tmp`)).toBe(false)
  })

  it("clears a stale SYMLINK <file>.tmp without following it; target untouched", () => {
    const file = path.join(dir, "out.json")
    const victim = path.join(dir, "victim.txt")
    fs.writeFileSync(victim, "precious")
    // Plant a symlink at the temp path pointing at a file we must NOT clobber.
    fs.symlinkSync(victim, `${file}.tmp`)
    atomicWriteJson(file, { a: 1 })
    // Real write landed at the intended path…
    // eslint-disable-next-line unicorn/prefer-json-parse-buffer
    expect(JSON.parse(fs.readFileSync(file, "utf8"))).toEqual({ a: 1 })
    // …the symlink's target was never followed or overwritten…
    expect(fs.readFileSync(victim, "utf8")).toBe("precious")
    // …and the temp is gone.
    expect(fs.existsSync(`${file}.tmp`)).toBe(false)
  })
})

describe("writeClaudeCodeSettings — atomic write (#231)", () => {
  it("happy path: writes settings with mode 0600 and correct content", () => {
    const file = path.join(dir, "settings.json")
    writeClaudeCodeSettings(file, { foo: "bar" })
    // eslint-disable-next-line unicorn/prefer-json-parse-buffer
    expect(JSON.parse(fs.readFileSync(file, "utf8"))).toEqual({ foo: "bar" })
    expect(fs.statSync(file).mode & 0o777).toBe(0o600)
    expect(fs.existsSync(`${file}.tmp`)).toBe(false)
  })

  it("self-heals over a stale regular <file>.tmp (crash recovery)", () => {
    const file = path.join(dir, "settings.json")
    fs.writeFileSync(`${file}.tmp`, "stale")
    writeClaudeCodeSettings(file, { foo: "bar" })
    // eslint-disable-next-line unicorn/prefer-json-parse-buffer
    expect(JSON.parse(fs.readFileSync(file, "utf8"))).toEqual({ foo: "bar" })
    expect(fs.existsSync(`${file}.tmp`)).toBe(false)
  })

  it("clears a planted symlink temp without clobbering its target", () => {
    const file = path.join(dir, "settings.json")
    const victim = path.join(dir, "victim.txt")
    fs.writeFileSync(victim, "precious")
    fs.symlinkSync(victim, `${file}.tmp`)
    writeClaudeCodeSettings(file, { foo: "bar" })
    // eslint-disable-next-line unicorn/prefer-json-parse-buffer
    expect(JSON.parse(fs.readFileSync(file, "utf8"))).toEqual({ foo: "bar" })
    expect(fs.readFileSync(victim, "utf8")).toBe("precious")
  })
})

describe("Claude Desktop config writer — atomic write (#231)", () => {
  it("happy path: applies the profile and writes 0600 files", () => {
    const result = applyConfigLibraryProfile(dir)
    expect(result.wrote).toBe(true)
    const topPath = path.join(getClaude3pDir(dir), "claude_desktop_config.json")
    expect(fs.existsSync(topPath)).toBe(true)
    expect(fs.statSync(topPath).mode & 0o777).toBe(0o600)
  })

  it("self-heals over a stale _meta.json.tmp (crash recovery)", () => {
    const libDir = path.join(getClaude3pDir(dir), "configLibrary")
    fs.mkdirSync(libDir, { recursive: true })
    // Stale temp from a crashed prior apply on the _meta.json write path.
    fs.writeFileSync(path.join(libDir, "_meta.json.tmp"), "stale")
    const result = applyConfigLibraryProfile(dir)
    expect(result.wrote).toBe(true)
    // eslint-disable-next-line unicorn/prefer-json-parse-buffer -- JSON.parse needs string
    const raw = fs.readFileSync(path.join(libDir, "_meta.json"), "utf8")
    const meta = JSON.parse(raw) as Record<string, unknown>
    expect(meta.appliedId).toBe(result.profileId)
    expect(fs.existsSync(path.join(libDir, "_meta.json.tmp"))).toBe(false)
  })

  it("clears a planted symlink at a profile temp without clobbering its target", () => {
    const libDir = path.join(getClaude3pDir(dir), "configLibrary")
    fs.mkdirSync(libDir, { recursive: true })
    const victim = path.join(dir, "victim.txt")
    fs.writeFileSync(victim, "precious")
    fs.symlinkSync(victim, path.join(libDir, "_meta.json.tmp"))
    const result = applyConfigLibraryProfile(dir)
    expect(result.wrote).toBe(true)
    expect(fs.readFileSync(victim, "utf8")).toBe("precious")
    // eslint-disable-next-line unicorn/prefer-json-parse-buffer -- JSON.parse needs string
    const raw = fs.readFileSync(path.join(libDir, "_meta.json"), "utf8")
    const meta = JSON.parse(raw) as Record<string, unknown>
    expect(meta.appliedId).toBe(result.profileId)
  })
})
