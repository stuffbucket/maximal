/**
 * Cleanup of the pre-v0.4.13 `~/.local/share/maximal/shims/claude` wrapper.
 * The PATH-shim approach was replaced by ~/.claude/settings.json writes
 * (commit cf0f578); users upgrading from older versions still have the
 * orphan file on disk. `removeLegacyShimIfPresent` deletes it on boot —
 * idempotently and ONLY when the file carries our marker.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import {
  legacyShimPath,
  removeLegacyShimIfPresent,
  SHIM_MARKER,
} from "~/apps/claude-code/detect"

let tmp: string

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "maximal-shim-test-"))
})

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true })
})

function makeShimDir(): string {
  const dir = path.join(tmp, ".local", "share", "maximal", "shims")
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

describe("removeLegacyShimIfPresent", () => {
  test("returns null and is a no-op when the file does not exist", () => {
    expect(removeLegacyShimIfPresent(tmp)).toBeNull()
    expect(fs.existsSync(legacyShimPath(tmp))).toBe(false)
  })

  test("deletes a shim that contains SHIM_MARKER and returns the path", () => {
    makeShimDir()
    const shim = legacyShimPath(tmp)
    fs.writeFileSync(
      shim,
      `#!/bin/sh\n${SHIM_MARKER}\nexec /some/old/claude "$@"\n`,
      { mode: 0o755 },
    )

    const removed = removeLegacyShimIfPresent(tmp)
    expect(removed).toBe(shim)
    expect(fs.existsSync(shim)).toBe(false)
  })

  test("leaves a file at the shim path alone when it does NOT contain SHIM_MARKER", () => {
    // Defense against a future feature reusing the same path, or a user
    // who placed their own script there. Without the marker we never touch.
    makeShimDir()
    const shim = legacyShimPath(tmp)
    const foreignContent = `#!/bin/sh\n# someone else's wrapper\nexec /usr/bin/claude "$@"\n`
    fs.writeFileSync(shim, foreignContent, { mode: 0o755 })

    expect(removeLegacyShimIfPresent(tmp)).toBeNull()
    expect(fs.existsSync(shim)).toBe(true)
    expect(fs.readFileSync(shim, "utf8")).toBe(foreignContent)
  })

  test("idempotent: a second call after a successful delete returns null", () => {
    makeShimDir()
    const shim = legacyShimPath(tmp)
    fs.writeFileSync(shim, `#!/bin/sh\n${SHIM_MARKER}\nexec foo\n`, {
      mode: 0o755,
    })
    expect(removeLegacyShimIfPresent(tmp)).toBe(shim)
    expect(removeLegacyShimIfPresent(tmp)).toBeNull()
  })

  test("survives a permission error gracefully (returns null, never throws)", () => {
    // Simulate by passing a home that points at a non-writable file as the
    // 'parent' of the shim dir — Bun's tmp dirs are writable; instead we
    // verify the swallow-and-return path by feeding a path that's *itself*
    // a directory (unlinkSync on a directory throws EISDIR).
    const fakeHome = path.join(tmp, "weird")
    const shimAsDir = legacyShimPath(fakeHome)
    fs.mkdirSync(shimAsDir, { recursive: true })
    // Now legacyShimPath(fakeHome) is a directory. fileStartsWithContains
    // will fail (it tries to openSync a directory as a file), so the function
    // takes the !contains branch and returns null without throwing.
    expect(() => removeLegacyShimIfPresent(fakeHome)).not.toThrow()
    expect(removeLegacyShimIfPresent(fakeHome)).toBeNull()
    // The directory remains.
    expect(fs.existsSync(shimAsDir)).toBe(true)
  })
})

describe("legacyShimPath", () => {
  test("returns ~/.local/share/maximal/shims/claude for the given home", () => {
    expect(legacyShimPath("/tmp/fake-home")).toBe(
      "/tmp/fake-home/.local/share/maximal/shims/claude",
    )
  })
})
