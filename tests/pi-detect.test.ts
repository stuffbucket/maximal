import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import { detectPiInstallations } from "~/apps/pi/detect"

describe("Pi installation discovery", () => {
  let directory: string
  beforeEach(() => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), "pi-detect-"))
  })
  afterEach(() => {
    fs.rmSync(directory, { recursive: true, force: true })
  })
  function options() {
    return {
      homeDir: directory,
      pathEnv: path.join(directory, "bin"),
      appDataDir: path.join(directory, "appdata"),
      platform: "linux" as const,
    }
  }
  function installation(
    root: string,
    name = "@earendil-works/pi-coding-agent",
    bin = "pi",
  ) {
    fs.mkdirSync(root, { recursive: true })
    const binary = path.join(root, bin)
    fs.mkdirSync(path.dirname(binary), { recursive: true })
    fs.writeFileSync(
      binary,
      `#!/bin/sh\ntouch '${path.join(directory, "executed")}'\n`,
      { mode: 0o755 },
    )
    fs.writeFileSync(
      path.join(root, "package.json"),
      JSON.stringify({ name, version: "1.5.2", bin: { pi: bin } }),
    )
    return binary
  }
  test("rejects a coincidentally named pi without executing it", () => {
    const binary = installation(
      path.join(directory, "bin"),
      "unrelated-package",
    )
    expect(fs.existsSync(binary)).toBe(true)
    expect(detectPiInstallations(options())).toEqual([])
    expect(fs.existsSync(path.join(directory, "executed"))).toBe(false)
  })
  test("identifies a native distribution and a symlinked npm package, deduplicating by target", () => {
    const root = path.join(directory, "package")
    const binary = installation(root, undefined, "dist/cli.js")
    fs.mkdirSync(path.join(directory, "bin"))
    fs.symlinkSync(binary, path.join(directory, "bin", "pi"))
    const found = detectPiInstallations({
      ...options(),
      pathEnv: [path.join(directory, "bin"), path.join(directory, "bin")].join(
        ":",
      ),
    })
    expect(found).toEqual([{ path: fs.realpathSync(binary), version: "1.5.2" }])
    expect(fs.existsSync(path.join(directory, "executed"))).toBe(false)
  })
  test("finds mise distributions without executing their shims", () => {
    const binary = installation(
      path.join(
        directory,
        ".local",
        "share",
        "mise",
        "installs",
        "pi",
        "1.5.2",
        "pi",
      ),
    )
    expect(detectPiInstallations(options())).toEqual([
      { path: binary, version: "1.5.2" },
    ])
  })
  test("handles Windows npm manifests instead of running cmd wrappers", () => {
    const npm = path.join(directory, "appdata", "npm")
    const binary = installation(
      path.join(npm, "node_modules", "@earendil-works", "pi-coding-agent"),
      undefined,
      "dist/cli.js",
    )
    expect(detectPiInstallations({ ...options(), platform: "win32" })).toEqual([
      { path: binary, version: "1.5.2" },
    ])
  })
  test("rechecks changed manifests and tolerates malformed metadata", () => {
    const root = path.join(directory, "bin")
    installation(root)
    expect(detectPiInstallations(options()).length).toBe(1)
    fs.writeFileSync(path.join(root, "package.json"), "{invalid}")
    expect(detectPiInstallations(options())).toEqual([])
  })
})
