import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"

import { buildPlugin, readPackageVersion, stampVersion } from "../scripts/build"

let outDir: string

beforeAll(async () => {
  outDir = await mkdtemp(path.join(os.tmpdir(), "figjam-plugin-"))
  await buildPlugin({ outDir })
})

afterAll(async () => {
  await rm(outDir, { recursive: true, force: true })
})

describe("build", () => {
  test("writes code.js, ui.html and manifest.json", async () => {
    expect((await readdir(outDir)).sort()).toEqual([
      "code.js",
      "manifest.json",
      "ui.html",
    ])
  })

  test("stamps the package version into code.js", async () => {
    const code = await readFile(path.join(outDir, "code.js"), "utf8")
    expect(code).toContain(
      `var PLUGIN_VERSION = ${JSON.stringify(await readPackageVersion())}`,
    )
  })

  test("refuses a source without exactly one version line", () => {
    expect(() => stampVersion("var x = 1", "1.0.0")).toThrow("found 0")
  })

  test("dev manifest is FigJam-only and reaches only Maximal, the bridge and Figma's API", async () => {
    const manifest = JSON.parse(
      await readFile(path.join(outDir, "manifest.json"), "utf8"),
    ) as Record<string, unknown>
    expect(manifest.id).toBe("maximal-figjam-agent-dev")
    expect(manifest.editorType).toEqual(["figjam"])
    expect(manifest.networkAccess).toMatchObject({
      allowedDomains: ["https://api.figma.com"],
      devAllowedDomains: ["http://localhost:4141", "ws://localhost:4150"],
    })
  })

  test("release manifest drops the dev marker and honours custom ports", async () => {
    const releaseDir = path.join(outDir, "release")
    await buildPlugin({
      outDir: releaseDir,
      release: true,
      maximalPort: 5141,
      bridgePort: 5150,
    })
    const manifest = JSON.parse(
      await readFile(path.join(releaseDir, "manifest.json"), "utf8"),
    ) as Record<string, unknown>
    expect(manifest.name).toBe("Maximal Agent")
    expect(manifest.id).toBe("maximal-figjam-agent")
    expect(manifest.networkAccess).toMatchObject({
      allowedDomains: ["https://api.figma.com"],
      devAllowedDomains: ["http://localhost:5141", "ws://localhost:5150"],
    })
  })
})

// The sandbox checks run the built code.js against a stubbed `figma` global,
// each in its own process because they install globals and exit when done.
// They run under Node: Bun's `vm` doesn't keep a context's top-level `var`
// bindings in sync with the context object, which pages.mjs relies on.
describe("sandbox", () => {
  const sandboxDir = path.join(import.meta.dir, "sandbox")
  for (const file of [
    "core.mjs",
    "context-menu.mjs",
    "pages.mjs",
    "ramp.mjs",
    "toolbar.mjs",
    "comments.mjs",
  ]) {
    test(file, () => {
      const run = Bun.spawnSync(
        ["node", path.join(sandboxDir, file), path.join(outDir, "code.js")],
        { stdout: "pipe", stderr: "pipe" },
      )
      const output = `${run.stdout.toString()}${run.stderr.toString()}`
      expect(run.exitCode, output).toBe(0)
    })
  }
})
