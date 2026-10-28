import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { resolve } from "node:path"

import {
  resolveSidecarChannel,
  resolveSidecarVersion,
} from "../scripts/build-sidecar-version"

const BUILD_SCRIPT = readFileSync(
  resolve(import.meta.dir, "../scripts/build-sidecar.ts"),
  "utf8",
)

describe("sidecar build version", () => {
  test("uses the exact explicit release version", () => {
    expect(resolveSidecarVersion("0.4.41", "7aa751bb", "0.4.42")).toBe("0.4.42")
  })

  test("keeps commit-qualified versions for local builds", () => {
    expect(resolveSidecarVersion("0.4.41", "7aa751bb")).toBe(
      "0.4.41-dev+7aa751bb",
    )
  })

  test("uses unknown when a local build has no commit", () => {
    expect(resolveSidecarVersion("0.4.41", "")).toBe("0.4.41-dev+unknown")
  })

  test("builds the isolated MCP broker for Tauri", () => {
    expect(BUILD_SCRIPT).toContain("packages/mcp-broker")
    expect(BUILD_SCRIPT).toContain("maximal-mcp-broker-${triple}")
    expect(BUILD_SCRIPT).toContain('join(BROKER_PACKAGE, "src/main.ts")')
  })
})

// The macOS app's sidecar is built by .macos-builder/build.sh, which sets
// MAXIMAL_VERSION but not MAXIMAL_CHANNEL; v0.5.0-rc.1 and rc.2 shipped
// polling the stable channel and never saw each other.
describe("sidecar build channel", () => {
  test("follows the prerelease label of an explicit release version", () => {
    expect(resolveSidecarChannel("0.5.0-rc.2")).toBe("rc")
    expect(resolveSidecarChannel("0.4.33-beta.1")).toBe("beta")
  })

  test("is stable for a plain release version", () => {
    expect(resolveSidecarChannel("0.5.0")).toBe("stable")
  })

  test("is stable for a local build with no explicit version", () => {
    expect(resolveSidecarChannel(undefined)).toBe("stable")
  })

  test("an explicit channel wins", () => {
    expect(resolveSidecarChannel("0.5.0-rc.2", "beta")).toBe("beta")
  })

  test("the build script uses it rather than defaulting to stable", () => {
    expect(BUILD_SCRIPT).toContain("resolveSidecarChannel(")
    expect(BUILD_SCRIPT).not.toContain(
      'process.env.MAXIMAL_CHANNEL || "stable"',
    )
  })
})
