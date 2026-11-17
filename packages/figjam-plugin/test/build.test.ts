import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { Script } from "node:vm"

import {
  buildPlugin,
  readPackageVersion,
  renderPlugin,
  stampPanel,
  stampVersion,
} from "../scripts/build"

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
      devAllowedDomains: ["http://localhost:4141", "ws://localhost:4141"],
    })
  })

  test("release manifest drops the dev marker and honours custom ports (a standalone bridge adds its own socket)", async () => {
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
      devAllowedDomains: [
        "http://localhost:5141",
        "ws://localhost:5141",
        "ws://localhost:5150",
      ],
    })
  })
})

const panelBuild = (html: string): Record<string, unknown> => {
  const line = /^const PANEL_BUILD = (.*);$/m.exec(html)?.[1]
  if (line === undefined) throw new Error("no PANEL_BUILD line")
  return JSON.parse(line) as Record<string, unknown>
}

describe("panel build line and profiles", () => {
  test("ui.html carries the ports, profile and dev flag it was built with", async () => {
    const files = await renderPlugin({
      maximalPort: 52_001,
      bridgePort: 4153,
      profile: "ab12cd34ef56",
    })
    expect(panelBuild(files["ui.html"])).toEqual({
      maximalPort: 52_001,
      bridgePort: 4153,
      profile: "ab12cd34ef56",
      dev: true,
    })
  })

  test("the panel discovers the bridge instead of hard-coding its port", async () => {
    const { "ui.html": html } = await renderPlugin({})
    expect(html).toContain("/figjam/bridge.json")
    expect(html).not.toMatch(/ws:\/\/localhost:4150/)
    expect(html).not.toMatch(/localhost:4150/)
  })

  test("the panel's script parses", async () => {
    const { "ui.html": html } = await renderPlugin({})
    const script = /<script>([\s\S]*)<\/script>/.exec(html)?.[1]
    expect(script).toBeDefined()
    expect(() => new Script(script ?? "")).not.toThrow()
  })

  test("a release build is quiet and profile-less", async () => {
    const files = await renderPlugin({ release: true, profile: "ab12cd34ef56" })
    expect(panelBuild(files["ui.html"])).toMatchObject({
      profile: "",
      dev: false,
    })
  })

  test("a profile gives the dev plugin its own id and name; none keeps the shared one", async () => {
    const shared = JSON.parse(
      (await renderPlugin({}))["manifest.json"],
    ) as Record<string, unknown>
    expect(shared).toMatchObject({
      id: "maximal-figjam-agent-dev",
      name: "Maximal Agent (dev)",
    })
    const first = JSON.parse(
      (await renderPlugin({ profile: "ab12cd34ef56" }))["manifest.json"],
    ) as Record<string, unknown>
    const second = JSON.parse(
      (await renderPlugin({ profile: "0f0f0f0f0f0f" }))["manifest.json"],
    ) as Record<string, unknown>
    expect(first.id).toBe("maximal-figjam-agent-dev-ab12cd34ef56")
    expect(first.name).toBe("Maximal Agent (dev ab12cd34)")
    expect(second.id).not.toBe(first.id)
  })

  test("a malformed profile id is refused, and the panel needs exactly one build line", async () => {
    const refused = await renderPlugin({ profile: "../x" }).catch(
      (error: unknown) => error,
    )
    expect(String(refused)).toContain("lowercase letters")
    expect(() =>
      stampPanel("<script>1</script>", {
        release: false,
        maximalPort: 4141,
        bridgePort: 4150,
        profile: "",
      }),
    ).toThrow("found 0")
  })

  test("rendering is deterministic, so a folder can be compared with it", async () => {
    expect(await renderPlugin({ bridgePort: 4152 })).toEqual(
      await renderPlugin({ bridgePort: 4152 }),
    )
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
    "security.mjs",
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
