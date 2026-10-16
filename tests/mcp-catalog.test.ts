/**
 * The MCP server catalog: finding Work IQ's native executable wherever a
 * package manager put it, without relying on the caller's PATH resolving
 * `workiq` (a GUI-launched Maximal doesn't have the user's shell PATH).
 *
 * Every probe is injected (home, PATH, npm prefix, mise dir), so nothing
 * on this machine is read.
 */

import { afterAll, describe, expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import { listMcpCatalog, refreshCatalogCommands } from "~/apps/mcp"
import { getConfig, writeConfig } from "~/lib/config/config"
import { findCatalogEntry } from "~/lib/mcp-broker/catalog"

const root = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-catalog-"))
let counter = 0
function tempDir(): string {
  const dir = path.join(root, String(counter++))
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

/** Lay down an `@microsoft/workiq` package with its macOS arm64 executable. */
function workiqPackage(packageDir: string, version: string): string {
  const bin = path.join(packageDir, "bin", "osx-arm64")
  fs.mkdirSync(bin, { recursive: true })
  fs.writeFileSync(
    path.join(packageDir, "package.json"),
    JSON.stringify({ name: "@microsoft/workiq", version }),
  )
  fs.writeFileSync(path.join(packageDir, "bin", "workiq.js"), "")
  const executable = path.join(bin, "workiq")
  fs.writeFileSync(executable, "#!/bin/sh\n")
  fs.chmodSync(executable, 0o755)
  return executable
}

function miseInstall(miseDir: string, version: string): string {
  return workiqPackage(
    path.join(
      miseDir,
      "installs",
      "npm-microsoft-workiq",
      version,
      "node_modules",
      "@microsoft",
      "workiq",
    ),
    version,
  )
}

const workiq = findCatalogEntry("workiq")
if (!workiq) throw new Error("Work IQ missing from the catalog")

const base = {
  homeDir: "/nonexistent-home",
  pathDirs: [] as Array<string>,
  npmPrefix: null,
  platform: "darwin" as const,
  arch: "arm64",
}

afterAll(() => {
  fs.rmSync(root, { recursive: true, force: true })
  writeConfig({})
})

describe("Work IQ locate", () => {
  test("finds the native executable in a mise install, not the shim", () => {
    const mise = tempDir()
    const executable = miseInstall(mise, "1.0.1")
    expect(workiq.locate({ ...base, miseDataDir: mise })).toEqual({
      command: executable,
      version: "1.0.1",
    })
  })

  test("prefers the newest mise version", () => {
    const mise = tempDir()
    miseInstall(mise, "0.9.0")
    const newest = miseInstall(mise, "1.10.0")
    miseInstall(mise, "1.2.0")
    expect(workiq.locate({ ...base, miseDataDir: mise })?.command).toBe(newest)
  })

  test("follows npm's global bin symlink on PATH into the package", () => {
    const prefix = tempDir()
    const packageDir = path.join(
      prefix,
      "lib",
      "node_modules",
      "@microsoft",
      "workiq",
    )
    const executable = workiqPackage(packageDir, "1.0.1")
    const binDir = path.join(prefix, "bin")
    fs.mkdirSync(binDir)
    fs.symlinkSync(
      path.join(packageDir, "bin", "workiq.js"),
      path.join(binDir, "workiq"),
    )
    expect(
      workiq.locate({ ...base, miseDataDir: tempDir(), pathDirs: [binDir] })
        ?.command,
    ).toBe(fs.realpathSync(executable))
  })

  test("finds a global npm install from the npm prefix", () => {
    const prefix = tempDir()
    const executable = workiqPackage(
      path.join(prefix, "lib", "node_modules", "@microsoft", "workiq"),
      "1.0.1",
    )
    expect(
      workiq.locate({ ...base, miseDataDir: tempDir(), npmPrefix: prefix })
        ?.command,
    ).toBe(executable)
  })

  test("not found: nothing installed, or no executable for this platform", () => {
    expect(workiq.locate({ ...base, miseDataDir: tempDir() })).toBeUndefined()
    const mise = tempDir()
    miseInstall(mise, "1.0.1")
    expect(
      workiq.locate({
        ...base,
        miseDataDir: mise,
        platform: "linux",
        arch: "x64",
      }),
    ).toBeUndefined()
  })

  test("the endpoint it writes runs the executable directly, off", () => {
    const server = workiq.template({ command: "/abs/workiq", version: "1.0.1" })
    expect(server).toMatchObject({
      id: "workiq",
      enabled: false,
      catalog: "workiq",
      transport: { type: "stdio", command: "/abs/workiq", args: ["mcp"] },
      classification: { ownership: "exclusive" },
    })
  })
})

describe("Work IQ locate across install methods", () => {
  test("picks the highest version, wherever it was installed", () => {
    const mise = tempDir()
    miseInstall(mise, "1.0.1")
    const prefix = tempDir()
    const npmNewer = workiqPackage(
      path.join(prefix, "lib", "node_modules", "@microsoft", "workiq"),
      "1.2.0",
    )
    expect(
      workiq.locate({ ...base, miseDataDir: mise, npmPrefix: prefix })?.command,
    ).toBe(npmNewer)
  })
})

describe("listMcpCatalog", () => {
  test("offers catalog servers not added yet, with their status", () => {
    const mise = tempDir()
    const executable = miseInstall(mise, "1.0.1")
    const options = { ...base, miseDataDir: mise }
    const found = listMcpCatalog({}, options)
    expect(found).toHaveLength(1)
    expect(found[0]).toMatchObject({
      id: "workiq",
      status: "ready",
      command: executable,
      version: "1.0.1",
    })
    const missing = listMcpCatalog({}, { ...base, miseDataDir: tempDir() })
    expect(missing).toHaveLength(1)
    expect(missing[0]).toMatchObject({ id: "workiq", status: "not-installed" })
    const added = {
      mcpBroker: {
        servers: [workiq.template({ command: executable, version: null })],
      },
    }
    expect(listMcpCatalog(added, options)).toEqual([])
  })
})

describe("refreshCatalogCommands", () => {
  test("re-finds a catalog server whose executable moved, and saves it", () => {
    const mise = tempDir()
    const moved = miseInstall(mise, "1.1.0")
    writeConfig({
      mcpBroker: {
        servers: [
          workiq.template({
            command: path.join(mise, "gone", "workiq"),
            version: null,
          }),
        ],
      },
    })
    const next = refreshCatalogCommands(getConfig(), {
      ...base,
      miseDataDir: mise,
    })
    expect(next.mcpBroker?.servers?.[0]?.transport.command).toBe(moved)
    expect(getConfig().mcpBroker?.servers?.[0]?.transport.command).toBe(moved)
  })

  test("switches to a newer install even while the old one is still there", () => {
    const mise = tempDir()
    const old = miseInstall(mise, "0.4.0")
    const newer = miseInstall(mise, "1.0.1")
    writeConfig({
      mcpBroker: {
        servers: [workiq.template({ command: old, version: "0.4.0" })],
      },
    })
    refreshCatalogCommands(getConfig(), { ...base, miseDataDir: mise })
    expect(getConfig().mcpBroker?.servers?.[0]?.transport.command).toBe(newer)
  })

  test("keeps the last path when the server was uninstalled", () => {
    writeConfig({
      mcpBroker: {
        servers: [workiq.template({ command: "/gone/workiq", version: null })],
      },
    })
    const before = getConfig()
    expect(
      refreshCatalogCommands(before, { ...base, miseDataDir: tempDir() }),
    ).toBe(before)
  })

  test("leaves the newest install and non-catalog servers alone", () => {
    const mise = tempDir()
    const executable = miseInstall(mise, "1.0.1")
    writeConfig({
      mcpBroker: {
        servers: [
          workiq.template({ command: executable, version: null }),
          {
            id: "custom",
            label: "Custom",
            transport: { type: "stdio", command: "/gone/custom" },
          },
        ],
      },
    })
    const before = getConfig()
    expect(refreshCatalogCommands(before, { ...base, miseDataDir: mise })).toBe(
      before,
    )
  })
})
