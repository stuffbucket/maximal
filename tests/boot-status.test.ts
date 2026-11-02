/**
 * The sidecar's boot-status channel: structured lines the Tauri shell relays
 * to its splash window. Must be silent for plain CLI users (gated on the
 * shell-set parent-pid env) and well-formed when active, since the Rust side
 * matches the marker prefix exactly.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { resolve } from "node:path"

import { emitSidecarReady, READY_MARKER } from "~/lib/start/boot-io"
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
const PRIOR_INSTANCE_ID = process.env.MAXIMAL_INSTANCE_ID
const PRIOR_INSTANCE_NONCE = process.env.MAXIMAL_INSTANCE_NONCE
let writes: Array<string>
let restoreWrite: () => void

beforeEach(() => {
  writes = []
  delete process.env.MAXIMAL_INSTANCE_ID
  delete process.env.MAXIMAL_INSTANCE_NONCE
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
  if (PRIOR_INSTANCE_ID === undefined) delete process.env.MAXIMAL_INSTANCE_ID
  else process.env.MAXIMAL_INSTANCE_ID = PRIOR_INSTANCE_ID
  if (PRIOR_INSTANCE_NONCE === undefined) {
    delete process.env.MAXIMAL_INSTANCE_NONCE
  } else {
    process.env.MAXIMAL_INSTANCE_NONCE = PRIOR_INSTANCE_NONCE
  }
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

describe("emitSidecarReady", () => {
  test("is silent without a complete shell handshake", () => {
    emitSidecarReady(42_123)
    process.env.MAXIMAL_INSTANCE_ID = "desktop-instance"
    emitSidecarReady(42_123)

    expect(writes).toHaveLength(0)
  })

  test("emits one marker-prefixed JSON line with the actual listener", () => {
    process.env.MAXIMAL_INSTANCE_ID = "desktop-instance"
    process.env.MAXIMAL_INSTANCE_NONCE = "launch-nonce"

    emitSidecarReady(42_123)

    expect(writes).toHaveLength(1)
    expect(writes[0]).toBe(
      `${READY_MARKER}{"protocol":1,"host":"127.0.0.1","port":42123,"instanceId":"desktop-instance","nonce":"launch-nonce"}\n`,
    )
  })
})

describe("sidecar marker cross-boundary invariants", () => {
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

  test("Rust READY_MARKER literal equals the TS constant", () => {
    const rust = readFileSync(SHELL_LIB_RS, "utf8")
    const match = rust.match(
      /const\s+READY_MARKER\s*:\s*&str\s*=\s*"([^"]*)"\s*;/,
    )
    expect(
      match,
      'could not find `const READY_MARKER: &str = "…";` in shell/src-tauri/src/lib.rs',
    ).not.toBeNull()
    expect(match?.[1]).toBe(READY_MARKER)
  })
})
