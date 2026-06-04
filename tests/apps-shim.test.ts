/**
 * Shim install / remove / inspect coverage. All operations run against
 * a tmp `homeDir` so the real shim location is never touched.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import {
  getShimDir,
  getShimPath,
  installClaudeShim,
  isShimInstalled,
  readShimTarget,
  removeClaudeShim,
  SHIM_MARKER,
} from "~/lib/claude-cli-detect"

let home: string

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "apps-shim-"))
})

afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true })
})

describe("installClaudeShim", () => {
  test("writes a marked, executable shim that exec's the target", () => {
    const target = "/opt/homebrew/bin/claude"
    const shimPath = installClaudeShim(target, {
      homeDir: home,
      maximalBinPath: "/opt/Maximal.app/Contents/MacOS/maximal",
    })
    expect(shimPath).toBe(getShimPath(home))

    const content = fs.readFileSync(shimPath, "utf8")
    expect(content).toContain(SHIM_MARKER)
    // URL is assembled from PROXY_HOST/PROXY_PORT shell vars; assert the
    // resolved host:port appears and the export line is present.
    expect(content).toContain('PROXY_HOST="127.0.0.1"')
    expect(content).toContain('PROXY_PORT="4141"')
    expect(content).toContain(
      'export ANTHROPIC_BASE_URL="http://${PROXY_HOST}:${PROXY_PORT}"',
    )
    expect(content).toContain(`exec "$REAL_CLAUDE" "$@"`)
    expect(content).toContain(`REAL_CLAUDE="${target}"`)

    const mode = fs.statSync(shimPath).mode & 0o777
    expect(mode & 0o100).toBe(0o100) // owner-executable
  })

  test("lives in the dedicated shims dir, named `claude`", () => {
    installClaudeShim("/opt/homebrew/bin/claude", { homeDir: home })
    expect(getShimPath(home)).toBe(path.join(getShimDir(home), "claude"))
    expect(getShimDir(home)).toBe(
      path.join(home, ".local", "share", "maximal", "shims"),
    )
  })

  test("creates the shims dir 0700 (owner-only, not world-writable)", () => {
    installClaudeShim("/opt/homebrew/bin/claude", { homeDir: home })
    const mode = fs.statSync(getShimDir(home)).mode & 0o777
    expect(mode & 0o022).toBe(0) // no group/other write
    expect(mode & 0o700).toBe(0o700) // owner rwx
  })

  test("refuses a pre-existing group/world-writable shims dir", () => {
    const dir = getShimDir(home)
    fs.mkdirSync(dir, { recursive: true })
    fs.chmodSync(dir, 0o777)
    expect(() => installClaudeShim("/x/claude", { homeDir: home })).toThrow(
      /group\/world-writable/,
    )
  })

  test("bakes in the fail-closed guard chain", () => {
    const content = fs.readFileSync(
      installClaudeShim("/opt/homebrew/bin/claude", {
        homeDir: home,
        maximalBinPath: "/opt/Maximal.app/Contents/MacOS/maximal",
      }),
      "utf8",
    )
    // Falls through to the real claude when Maximal is absent/down.
    expect(content).toContain('bare() { exec "$REAL_CLAUDE" "$@"; }')
    // Verifies the Maximal binary, the listening port, and the owning PID.
    expect(content).toContain(
      'MAXIMAL_BIN="/opt/Maximal.app/Contents/MacOS/maximal"',
    )
    expect(content).toContain("lsof")
    expect(content).toContain("ps -p")
  })

  test("omits the API key line when no key is given", () => {
    const shimPath = installClaudeShim("/usr/local/bin/claude", {
      homeDir: home,
    })
    expect(fs.readFileSync(shimPath, "utf8")).not.toContain("ANTHROPIC_API_KEY")
  })

  test("injects the API key line when a key is given", () => {
    const shimPath = installClaudeShim("/usr/local/bin/claude", {
      homeDir: home,
      apiKey: "mxl_secret123",
    })
    expect(fs.readFileSync(shimPath, "utf8")).toContain(
      'ANTHROPIC_API_KEY="mxl_secret123"',
    )
  })

  test("overwrites a prior Maximal shim", () => {
    installClaudeShim("/first/claude", { homeDir: home })
    installClaudeShim("/second/claude", { homeDir: home })
    expect(readShimTarget(home)).toBe("/second/claude")
  })

  test("refuses to clobber a non-shim file", () => {
    const shimPath = getShimPath(home)
    fs.mkdirSync(path.dirname(shimPath), { recursive: true })
    fs.writeFileSync(shimPath, "#!/bin/sh\necho real binary\n")
    expect(() => installClaudeShim("/x/claude", { homeDir: home })).toThrow()
    // The user's file is untouched.
    expect(fs.readFileSync(shimPath, "utf8")).toContain("real binary")
  })
})

describe("removeClaudeShim", () => {
  test("removes a marked shim and reports true", () => {
    installClaudeShim("/x/claude", { homeDir: home })
    expect(removeClaudeShim(home)).toBe(true)
    expect(fs.existsSync(getShimPath(home))).toBe(false)
  })

  test("no-op (false) when absent", () => {
    expect(removeClaudeShim(home)).toBe(false)
  })

  test("refuses to delete a non-shim file", () => {
    const shimPath = getShimPath(home)
    fs.mkdirSync(path.dirname(shimPath), { recursive: true })
    fs.writeFileSync(shimPath, "#!/bin/sh\necho real\n")
    expect(() => removeClaudeShim(home)).toThrow()
    expect(fs.existsSync(shimPath)).toBe(true)
  })
})

describe("isShimInstalled / readShimTarget", () => {
  test("round-trips the install target", () => {
    expect(isShimInstalled(home)).toBe(false)
    expect(readShimTarget(home)).toBeNull()

    installClaudeShim("/opt/homebrew/bin/claude", { homeDir: home })
    expect(isShimInstalled(home)).toBe(true)
    expect(readShimTarget(home)).toBe("/opt/homebrew/bin/claude")
  })
})
