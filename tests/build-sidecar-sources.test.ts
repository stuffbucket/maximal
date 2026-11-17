import { afterEach, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"

import { packageSources } from "../scripts/build-sidecar-sources"

const roots: Array<string> = []

afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true })
})

function packagesDir(layout: Record<string, Array<string>>): string {
  const root = mkdtempSync(path.join(os.tmpdir(), "sidecar-sources-"))
  roots.push(root)
  for (const [name, entries] of Object.entries(layout)) {
    for (const entry of entries) {
      const target = path.join(root, name, entry)
      if (entry.endsWith(".json")) {
        mkdirSync(path.dirname(target), { recursive: true })
        writeFileSync(target, "{}")
      } else {
        mkdirSync(target, { recursive: true })
      }
    }
  }
  return root
}

describe("packageSources", () => {
  test("watches the plugin, figjam and connector-kit workspaces, and nothing else", () => {
    const root = packagesDir({
      "plugin-figjam": ["src", "package.json"],
      "figjam-bridge": ["src", "package.json"],
      "figjam-plugin": ["src", "scripts", "package.json"],
      "connector-kit": ["src", "package.json"],
      storybook: ["src", "package.json"],
    })
    const watched = packageSources(root).map((file) =>
      path.relative(root, file),
    )
    expect(watched.toSorted()).toEqual(
      [
        "connector-kit/package.json",
        "connector-kit/src",
        "figjam-bridge/package.json",
        "figjam-bridge/src",
        "figjam-plugin/package.json",
        "figjam-plugin/scripts",
        "figjam-plugin/src",
        "plugin-figjam/package.json",
        "plugin-figjam/src",
      ].toSorted(),
    )
  })

  test("skips what a package doesn't have, so it never reads as always changed", () => {
    const root = packagesDir({ "figjam-layout": ["src"] })
    expect(
      packageSources(root).map((file) => path.relative(root, file)),
    ).toEqual(["figjam-layout/src"])
  })

  test("a missing packages folder watches nothing", () => {
    expect(packageSources("/nonexistent/packages")).toEqual([])
  })

  test("the real repo watches the FigJam plugin build and its embedded sources", () => {
    const watched = packageSources(path.resolve(import.meta.dir, "../packages"))
    const relative = watched.map((file) =>
      path.relative(path.resolve(import.meta.dir, ".."), file),
    )
    expect(relative).toContain("packages/figjam-plugin/src")
    expect(relative).toContain("packages/figjam-plugin/scripts")
    expect(relative).toContain("packages/figjam-bridge/src")
    expect(relative).toContain("packages/plugin-figjam/src")
  })
})
