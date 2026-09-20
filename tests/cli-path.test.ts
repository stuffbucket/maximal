/**
 * Unit coverage for the CLI-on-PATH plumbing: launch-source
 * classification and the macOS first-launch symlink shim. All tests
 * drive the pure-arg overloads (execPath / home / platform) so they
 * run identically on any host without touching the real `~/.local/bin`.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import {
  addFirstLaunchPathBlock,
  describeLaunchSource,
  ensureCliSymlink,
  FIRST_LAUNCH_PATH_MARKER_START,
  isAppBundlePath,
} from "~/lib/platform/cli-path"

const APP_EXEC = "/Applications/Maximal.app/Contents/MacOS/maximal"

let dir: string

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "maximal-cli-path-"))
})

afterEach(() => {
  try {
    fs.rmSync(dir, { recursive: true, force: true })
  } catch {
    /* best effort */
  }
})

describe("isAppBundlePath", () => {
  it("matches a .app bundle executable, nothing else", () => {
    expect(isAppBundlePath(APP_EXEC)).toBe(true)
    expect(isAppBundlePath("/opt/homebrew/bin/maximal")).toBe(false)
    expect(isAppBundlePath("/Users/x/.local/bin/maximal")).toBe(false)
  })
})

describe("describeLaunchSource", () => {
  it("classifies each install shape", () => {
    expect(describeLaunchSource(APP_EXEC).kind).toBe("dmg-app")
    expect(describeLaunchSource("/opt/homebrew/bin/maximal").kind).toBe(
      "homebrew",
    )
    expect(
      describeLaunchSource("/opt/homebrew/Cellar/maximal/0.4.25/bin/maximal")
        .kind,
    ).toBe("homebrew")
    expect(
      describeLaunchSource("/usr/local/Cellar/maximal/x/bin/maximal").kind,
    ).toBe("homebrew")
    expect(describeLaunchSource("/Users/x/.local/bin/maximal").kind).toBe(
      "user-bin",
    )
    expect(
      describeLaunchSource("/repo/shell/src-tauri/target/debug/maximal").kind,
    ).toBe("dev")
    expect(describeLaunchSource("/opt/homebrew/bin/bun").kind).toBe("dev")
    expect(describeLaunchSource("/some/random/path/maximal").kind).toBe("other")
  })

  it("returns the path verbatim", () => {
    expect(describeLaunchSource(APP_EXEC).path).toBe(APP_EXEC)
  })
})

describe("ensureCliSymlink", () => {
  it("skips non-macOS", () => {
    const r = ensureCliSymlink({
      execPath: APP_EXEC,
      home: dir,
      platform: "win32",
    })
    expect(r.skipped).toBe("not-macos")
    expect(r.linked).toBe(false)
  })

  it("skips a non-bundle launch (homebrew / dev)", () => {
    const r = ensureCliSymlink({
      execPath: "/opt/homebrew/bin/maximal",
      home: dir,
      platform: "darwin",
    })
    expect(r.skipped).toBe("not-app-bundle")
    expect(fs.existsSync(path.join(dir, ".local", "bin", "maximal"))).toBe(
      false,
    )
  })

  it("creates the bin dir, symlink, and PATH block on a fresh machine", () => {
    const r = ensureCliSymlink({
      execPath: APP_EXEC,
      home: dir,
      platform: "darwin",
    })
    expect(r.linked).toBe(true)
    expect(r.binDirCreated).toBe(true)
    expect(r.pathBlockAdded).toBe(true)
    const link = path.join(dir, ".local", "bin", "maximal")
    expect(fs.lstatSync(link).isSymbolicLink()).toBe(true)
    expect(fs.readlinkSync(link)).toBe(APP_EXEC)
    const zprofile = fs.readFileSync(path.join(dir, ".zprofile"), "utf8")
    expect(zprofile).toContain(FIRST_LAUNCH_PATH_MARKER_START)
    expect(zprofile).toContain('export PATH="$HOME/.local/bin:$PATH"')
  })

  it("does NOT touch shell profiles when ~/.local/bin already exists", () => {
    fs.mkdirSync(path.join(dir, ".local", "bin"), { recursive: true })
    const r = ensureCliSymlink({
      execPath: APP_EXEC,
      home: dir,
      platform: "darwin",
    })
    expect(r.linked).toBe(true)
    expect(r.binDirCreated).toBe(false)
    expect(r.pathBlockAdded).toBe(false)
    expect(fs.existsSync(path.join(dir, ".zprofile"))).toBe(false)
  })

  it("is idempotent — a second call relinks nothing", () => {
    const opts = { execPath: APP_EXEC, home: dir, platform: "darwin" as const }
    ensureCliSymlink(opts)
    const second = ensureCliSymlink(opts)
    expect(second.linked).toBe(false)
    expect(second.binDirCreated).toBe(false)
  })

  it("repoints a stale symlink to the new bundle path", () => {
    const bin = path.join(dir, ".local", "bin")
    fs.mkdirSync(bin, { recursive: true })
    const link = path.join(bin, "maximal")
    fs.symlinkSync("/old/Maximal.app/Contents/MacOS/maximal", link)
    const r = ensureCliSymlink({
      execPath: APP_EXEC,
      home: dir,
      platform: "darwin",
    })
    expect(r.linked).toBe(true)
    expect(fs.readlinkSync(link)).toBe(APP_EXEC)
  })

  it("refuses to clobber a real file the user owns", () => {
    const bin = path.join(dir, ".local", "bin")
    fs.mkdirSync(bin, { recursive: true })
    const file = path.join(bin, "maximal")
    fs.writeFileSync(file, "#!/bin/sh\necho not ours\n")
    const r = ensureCliSymlink({
      execPath: APP_EXEC,
      home: dir,
      platform: "darwin",
    })
    expect(r.skipped).toBe("foreign-file-at-target")
    expect(r.linked).toBe(false)
    // The user's file is intact — its original contents prove it wasn't
    // replaced by a symlink (a link to APP_EXEC couldn't read back as this).
    expect(fs.readFileSync(file, "utf8")).toContain("not ours")
  })
})

describe("addFirstLaunchPathBlock", () => {
  it("appends the block and is idempotent", () => {
    expect(addFirstLaunchPathBlock(dir)).toBe(true)
    // Second call sees the marker and no-ops.
    expect(addFirstLaunchPathBlock(dir)).toBe(false)
    const rc = fs.readFileSync(path.join(dir, ".zprofile"), "utf8")
    // Exactly one block.
    const occurrences = rc.split(FIRST_LAUNCH_PATH_MARKER_START).length - 1
    expect(occurrences).toBe(1)
  })

  it("preserves existing rc content and separates with a newline", () => {
    const rc = path.join(dir, ".zprofile")
    fs.writeFileSync(rc, 'export PATH="$HOME/mytools:$PATH"')
    addFirstLaunchPathBlock(dir)
    const after = fs.readFileSync(rc, "utf8")
    expect(after).toContain('export PATH="$HOME/mytools:$PATH"')
    expect(after).toContain(FIRST_LAUNCH_PATH_MARKER_START)
    // The pre-existing (newline-less) content didn't get glued to our marker.
    expect(after).not.toContain('mytools:$PATH"# >>>')
  })
})
