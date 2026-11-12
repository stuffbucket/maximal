import { describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
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
      const manifest = (await Bun.file(
        path.join(selected.directory, "manifest.json"),
      ).json()) as {
        modules: Array<{ pluginId: string }>
      }
      expect(manifest.modules.map((module) => module.pluginId).sort()).toEqual(
        EXPECTED_PLUGINS,
      )
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  }, 30_000)
})
