/**
 * The sidecar's boot-status channel: structured lines the Tauri shell relays
 * to its splash window. Must be silent for plain CLI users (gated on the
 * shell-set parent-pid env) and well-formed when active, since the Rust side
 * matches the marker prefix exactly.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test"

import { BOOT_STATUS_MARKER, emitBootStatus } from "~/start"

const PRIOR = process.env.MAXIMAL_SIDECAR_PARENT_PID
let writes: Array<string>
let restoreWrite: () => void

beforeEach(() => {
  writes = []
  const original = process.stdout.write.bind(process.stdout)
  // Capture writes without letting the marker leak into test output.
  process.stdout.write = (chunk: unknown): boolean => {
    writes.push(String(chunk))
    return true
  }
  restoreWrite = () => {
    process.stdout.write = original
  }
})

afterEach(() => {
  restoreWrite()
  if (PRIOR === undefined) delete process.env.MAXIMAL_SIDECAR_PARENT_PID
  else process.env.MAXIMAL_SIDECAR_PARENT_PID = PRIOR
})

describe("emitBootStatus", () => {
  test("is a no-op for plain CLI users (no parent-pid env)", () => {
    delete process.env.MAXIMAL_SIDECAR_PARENT_PID
    emitBootStatus("Taking over port 4141…")
    expect(writes).toHaveLength(0)
  })

  test("emits a marker-prefixed line when run as the shell sidecar", () => {
    process.env.MAXIMAL_SIDECAR_PARENT_PID = "12345"
    emitBootStatus("Connecting to GitHub Copilot…")
    expect(writes).toHaveLength(1)
    expect(writes[0]).toBe(
      `${BOOT_STATUS_MARKER} Connecting to GitHub Copilot…\n`,
    )
    // The Rust relay strips exactly this prefix + one space.
    expect(writes[0].startsWith(`${BOOT_STATUS_MARKER} `)).toBe(true)
    expect(writes[0].endsWith("\n")).toBe(true)
  })
})
