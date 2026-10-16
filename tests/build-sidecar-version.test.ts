import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { resolve } from "node:path"

import { resolveSidecarVersion } from "../scripts/build-sidecar-version"

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
