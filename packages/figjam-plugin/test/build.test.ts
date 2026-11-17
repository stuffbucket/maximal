import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test"
import {
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from "node:fs/promises"
import os from "node:os"
import path from "node:path"

import {
  buildPlugin,
  inspectPlugin,
  readPackageVersion,
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

describe("freshness", () => {
  let dir: string
  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), "figjam-plugin-fresh-"))
  })
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  test("is missing before a build, current after, and stale on any byte change", async () => {
    expect(await inspectPlugin(dir, {})).toBe("missing")
    await buildPlugin({ outDir: dir })
    expect(await inspectPlugin(dir, {})).toBe("current")
    for (const name of ["code.js", "ui.html", "manifest.json"]) {
      const file = path.join(dir, name)
      const original = await readFile(file, "utf8")
      await writeFile(file, `${original} `)
      expect(await inspectPlugin(dir, {}), name).toBe("stale")
      await writeFile(file, original)
      expect(await inspectPlugin(dir, {}), name).toBe("current")
    }
  })

  test("a missing managed file is stale, and ports are part of the content", async () => {
    await buildPlugin({ outDir: dir, maximalPort: 5141, bridgePort: 5150 })
    expect(
      await inspectPlugin(dir, { maximalPort: 5141, bridgePort: 5150 }),
    ).toBe("current")
    expect(
      await inspectPlugin(dir, { maximalPort: 5141, bridgePort: 5151 }),
    ).toBe("stale")
    await rm(path.join(dir, "ui.html"))
    expect(
      await inspectPlugin(dir, { maximalPort: 5141, bridgePort: 5150 }),
    ).toBe("stale")
  })

  test("files outside the managed set are ignored, and a build leaves no temp files", async () => {
    await buildPlugin({ outDir: dir })
    await writeFile(path.join(dir, "notes.txt"), "mine")
    expect(await inspectPlugin(dir, {})).toBe("current")
    expect((await readdir(dir)).sort()).toEqual([
      "code.js",
      "manifest.json",
      "notes.txt",
      "ui.html",
    ])
  })
})

const MANAGED = ["code.js", "ui.html", "manifest.json"]
const LEFTOVER = /\.(?:tmp|undo)$/

async function snapshot(dir: string): Promise<Record<string, string>> {
  return Object.fromEntries(
    await Promise.all(
      MANAGED.map(
        async (name) =>
          [name, await readFile(path.join(dir, name), "utf8")] as const,
      ),
    ),
  )
}

async function leftovers(dir: string): Promise<Array<string>> {
  return (await readdir(dir)).filter((name) => LEFTOVER.test(name))
}

/**
 * File operations whose `failAt`th rename (1-based) throws. With `persist`
 * every later rename fails too (so a rollback fails as well), and `removal`
 * makes every removal throw.
 */
function failingOps(
  failAt: number,
  options: { persist?: boolean; removal?: Error } = {},
) {
  let calls = 0
  return {
    rename: async (from: string, to: string) => {
      calls++
      if (calls === failAt || (options.persist && calls > failAt)) {
        throw new Error("rename failed")
      }
      await rename(from, to)
    },
    rm: async (file: string) => {
      if (options.removal) throw options.removal
      await rm(file, { force: true })
    },
  }
}

async function caught(run: Promise<unknown>): Promise<unknown> {
  return run.then(
    () => undefined,
    (error: unknown) => error,
  )
}

describe("rollback", () => {
  let dir: string
  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), "figjam-plugin-undo-"))
  })
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  test("a failure after one rename restores every previous file", async () => {
    await buildPlugin({ outDir: dir, maximalPort: 4141, bridgePort: 4150 })
    // Previous generation: differs from the new build in all three files.
    const code = await readFile(path.join(dir, "code.js"), "utf8")
    await writeFile(path.join(dir, "code.js"), `${code}\n// previous`)
    await writeFile(path.join(dir, "ui.html"), "<!-- previous -->")
    const before = await snapshot(dir)

    // The first rename (code.js) succeeds; the second (ui.html) throws.
    const error = await caught(
      buildPlugin(
        { outDir: dir, maximalPort: 5141, bridgePort: 5150 },
        failingOps(2),
      ),
    )
    expect((error as Error).message).toBe("rename failed")
    expect(await snapshot(dir)).toEqual(before)
    expect(await leftovers(dir)).toEqual([])
  })

  test("a failure removes files that did not exist before", async () => {
    const error = await caught(buildPlugin({ outDir: dir }, failingOps(3)))
    expect((error as Error).message).toBe("rename failed")
    expect(await readdir(dir)).toEqual([])
  })

  test("a failing rollback or cleanup does not replace the original error", async () => {
    await buildPlugin({ outDir: dir, maximalPort: 4141 })
    const eperm = Object.assign(new Error("EPERM: busy"), { code: "EPERM" })
    // Every rename after the first fails (so the restore does too) and every
    // removal throws.
    const error = await caught(
      buildPlugin(
        { outDir: dir, maximalPort: 5141 },
        failingOps(2, { persist: true, removal: eperm }),
      ),
    )
    expect((error as Error).message).toBe("rename failed")
  })

  test("a rebuild after a rolled-back one lands the new content", async () => {
    await buildPlugin({ outDir: dir, maximalPort: 4141 })
    await caught(buildPlugin({ outDir: dir, maximalPort: 5141 }, failingOps(2)))
    await buildPlugin({ outDir: dir, maximalPort: 5141 })
    expect(await inspectPlugin(dir, { maximalPort: 5141 })).toBe("current")
    expect(await leftovers(dir)).toEqual([])
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
