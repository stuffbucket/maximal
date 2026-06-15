/* eslint-disable unicorn/prefer-json-parse-buffer -- TS overload doesn't accept Buffer for JSON.parse */
/**
 * Crash-detection sentinel for the Claude Code routing lifecycle.
 *
 * Covers the three exported functions in src/lib/start/session-sentinel.ts:
 *   - markSessionRunning: writes the sentinel idempotently
 *   - clearSessionRunning: deletes it idempotently
 *   - staleSessionMarkerPresent: detects presence without deleting
 *
 * Tests redirect PATHS.APP_DIR at a per-test tmp dir by monkey-patching
 * the `APP_DIR` property on the imported PATHS object — the module reads
 * it at function-call time, not at import time, so this works without
 * mock.module (ADR-0011: prefer DI over module mocks).
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import { PATHS } from "~/lib/paths"
import {
  clearSessionRunning,
  markSessionRunning,
  staleSessionMarkerPresent,
} from "~/lib/start/session-sentinel"

let tmp: string
let originalAppDir: string

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "maximal-sentinel-test-"))
  originalAppDir = PATHS.APP_DIR
  // PATHS is a plain object literal — directly reassign the field.
  ;(PATHS as { APP_DIR: string }).APP_DIR = tmp
})

afterEach(() => {
  ;(PATHS as { APP_DIR: string }).APP_DIR = originalAppDir
  fs.rmSync(tmp, { recursive: true, force: true })
})

function sentinelPath(): string {
  return path.join(tmp, "session-running")
}

describe("session sentinel", () => {
  test("staleSessionMarkerPresent is false when nothing has been written", () => {
    expect(staleSessionMarkerPresent()).toBe(false)
  })

  test("markSessionRunning writes a file at APP_DIR/session-running", () => {
    markSessionRunning()
    expect(fs.existsSync(sentinelPath())).toBe(true)
    const body = JSON.parse(fs.readFileSync(sentinelPath(), "utf8")) as {
      pid: number
      started_at: string
    }
    expect(body.pid).toBe(process.pid)
    expect(typeof body.started_at).toBe("string")
    expect(Number.isNaN(Date.parse(body.started_at))).toBe(false)
  })

  test("staleSessionMarkerPresent is true after markSessionRunning", () => {
    markSessionRunning()
    expect(staleSessionMarkerPresent()).toBe(true)
  })

  test("clearSessionRunning removes the sentinel", () => {
    markSessionRunning()
    expect(staleSessionMarkerPresent()).toBe(true)
    clearSessionRunning()
    expect(staleSessionMarkerPresent()).toBe(false)
    expect(fs.existsSync(sentinelPath())).toBe(false)
  })

  test("clearSessionRunning is a no-op when the sentinel doesn't exist", () => {
    expect(() => clearSessionRunning()).not.toThrow()
    expect(staleSessionMarkerPresent()).toBe(false)
  })

  test("markSessionRunning is idempotent — second call overwrites", () => {
    markSessionRunning()
    const first = fs.readFileSync(sentinelPath(), "utf8")
    // Sleep to ensure a different timestamp.
    const until = Date.now() + 5
    while (Date.now() < until) {
      /* spin */
    }
    markSessionRunning()
    const second = fs.readFileSync(sentinelPath(), "utf8")
    // Both writes succeeded; pid stable; timestamps may differ.
    const firstParsed = JSON.parse(first) as { pid: number }
    const secondParsed = JSON.parse(second) as { pid: number }
    expect(secondParsed.pid).toBe(firstParsed.pid)
    expect(staleSessionMarkerPresent()).toBe(true)
  })

  test("markSessionRunning creates the APP_DIR if missing", () => {
    // Remove the tmp dir; markSessionRunning should mkdir-p before writing.
    fs.rmSync(tmp, { recursive: true, force: true })
    expect(fs.existsSync(tmp)).toBe(false)
    markSessionRunning()
    expect(fs.existsSync(tmp)).toBe(true)
    expect(fs.existsSync(sentinelPath())).toBe(true)
  })

  test("markSessionRunning swallows write errors (best-effort)", () => {
    // Point APP_DIR at a path that's a file, not a directory — mkdirSync
    // throws ENOTDIR / EEXIST. The helper must catch it.
    const wrongPath = path.join(tmp, "not-a-dir")
    fs.writeFileSync(wrongPath, "occupied")
    ;(PATHS as { APP_DIR: string }).APP_DIR = wrongPath
    expect(() => markSessionRunning()).not.toThrow()
    // Sentinel didn't land (couldn't), and presence reports false.
    expect(staleSessionMarkerPresent()).toBe(false)
  })
})

describe("crash-detection contract (the user-facing invariant)", () => {
  test("graceful: mark then clear leaves no stale marker for the next run", () => {
    markSessionRunning()
    clearSessionRunning()
    // Next "run" sees: no stale marker.
    expect(staleSessionMarkerPresent()).toBe(false)
  })

  test("ungraceful: mark without clear leaves a stale marker the next run sees", () => {
    markSessionRunning()
    // Simulate a crash: no clearSessionRunning() call before "next boot".
    // Next "run" sees: stale marker present.
    expect(staleSessionMarkerPresent()).toBe(true)
  })
})
