/**
 * Detection coverage for `claude` CLI installs.
 *
 * Everything runs against tmp dirs with fake `claude` scripts, with
 * `homeDir` / `pathDirs` / `npmPrefix` injected so the assertions don't
 * depend on what's installed on the host. Where the host *might* also
 * have a real claude (e.g. `/opt/homebrew/bin/claude`), we filter the
 * results down to our tmp paths instead of asserting on total count.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import {
  detectClaudeInstalls,
  readClaudeVersion,
  SHIM_MARKER,
} from "~/lib/claude-cli-detect"

let root: string

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "apps-detect-"))
})

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true })
})

function makeClaude(
  dir: string,
  opts: { version?: string; marker?: boolean } = {},
): string {
  fs.mkdirSync(dir, { recursive: true })
  const file = path.join(dir, "claude")
  const lines = ["#!/bin/sh"]
  if (opts.marker) lines.push(SHIM_MARKER)
  lines.push(`echo "${opts.version ?? "1.2.3"} (Claude Code)"`)
  fs.writeFileSync(file, lines.join("\n") + "\n")
  fs.chmodSync(file, 0o755)
  return file
}

describe("detectClaudeInstalls", () => {
  test("dedupes a single real binary reachable via multiple PATH dirs", () => {
    const realDir = path.join(root, "real")
    const realFile = makeClaude(realDir)
    const resolved = fs.realpathSync(realFile)

    const dir1 = path.join(root, "p1")
    const dir2 = path.join(root, "p2")
    fs.mkdirSync(dir1)
    fs.mkdirSync(dir2)
    fs.symlinkSync(realFile, path.join(dir1, "claude"))
    fs.symlinkSync(realFile, path.join(dir2, "claude"))

    const installs = detectClaudeInstalls({
      homeDir: path.join(root, "home"),
      pathDirs: [dir1, dir2],
      npmPrefix: null,
    })
    const mine = installs.filter((i) => i.path === resolved)
    expect(mine).toHaveLength(1)
  })

  test("parses --version output", () => {
    const dir = path.join(root, "bin")
    const file = makeClaude(dir, { version: "9.8.7" })
    const resolved = fs.realpathSync(file)

    const installs = detectClaudeInstalls({
      homeDir: path.join(root, "home"),
      pathDirs: [dir],
      npmPrefix: null,
    })
    const mine = installs.find((i) => i.path === resolved)
    expect(mine?.version).toBe("9.8.7")
  })

  test("version is null when the binary can't be run", () => {
    const dir = path.join(root, "bin")
    const file = makeClaude(dir)
    const resolved = fs.realpathSync(file)
    const installs = detectClaudeInstalls({
      homeDir: path.join(root, "home"),
      pathDirs: [dir],
      npmPrefix: null,
      readVersion: () => null,
    })
    expect(installs.find((i) => i.path === resolved)?.version).toBeNull()
  })

  test("excludes our own shim via the marker line", () => {
    const dir = path.join(root, "bin")
    const file = makeClaude(dir, { marker: true })
    const resolved = fs.realpathSync(file)

    const installs = detectClaudeInstalls({
      homeDir: path.join(root, "home"),
      pathDirs: [dir],
      npmPrefix: null,
    })
    expect(installs.some((i) => i.path === resolved)).toBe(false)
  })

  test("classifies sources by location", () => {
    const home = path.join(root, "home")
    const localBin = makeClaude(path.join(home, ".local", "bin"))
    const claudeLocal = makeClaude(path.join(home, ".claude", "local"))
    const npmPrefix = path.join(root, "npm")
    const npmFile = makeClaude(path.join(npmPrefix, "bin"))
    const pathDir = path.join(root, "somewhere")
    const pathFile = makeClaude(pathDir)

    const installs = detectClaudeInstalls({
      homeDir: home,
      pathDirs: [pathDir],
      npmPrefix,
    })

    const byPath = new Map(
      installs.map((i) => [fs.realpathSync(i.path), i.source]),
    )
    expect(byPath.get(fs.realpathSync(localBin))).toBe("local-bin")
    expect(byPath.get(fs.realpathSync(claudeLocal))).toBe("claude-local")
    expect(byPath.get(fs.realpathSync(npmFile))).toBe("npm-global")
    expect(byPath.get(fs.realpathSync(pathFile))).toBe("path")
  })

  test('classifies a binary under `<home>/.claude/...` as "claude-local"', () => {
    const home = path.join(root, "home")
    const file = makeClaude(path.join(home, ".claude", "local"))
    const resolved = fs.realpathSync(file)
    const installs = detectClaudeInstalls({
      homeDir: home,
      pathDirs: [],
      npmPrefix: null,
    })
    expect(installs.find((i) => i.path === resolved)?.source).toBe(
      "claude-local",
    )
  })

  test('classifies `<home>/.local/bin/claude` as "local-bin"', () => {
    const home = path.join(root, "home")
    const file = makeClaude(path.join(home, ".local", "bin"))
    const resolved = fs.realpathSync(file)
    const installs = detectClaudeInstalls({
      homeDir: home,
      pathDirs: [],
      npmPrefix: null,
    })
    expect(installs.find((i) => i.path === resolved)?.source).toBe("local-bin")
  })

  test('classifies a binary under the npm prefix `/bin` as "npm-global"', () => {
    const home = path.join(root, "home")
    const npmPrefix = path.join(root, "npm")
    const file = makeClaude(path.join(npmPrefix, "bin"))
    const resolved = fs.realpathSync(file)
    const installs = detectClaudeInstalls({
      homeDir: home,
      pathDirs: [],
      npmPrefix,
    })
    expect(installs.find((i) => i.path === resolved)?.source).toBe("npm-global")
  })

  test('classifies a binary on an ordinary PATH dir as "path"', () => {
    const home = path.join(root, "home")
    const pathDir = path.join(root, "elsewhere")
    const file = makeClaude(pathDir)
    const resolved = fs.realpathSync(file)
    const installs = detectClaudeInstalls({
      homeDir: home,
      pathDirs: [pathDir],
      npmPrefix: null,
    })
    expect(installs.find((i) => i.path === resolved)?.source).toBe("path")
  })

  test('classifies a binary resolving under /usr/local (or /opt/homebrew) as "homebrew"', () => {
    // The homebrew prefix heuristic keys off the real (symlink-resolved)
    // path starting with /usr/local/ or /opt/homebrew/. There is no
    // injection point for those prefixes, so we place a real fixture under
    // a uniquely-named subdir of /usr/local/bin and reach it via pathDirs
    // (origin "path", so classification falls through to the prefix check).
    let brewDir: string
    try {
      brewDir = fs.mkdtempSync(
        path.join("/usr/local/bin", "maximal-brew-test-"),
      )
    } catch {
      // Not writable on this host (e.g. CI without Homebrew) — skip.
      return
    }
    try {
      const file = makeClaude(brewDir)
      const resolved = fs.realpathSync(file)
      // Sanity: the resolved path must actually sit under the brew prefix
      // for this test to exercise the intended branch.
      expect(
        resolved.startsWith("/usr/local/")
          || resolved.startsWith("/opt/homebrew/"),
      ).toBe(true)

      const installs = detectClaudeInstalls({
        homeDir: path.join(root, "home"),
        pathDirs: [brewDir],
        npmPrefix: null,
      })
      expect(installs.find((i) => i.path === resolved)?.source).toBe("homebrew")
    } finally {
      fs.rmSync(brewDir, { recursive: true, force: true })
    }
  })

  test("detection reports a multi-digit semver from --version output", () => {
    // Pins the /\d+\.\d+\.\d+/ extraction: dropping a `+` would turn
    // "10.20.30" into "0.20.30". A real fake executable is run here
    // (no readVersion injection) so the regex in readClaudeVersion is
    // exercised end-to-end.
    const dir = path.join(root, "bin")
    const file = makeClaude(dir, { version: "10.20.30" })
    const resolved = fs.realpathSync(file)
    const installs = detectClaudeInstalls({
      homeDir: path.join(root, "home"),
      pathDirs: [dir],
      npmPrefix: null,
    })
    expect(installs.find((i) => i.path === resolved)?.version).toBe("10.20.30")
  })
})

describe("readClaudeVersion", () => {
  test("extracts a semver token from noisy output", () => {
    const dir = path.join(root, "bin")
    const file = makeClaude(dir, { version: "1.0.44" })
    expect(readClaudeVersion(file)).toBe("1.0.44")
  })

  test("extracts a multi-digit semver (each component can be >1 digit)", () => {
    // Dropping a `+` from /\d+\.\d+\.\d+/ would yield "0.20.30" here.
    const dir = path.join(root, "multidigit")
    const file = makeClaude(dir, { version: "10.20.30" })
    expect(readClaudeVersion(file)).toBe("10.20.30")
  })

  test("extracts the semver from leading tool-name + trailing build text", () => {
    // makeClaude wraps the value as `<value> (Claude Code)`, so passing a
    // leading tool name yields `claude 7.8.9 (Claude Code)`. The semver
    // must be plucked from the middle, not the surrounding prose.
    const dir = path.join(root, "named")
    const file = makeClaude(dir, { version: "claude 7.8.9" })
    expect(readClaudeVersion(file)).toBe("7.8.9")
  })

  test("returns null for a non-existent binary", () => {
    expect(readClaudeVersion(path.join(root, "nope"))).toBeNull()
  })
})
