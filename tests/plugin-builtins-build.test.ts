import { describe, expect, test } from "bun:test"
import { mkdtemp, rm, stat } from "node:fs/promises"
import os from "node:os"
import path from "node:path"

import {
  currentPluginGenerationBuild,
  selectPackagedBuiltInGeneration,
} from "~/lib/plugins/generations"

import { buildPluginBuiltIns } from "../scripts/build-plugin-builtins"

const EXPECTED_PLUGINS = [
  "decisions",
  "figjam",
  "images",
  "systemone",
  "workiq",
]

describe("packaged built-in plugin generation", () => {
  test("builds, commits, and selects the complete sealed inventory", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "maximal-builtins-"))
    const output = path.join(root, "plugin-builtins")
    const build = currentPluginGenerationBuild()
    try {
      await buildPluginBuiltIns({
        output,
        version: build.maximal,
        channel: "test",
        gitSha: "test-sha",
        runtime: build.runtime,
        platform: build.platform,
        architecture: build.architecture,
      })
      const selected = await selectPackagedBuiltInGeneration(output)
      expect(selected).toBeDefined()
      if (!selected) throw new Error("Expected a packaged generation.")
      const manifestPath = path.join(selected.directory, "manifest.json")
      const manifest = (await Bun.file(manifestPath).json()) as {
        modules: Array<{ artifact: string; pluginId: string }>
      }
      expect(manifest.modules.map((module) => module.pluginId).sort()).toEqual(
        EXPECTED_PLUGINS,
      )
      if (process.platform !== "win32") {
        for (const sealedPath of [
          manifestPath,
          ...manifest.modules.map((module) =>
            path.join(selected.directory, module.artifact),
          ),
        ]) {
          expect((await stat(sealedPath)).mode & 0o222).toBe(0)
        }
      }
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  }, 30_000)
})
