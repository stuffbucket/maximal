/**
 * Shim install / remove / inspect coverage. All operations run against
 * a tmp `homeDir` so the real shim location is never touched.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { spawnSync } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import {
  addShimDirToPath,
  getShimDir,
  getShimPath,
  installClaudeShim,
  isShimDirOnPath,
  isShimInstalled,
  readShimTarget,
  removeClaudeShim,
  removeShimDirFromPath,
  SHIM_MARKER,
} from "~/lib/claude-cli-detect"

let home: string

/** The zsh rc files the PATH-activation functions manage. */
function rcFiles(h: string): Array<string> {
  return [path.join(h, ".zshrc"), path.join(h, ".zprofile")]
}

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

describe("PATH activation (addShimDirToPath / removeShimDirFromPath)", () => {
  test("writes a precmd-hook PATH block to both zsh rc files", () => {
    const written = addShimDirToPath(home)
    expect(written.sort()).toEqual(rcFiles(home).sort())
    for (const rc of rcFiles(home)) {
      const content = fs.readFileSync(rc, "utf8")
      // The block registers a precmd hook that fronts the shims dir, and
      // names the dir so the hook can re-assert it before every prompt.
      expect(content).toContain(`_maximal_shims_dir="${getShimDir(home)}"`)
      expect(content).toContain("precmd_functions=(_maximal_front_path")
    }
    expect(isShimDirOnPath(home)).toBe(true)
  })

  test("fronts the shims dir (ahead of $PATH), order-independent", () => {
    addShimDirToPath(home)
    const block = fs.readFileSync(path.join(home, ".zshrc"), "utf8")
    // The hook exports PATH with the shims dir FIRST.
    expect(block).toContain('export PATH="$_maximal_shims_dir:$_maximal_p"')
    // It registers a precmd hook so a later prepend can't permanently win.
    expect(block).toContain("precmd_functions")
  })

  test("is idempotent — a second call doesn't duplicate the block", () => {
    addShimDirToPath(home)
    addShimDirToPath(home)
    const content = fs.readFileSync(path.join(home, ".zshrc"), "utf8")
    const occurrences =
      content.split("# >>> maximal claude shim >>>").length - 1
    expect(occurrences).toBe(1)
  })

  test("preserves existing rc content when adding and removing", () => {
    const zshrc = path.join(home, ".zshrc")
    fs.writeFileSync(zshrc, "# my stuff\nexport FOO=bar\n")
    addShimDirToPath(home)
    expect(fs.readFileSync(zshrc, "utf8")).toContain("export FOO=bar")

    removeShimDirFromPath(home)
    const after = fs.readFileSync(zshrc, "utf8")
    expect(after).toContain("export FOO=bar")
    expect(after).not.toContain("maximal claude shim")
    expect(isShimDirOnPath(home)).toBe(false)
  })

  test("removeShimDirFromPath is a no-op when the block isn't present", () => {
    fs.writeFileSync(path.join(home, ".zshrc"), "export FOO=bar\n")
    expect(removeShimDirFromPath(home)).toEqual([])
  })

  test("isShimDirOnPath is false before activation", () => {
    expect(isShimDirOnPath(home)).toBe(false)
  })

  test("zsh precmd hook reclaims front even when something re-prepends after it", () => {
    // The actual bug: a static `export PATH="<shims>:$PATH"` loses when the
    // native Claude Code installer appends its own ~/.local/bin prepend
    // after ours. The precmd hook must put the shims dir back at the front
    // before the next prompt. Runs real zsh; skips where zsh is absent
    // (e.g. ubuntu CI), so it guards locally / on macOS without flaking.
    const zsh = whichZsh()
    if (!zsh) return // zsh not installed — nothing to assert here

    addShimDirToPath(home)
    const block = fs.readFileSync(path.join(home, ".zshrc"), "utf8")
    const shimDir = getShimDir(home)

    // Source our block, simulate a later ~/.local/bin prepend, then fire the
    // precmd hooks the way zsh does before a prompt, and print PATH[0].
    const script = [
      'export PATH="$HOME/.local/bin:/usr/bin:/bin"',
      block,
      'export PATH="$HOME/.local/bin:$PATH"', // installer steals front
      "for f in $precmd_functions; do $f; done", // prompt fires
      'print -r -- "${PATH%%:*}"',
    ].join("\n")

    const out = spawnSync(zsh, ["-fc", script], { encoding: "utf8" })
    expect(out.status).toBe(0)
    expect(out.stdout.trim()).toBe(shimDir)
  })
})

/** Resolve a usable `zsh`, or null when none is on PATH. */
function whichZsh(): string | null {
  const r = spawnSync("zsh", ["--version"], { encoding: "utf8" })
  return r.status === 0 ? "zsh" : null
}
