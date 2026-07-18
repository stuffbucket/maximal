/**
 * The sidecar's boot-status channel: structured lines the Tauri shell relays
 * to its splash window. Must be silent for plain CLI users (gated on the
 * shell-set parent-pid env) and well-formed when active, since the Rust side
 * matches the marker prefix exactly.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { resolve } from "node:path"

import {
  emitUpdateRequest,
  UPDATE_REQUEST_MARKER,
} from "~/lib/start/boot-status"
import { BOOT_STATUS_MARKER, emitBootStatus } from "~/start"

const SHELL_LIB_RS = resolve(
  import.meta.dir,
  "..",
  "shell",
  "src-tauri",
  "src",
  "lib.rs",
)

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

describe("emitUpdateRequest", () => {
  test("is a no-op for plain CLI users (no updatable app bundle)", () => {
    delete process.env.MAXIMAL_SIDECAR_PARENT_PID
    expect(emitUpdateRequest()).toBe(false)
    expect(writes).toHaveLength(0)
  })

  test("emits the bare marker line and reports a shell is present", () => {
    process.env.MAXIMAL_SIDECAR_PARENT_PID = "12345"
    expect(emitUpdateRequest()).toBe(true)
    expect(writes).toHaveLength(1)
    expect(writes[0]).toBe(`${UPDATE_REQUEST_MARKER}\n`)
  })
})

describe("boot-status marker cross-boundary invariant", () => {
  // The splash's live status is carried over a plain-text stdout protocol:
  // the sidecar (TS) prints `<marker> <message>` lines, the shell (Rust)
  // strips `<marker> ` to relay them. The marker is a string literal
  // duplicated in two languages with a "MUST match" comment on each side
  // and no compiler that spans the boundary. If they drift, the splash
  // silently goes dark (every line fails the prefix strip) and a slow or
  // failed launch shows a blank "Starting…" with no clue why. Pin the Rust
  // literal to the TS constant so a one-sided edit fails CI instead of the
  // user's first launch.
  test("Rust BOOT_STATUS_MARKER literal equals the TS constant", () => {
    const rust = readFileSync(SHELL_LIB_RS, "utf8")
    const match = rust.match(
      /const\s+BOOT_STATUS_MARKER\s*:\s*&str\s*=\s*"([^"]*)"\s*;/,
    )
    expect(
      match,
      'could not find `const BOOT_STATUS_MARKER: &str = "…";` in shell/src-tauri/src/lib.rs',
    ).not.toBeNull()
    expect(match?.[1]).toBe(BOOT_STATUS_MARKER)
  })

  // Same cross-boundary hazard for the in-place self-update signal: the browser
  // tab POSTs /_internal/upgrade, the sidecar (TS) prints this bare marker, and
  // the shell (Rust) matches it EXACTLY (`trimmed == UPDATE_REQUEST_MARKER`) to
  // run the signed install. A one-sided edit would silently break "Upgrade"
  // (the shell never sees the request) — pin the Rust literal to the TS constant.
  test("Rust UPDATE_REQUEST_MARKER literal equals the TS constant", () => {
    const rust = readFileSync(SHELL_LIB_RS, "utf8")
    const match = rust.match(
      /const\s+UPDATE_REQUEST_MARKER\s*:\s*&str\s*=\s*"([^"]*)"\s*;/,
    )
    expect(
      match,
      'could not find `const UPDATE_REQUEST_MARKER: &str = "…";` in shell/src-tauri/src/lib.rs',
    ).not.toBeNull()
    expect(match?.[1]).toBe(UPDATE_REQUEST_MARKER)
  })
})
