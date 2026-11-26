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
  stat,
  writeFile,
} from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { Script } from "node:vm"

import {
  buildPlugin,
  DEFAULT_MAXIMAL_PORT,
  inspectPlugin,
  panelBuild,
  panelBuildLine,
  pluginManifest,
  readPackageVersion,
  RELAYED_BRIDGE_PORT,
  renderPlugin,
  resolveBuildOptions,
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

  test("dev manifest is FigJam-only and reaches only Maximal and Figma's API, never the bridge", async () => {
    const manifest = JSON.parse(
      await readFile(path.join(outDir, "manifest.json"), "utf8"),
    ) as Record<string, unknown>
    expect(manifest.id).toBe("maximal-figjam-agent-dev")
    expect(manifest.editorType).toEqual(["figjam"])
    expect(manifest.networkAccess).toMatchObject({
      allowedDomains: ["https://api.figma.com"],
      // Maximal's origin only (HTTP for models, WebSocket for the relayed
      // bridge socket): the bridge's port is not in the plugin.
      devAllowedDomains: ["http://localhost:4141", "ws://localhost:4141"],
    })
    expect(JSON.stringify(manifest)).not.toContain("4150")
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

// The panel header carries Maximal's mark: the app icon's crimson rounded
// square with the "m" outlined from the repo's wordmark, so it needs no font,
// image or network inside Figma's iframe. Plain string search, not HTML
// pattern matching: the fixture is the ui.html this build just wrote.

/** The text between the first `open` in `text` and the next `close`. */
function between(text: string, open: string, close: string): string {
  const start = text.indexOf(open)
  if (start === -1) throw new Error(`missing ${open}`)
  const end = text.indexOf(close, start + open.length)
  if (end === -1) throw new Error(`unclosed ${open}`)
  return text.slice(start + open.length, end)
}
describe("brand mark", () => {
  const REPO = path.resolve(import.meta.dir, "../../..")

  test("the panel shows one labelled mark, self-contained", async () => {
    const ui = await readFile(path.join(outDir, "ui.html"), "utf8")
    expect(ui.split('class="brand-mark"').length - 1).toBe(1)
    const svg = between(ui, '<svg class="brand-mark"', "</svg>")
    expect(svg).toContain('role="img" aria-label="Maximal"')
    expect(svg.split("<rect ").length - 1).toBe(1)
    expect(svg.split("<path ").length - 1).toBe(1)
    for (const outside of ["href", "src=", "url(", "<text", "<image", "font"]) {
      expect(svg).not.toContain(outside)
    }
  })

  test("its m is the wordmark's outlined Fraunces m, byte for byte", async () => {
    const ui = await readFile(path.join(outDir, "ui.html"), "utf8")
    const markPath = between(
      between(ui, '<svg class="brand-mark"', "</svg>"),
      ' d="',
      '"',
    )
    const wordmark = await readFile(
      path.join(REPO, "shell", "maximal-wordmark.svg"),
      "utf8",
    )
    const wordmarkPath = between(wordmark, '<path d="', '"')
    expect(markPath.length).toBeGreaterThan(1000)
    expect(wordmarkPath.startsWith(markPath)).toBe(true)
    // The m ends where the wordmark's next letter begins.
    expect(wordmarkPath.slice(markPath.length).startsWith(" M")).toBe(true)
  })

  test("its colors are the brand tokens, and --brand is the app's brand color", async () => {
    const ui = await readFile(path.join(outDir, "ui.html"), "utf8")
    expect(ui).toContain(".brand-mark rect { fill: var(--brand); }")
    expect(ui).toContain(".brand-mark path { fill: var(--on-brand); }")
    const theme = await readFile(
      path.join(REPO, "shell", "src", "ui", "styles", "theme.ts"),
      "utf8",
    )
    const brandColor = between(
      between(theme, "export const brand = {", "}"),
      'color: "',
      '"',
    )
    expect(ui).toContain(`--brand: ${brandColor};`)
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

  test("the manifest and the panel stamp come from the same resolved options", async () => {
    for (const options of [
      {},
      { maximalPort: 5141, bridgePort: 5150 },
      { release: true, bridgePort: 6150 },
    ]) {
      const resolved = resolveBuildOptions(options)
      const files = await renderPlugin(options)
      expect(JSON.parse(files["manifest.json"])).toEqual(
        pluginManifest(resolved),
      )
      expect(files["ui.html"]).toContain(panelBuildLine(panelBuild(resolved)))
    }
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

/** Every file in `dir` is owner-only (ui.html can carry a relay key). */
async function expectOwnerOnly(dir: string): Promise<void> {
  for (const name of await readdir(dir)) {
    expect((await stat(path.join(dir, name))).mode & 0o777, name).toBe(0o600)
  }
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

describe("relay key", () => {
  const KEY = "k".repeat(22) + "_-".repeat(10) + "Z"
  const OTHER_KEY = "o".repeat(43)

  test("a plain build stamps Maximal's port, no bridge port and no key, so the panel won't try the bridge", async () => {
    const ui = await readFile(path.join(outDir, "ui.html"), "utf8")
    expect(ui).toContain(
      panelBuildLine({
        maximalPort: DEFAULT_MAXIMAL_PORT,
        bridgePort: RELAYED_BRIDGE_PORT,
        relayKey: "",
        profile: "",
        dev: true,
      }),
    )
  })

  test("the key goes into ui.html alone, owner-only", async () => {
    const keyed = path.join(outDir, "keyed")
    await buildPlugin({ outDir: keyed, bridgePort: 5150, relayKey: KEY })
    const ui = await readFile(path.join(keyed, "ui.html"), "utf8")
    expect(ui).toContain(
      panelBuildLine({
        maximalPort: DEFAULT_MAXIMAL_PORT,
        bridgePort: 5150,
        relayKey: KEY,
        profile: "",
        dev: true,
      }),
    )
    for (const name of ["manifest.json", "code.js"]) {
      expect(await readFile(path.join(keyed, name), "utf8")).not.toContain(KEY)
    }
    await expectOwnerOnly(keyed)
  })

  test("a release build never carries a key", async () => {
    const release = path.join(outDir, "release-keyed")
    await buildPlugin({ outDir: release, release: true, relayKey: KEY })
    const ui = await readFile(path.join(release, "ui.html"), "utf8")
    expect(ui).not.toContain(KEY)
  })

  test("a malformed key is refused", async () => {
    const refused = await buildPlugin({
      outDir: path.join(outDir, "bad"),
      relayKey: "nope",
    }).then(() => "", String)
    expect(refused).toContain("relay key")
  })

  test("the panel source has exactly one build line", () => {
    expect(() =>
      stampPanel("<script></script>", {
        maximalPort: 1,
        bridgePort: 1,
        relayKey: "",
        profile: "",
        dev: true,
      }),
    ).toThrow("found 0")
  })

  test("the key is part of freshness: another key makes the folder stale", async () => {
    const dir = path.join(outDir, "keyed-fresh")
    await buildPlugin({ outDir: dir, relayKey: KEY })
    expect(await inspectPlugin(dir, { relayKey: KEY })).toBe("current")
    expect(await inspectPlugin(dir, { relayKey: OTHER_KEY })).toBe("stale")
    expect(await inspectPlugin(dir, {})).toBe("stale")
  })

  test("a rolled-back rebuild restores the previous key, owner-only, with no leftovers", async () => {
    const dir = path.join(outDir, "keyed-undo")
    await buildPlugin({ outDir: dir, relayKey: KEY })
    const before = await snapshot(dir)
    // code.js renames, then ui.html (carrying OTHER_KEY) throws.
    const error = await caught(
      buildPlugin({ outDir: dir, relayKey: OTHER_KEY }, failingOps(2)),
    )
    expect((error as Error).message).toBe("rename failed")
    expect(await snapshot(dir)).toEqual(before)
    expect(await leftovers(dir)).toEqual([])
    await expectOwnerOnly(dir)
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

// The built panel runs against fake browser globals and must dial only what
// the manifest allows: Maximal's origin (the bridge is reached through it), and
// a standalone bridge's port only when the build names one. Only a keyed build
// (what the bridge's host writes) asks Maximal for the bridge or opens a socket.
describe("panel ports", () => {
  const script = path.join(import.meta.dir, "sandbox", "panel-ports.mjs")
  const KEY = "p".repeat(21) + "-_".repeat(11)
  const run = (
    dir: string,
    ports: { maximalPort: number; bridgePort: number },
    extra: { saved?: string; discovery?: string } = {},
  ) => {
    const result = Bun.spawnSync(
      [
        "node",
        script,
        dir,
        String(ports.maximalPort),
        String(ports.bridgePort),
        ...(extra.saved ? [extra.saved] : []),
      ],
      {
        stdout: "pipe",
        stderr: "pipe",
        env: { ...process.env, PANEL_DISCOVERY: extra.discovery ?? "ok" },
      },
    )
    return {
      code: result.exitCode,
      output: `${result.stdout.toString()}${result.stderr.toString()}`,
    }
  }

  test("default port: a keyed build asks Maximal about the bridge and opens its socket on Maximal's origin, with its key", async () => {
    const keyedDir = path.join(outDir, "default-keyed")
    await buildPlugin({ outDir: keyedDir, relayKey: KEY })
    const result = run(keyedDir, { maximalPort: 4141, bridgePort: 0 })
    expect(result.code, result.output).toBe(0)
  })

  test("an unkeyed build still calls Maximal for models but sends no discovery request and opens no socket", () => {
    const result = run(outDir, { maximalPort: 4141, bridgePort: 0 })
    expect(result.code, result.output).toBe(0)
  })

  test("a standalone bridge's build dials that port directly, with its key, and the manifest allows it", async () => {
    const standalone = path.join(outDir, "standalone")
    await buildPlugin({ outDir: standalone, bridgePort: 4153, relayKey: KEY })
    const result = run(standalone, { maximalPort: 4141, bridgePort: 4153 })
    expect(result.code, result.output).toBe(0)
  })

  test("Maximal's discovery answers stop the panel from opening a socket: another profile, an unknown key, FigJam off", async () => {
    const profiled = path.join(outDir, "profiled")
    await buildPlugin({
      outDir: profiled,
      relayKey: KEY,
      profile: "ab12cd34ef56",
    })
    for (const discovery of ["other-profile", "rejected", "down"]) {
      const result = run(
        profiled,
        { maximalPort: 4141, bridgePort: 0 },
        { discovery },
      )
      expect(result.code, `${discovery}: ${result.output}`).toBe(0)
    }
  })

  test("refuses a panel with a second script element, whatever its case", async () => {
    const extraDir = path.join(outDir, "extra-script")
    await buildPlugin({ outDir: extraDir, relayKey: KEY })
    const uiPath = path.join(extraDir, "ui.html")
    const ui = await readFile(uiPath, "utf8")
    await writeFile(uiPath, `${ui}\n<SCRIPT>void 0</SCRIPT>\n`)
    const result = run(extraDir, { maximalPort: 4141, bridgePort: 0 })
    expect(result.code).not.toBe(0)
    expect(result.output).toContain("exactly one script element, found 2")
  })

  test("a non-default Maximal port reaches the panel's connections and status text", async () => {
    const customDir = path.join(outDir, "custom-ports")
    await buildPlugin({
      outDir: customDir,
      maximalPort: 5141,
      relayKey: KEY,
    })
    const ui = await readFile(path.join(customDir, "ui.html"), "utf8")
    expect(ui).toContain(
      `const PANEL_BUILD = {"maximalPort":5141,"bridgePort":0,"relayKey":"${KEY}","profile":"","dev":true};`,
    )
    const result = run(customDir, { maximalPort: 5141, bridgePort: 0 })
    expect(result.code, result.output).toBe(0)
  })

  test("a default address saved by an older panel follows the build's port", async () => {
    const customDir = path.join(outDir, "custom-saved")
    await buildPlugin({
      outDir: customDir,
      maximalPort: 4999,
      relayKey: KEY,
    })
    const result = run(
      customDir,
      { maximalPort: 4999, bridgePort: 0 },
      { saved: "http://localhost:4141" },
    )
    expect(result.code, result.output).toBe(0)
  })

  test("refuses ports that aren't ports", () => {
    const line = "const PANEL_BUILD = {};"
    const base = { relayKey: "", profile: "", dev: true }
    expect(() =>
      stampPanel(line, { ...base, maximalPort: 0, bridgePort: 0 }),
    ).toThrow("Maximal port")
    expect(() =>
      stampPanel(line, { ...base, maximalPort: 4141, bridgePort: Number.NaN }),
    ).toThrow("bridge port")
    expect(() =>
      stampPanel(line, { ...base, maximalPort: 4141, bridgePort: 70_000 }),
    ).toThrow("bridge port")
    expect(() =>
      stampPanel("<html></html>", {
        ...base,
        maximalPort: 4141,
        bridgePort: 0,
      }),
    ).toThrow("found 0")
  })
})

describe("doctype and panel script", () => {
  test("ui.html starts with a doctype after an optional UTF-8 BOM", async () => {
    const bytes = await readFile(path.join(outDir, "ui.html"))
    const start =
      bytes.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf])) ? 3 : 0
    expect(
      bytes
        .subarray(start, start + 15)
        .toString("utf8")
        .toLowerCase(),
    ).toBe("<!doctype html>")
  })

  test("the panel's script parses", async () => {
    const { "ui.html": html } = await renderPlugin({})
    const script = /<script>([\s\S]*)<\/script>/.exec(html)?.[1]
    expect(script).toBeDefined()
    expect(() => new Script(script ?? "")).not.toThrow()
  })
})

const manifestOf = async (
  options: Parameters<typeof renderPlugin>[0],
): Promise<Record<string, unknown>> =>
  JSON.parse((await renderPlugin(options))["manifest.json"]) as Record<
    string,
    unknown
  >

describe("profiles", () => {
  test("a profile gives the dev plugin its own id and name; none keeps the shared one", async () => {
    expect(await manifestOf({})).toMatchObject({
      id: "maximal-figjam-agent-dev",
      name: "Maximal Agent (dev)",
    })
    const first = await manifestOf({ profile: "ab12cd34ef56" })
    const second = await manifestOf({ profile: "0f0f0f0f0f0f" })
    expect(first.id).toBe("maximal-figjam-agent-dev-ab12cd34ef56")
    expect(first.name).toBe("Maximal Agent (dev ab12cd34)")
    expect(second.id).not.toBe(first.id)
  })

  test("a release build ignores the profile", async () => {
    expect(
      await manifestOf({ release: true, profile: "ab12cd34ef56" }),
    ).toMatchObject({ id: "maximal-figjam-agent", name: "Maximal Agent" })
  })

  test("a malformed profile id is refused", async () => {
    const refused = await renderPlugin({ profile: "../x" }).catch(
      (error: unknown) => error,
    )
    expect(String(refused)).toContain("lowercase letters")
  })

  test("a profile makes a folder built without it stale", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "figjam-profile-"))
    try {
      await buildPlugin({ outDir: dir })
      expect(await inspectPlugin(dir, {})).toBe("current")
      expect(await inspectPlugin(dir, { profile: "ab12cd34ef56" })).toBe(
        "stale",
      )
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
