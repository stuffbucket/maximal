import { watch } from "node:fs"
/**
 * Builds the FigJam agent plugin into a folder Figma can import:
 * `code.js` (sandbox), `ui.html` (panel) and `manifest.json`.
 *
 * Today the sources are the single-file `src/legacy/code.js` and
 * `src/legacy/ui.html`, copied through unchanged except for the version
 * stamp in code.js and the build line in ui.html (`PANEL_BUILD`: the Maximal
 * and bridge ports and, when the process hosting the bridge builds it, that
 * bridge's relay key). Splitting them into modules happens behind this same
 * entry point.
 *
 * A build from this command carries no relay key, so its panel can't open
 * the bridge socket: the bridge's host (Maximal's FigJam plugin, or
 * `bun run figjam:bridge`) writes the panel that can.
 *
 *   bun scripts/build.ts                 # dev build → dist/dev
 *   bun scripts/build.ts --release       # release build → dist/release
 *   bun scripts/build.ts --out <dir>     # write somewhere else
 *   bun scripts/build.ts --watch         # rebuild when src/ changes
 */
import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises"
import path from "node:path"

// Embedded when bundled, so a compiled Maximal can write the plugin without
// the repo's source tree beside it.
import packageJson from "../package.json" with { type: "json" }
import codeSource from "../src/legacy/code.js" with { type: "text" }
import uiSource from "../src/legacy/ui.html" with { type: "text" }

// The text imports are typed as a module (code.js) or a bundle (ui.html); at
// runtime Bun gives the file's text.
function embeddedText(source: unknown, name: string): string {
  if (typeof source !== "string") {
    throw new TypeError(`The embedded ${name} is not text.`)
  }
  return source
}

const PACKAGE_DIR = path.resolve(import.meta.dir, "..")
const SOURCE_DIR = path.join(PACKAGE_DIR, "src")
const VERSION_LINE = /^var PLUGIN_VERSION = "[^"\n]*"$/m
const PANEL_BUILD_LINE = /^const PANEL_BUILD = .*;$/m
/** A bridge relay key: 32 random bytes as base64url. */
const RELAY_KEY = /^[\w-]{43}$/

export const DEFAULT_MAXIMAL_PORT = 4141
export const DEFAULT_BRIDGE_PORT = 4150

/** Where `bun run figjam:build` writes by default: `dist/dev` or `dist/release`. */
export function defaultOutDir(release = false): string {
  return path.join(PACKAGE_DIR, "dist", release ? "release" : "dev")
}

export interface BuildOptions {
  /** Folder to write into. Created if missing. */
  outDir: string
  /** Release builds use the plain name and id; dev builds are marked "(dev)". */
  release?: boolean
  /** Maximal's port, which the panel calls for models and messages. */
  maximalPort?: number
  /** The bridge's WebSocket port, for coding agents driving the board. */
  bridgePort?: number
  /**
   * The running bridge's relay key (`BridgeHandle.relayKey`). Only a panel
   * built with it can open the bridge socket. Stamped into ui.html alone,
   * never the manifest or any output; release builds never carry one.
   */
  relayKey?: string
}

/**
 * Everything that shapes a build's output: `BuildOptions` without where it
 * goes. `buildPlugin` and `inspectPlugin` both take this, so a folder is
 * checked against exactly the options it would be built with.
 */
export type PluginBuildOptions = Omit<BuildOptions, "outDir">

/** `PluginBuildOptions` with every default filled in (`relayKey` "" = none). */
export type ResolvedBuildOptions = Required<PluginBuildOptions>

/**
 * The one place defaults are applied and options are checked. `renderPlugin`
 * turns the result into every managed file (manifest, panel stamp, sandbox),
 * so a new option is added here and read from there.
 */
export function resolveBuildOptions(
  options: PluginBuildOptions,
): ResolvedBuildOptions {
  const release = options.release ?? false
  const relayKey = release ? "" : (options.relayKey ?? "")
  if (relayKey !== "" && !RELAY_KEY.test(relayKey)) {
    throw new Error("A FigJam relay key must be 32 bytes of base64url text.")
  }
  return {
    release,
    maximalPort: options.maximalPort ?? DEFAULT_MAXIMAL_PORT,
    bridgePort: options.bridgePort ?? DEFAULT_BRIDGE_PORT,
    relayKey,
  }
}

export interface BuildResult {
  outDir: string
  version: string
  files: Array<string>
}

export function readPackageVersion(): Promise<string> {
  return Promise.resolve(packageJson.version)
}

/** The sandbox source with its version line set to `version`. */
export function stampVersion(code: string, version: string): string {
  const matches = code.match(new RegExp(VERSION_LINE.source, "gm")) ?? []
  if (matches.length !== 1) {
    throw new Error(
      `Expected exactly one PLUGIN_VERSION line in code.js, found ${matches.length}.`,
    )
  }
  return code.replace(
    VERSION_LINE,
    `var PLUGIN_VERSION = ${JSON.stringify(version)}`,
  )
}

function assertPort(name: string, value: number): void {
  if (!Number.isInteger(value) || value < 1 || value > 65535) {
    throw new RangeError(
      `The ${name} must be a port from 1 to 65535, got ${value}.`,
    )
  }
}

/**
 * What the build stamps into the panel as `PANEL_BUILD`: the ports its
 * manifest allows, and the relay key it opens the bridge socket with ("" =
 * none, so the panel says it can't reach the bridge instead of trying).
 */
export interface PanelBuild {
  maximalPort: number
  bridgePort: number
  relayKey: string
}

/**
 * The panel's share of the resolved build options. The panel sees only what
 * is listed here, in this key order (the stamp is compared byte for byte).
 */
export function panelBuild(options: ResolvedBuildOptions): PanelBuild {
  return {
    maximalPort: options.maximalPort,
    bridgePort: options.bridgePort,
    relayKey: options.relayKey,
  }
}

/** The `PANEL_BUILD` line stamped into the panel. */
export function panelBuildLine(build: PanelBuild): string {
  assertPort("Maximal port", build.maximalPort)
  assertPort("bridge port", build.bridgePort)
  const stamped: PanelBuild = {
    maximalPort: build.maximalPort,
    bridgePort: build.bridgePort,
    relayKey: build.relayKey,
  }
  return `const PANEL_BUILD = ${JSON.stringify(stamped)};`
}

/**
 * The panel source with its `PANEL_BUILD` line set from `build`, whose ports
 * are the ones the manifest allows, so the panel dials exactly the origins in
 * `devAllowedDomains`.
 */
export function stampPanel(html: string, build: PanelBuild): string {
  const line = panelBuildLine(build)
  const matches = html.match(new RegExp(PANEL_BUILD_LINE.source, "gm")) ?? []
  if (matches.length !== 1) {
    throw new Error(
      `Expected exactly one PANEL_BUILD line in ui.html, found ${matches.length}.`,
    )
  }
  return html.replace(PANEL_BUILD_LINE, () => line)
}

/** The manifest never sees the relay key. */
export function pluginManifest(
  options: Omit<ResolvedBuildOptions, "relayKey">,
): Record<string, unknown> {
  return {
    name: options.release ? "Maximal Agent" : "Maximal Agent (dev)",
    id: options.release ? "maximal-figjam-agent" : "maximal-figjam-agent-dev",
    api: "1.0.0",
    main: "code.js",
    ui: "ui.html",
    editorType: ["figjam"],
    documentAccess: "dynamic-page",
    enablePrivatePluginApi: true,
    networkAccess: {
      allowedDomains: ["https://api.figma.com"],
      devAllowedDomains: [
        `http://localhost:${options.maximalPort}`,
        `ws://localhost:${options.bridgePort}`,
      ],
      reasoning:
        "The agent's model calls go to Maximal, a proxy running on this computer. An optional local bridge lets a coding agent on this computer drive the board. Reading and posting the board's comments uses Figma's REST API with a personal access token the user saves in the plugin's settings.",
    },
  }
}

type PluginFiles = Record<"code.js" | "manifest.json" | "ui.html", string>
type FolderState = "missing" | "stale" | "current"

/**
 * The exact files a build writes, by name. Pure: nothing touches the disk.
 * These three are the plugin's managed outputs; a folder is current only when
 * every one holds exactly these bytes. Both `buildPlugin` and `inspectPlugin`
 * go through here, so anything that changes the output changes freshness too.
 */
export async function renderPlugin(
  options: PluginBuildOptions,
): Promise<PluginFiles> {
  const version = await readPackageVersion()
  const resolved = resolveBuildOptions(options)
  return {
    "code.js": stampVersion(embeddedText(codeSource, "code.js"), version),
    "ui.html": stampPanel(
      embeddedText(uiSource, "ui.html"),
      panelBuild(resolved),
    ),
    "manifest.json": `${JSON.stringify(pluginManifest(resolved), null, 2)}\n`,
  }
}

/**
 * How a folder compares with what `options` would build, byte for byte:
 * `missing` when none of the managed files exist, `current` when all three
 * match, `stale` otherwise (a file differs, or only some exist). Files outside
 * the managed set are not the build's, so they are ignored.
 */
export async function inspectPlugin(
  outDir: string,
  options: PluginBuildOptions,
): Promise<FolderState> {
  const expected = await renderPlugin(options)
  const found = await Promise.all(
    Object.entries(expected).map(async ([name, contents]) => {
      try {
        const actual = await readFile(path.join(outDir, name))
        return actual.equals(Buffer.from(contents)) ? "match" : "differs"
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return "absent"
        throw error
      }
    }),
  )
  if (found.every((state) => state === "absent")) return "missing"
  return found.every((state) => state === "match") ? "current" : "stale"
}

/** The file operations a build uses; tests replace them to inject failures. */
interface FileOps {
  rename: (from: string, to: string) => Promise<void>
  rm: (file: string) => Promise<void>
}

const realFileOps: FileOps = {
  rename,
  rm: (file) => rm(file, { force: true }),
}

/** The file's bytes, or `null` when it doesn't exist. Other errors propagate. */
async function readPrior(file: string): Promise<Buffer | null> {
  try {
    return await readFile(file)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null
    throw error
  }
}

async function bestEffortRm(ops: FileOps, file: string): Promise<void> {
  try {
    await ops.rm(file)
  } catch {
    // A leftover temp file is harmless; the original error matters more.
  }
}

/**
 * Write `file` owner-only: ui.html can carry the bridge's relay key, and so
 * can the previous ui.html a rollback restores. The chmod covers a file left
 * behind with other permissions, which `mode` alone would keep.
 */
async function writePrivate(
  file: string,
  contents: string | Buffer,
): Promise<void> {
  await writeFile(file, contents, { mode: 0o600 })
  await chmod(file, 0o600)
}

/**
 * Put the managed files in place. Each file is written to a temp name first
 * (owner-only, see `writePrivate`), so Figma never reads a half-written file,
 * and then renamed over its final name. Each rename is atomic, but the three
 * together are not: a process
 * crash or power loss between renames can leave a mix of old and new files,
 * which the next start sees as stale and rebuilds. What an ordinary failure
 * (a rename that throws) gets is rollback: the previous contents are read up
 * front, and every file already renamed is restored (or removed, if it did
 * not exist before), so the folder is left as it was. Rollback and cleanup
 * are best-effort: an error in them (EPERM or EBUSY from antivirus, say)
 * never replaces the error that caused the rollback.
 */
async function writeAll(
  outDir: string,
  files: PluginFiles,
  ops: FileOps,
): Promise<void> {
  const staged = await Promise.all(
    Object.entries(files).map(async ([name, contents]) => {
      const final = path.join(outDir, name)
      return {
        final,
        temp: path.join(outDir, `${name}.${process.pid}.tmp`),
        undo: path.join(outDir, `${name}.${process.pid}.undo`),
        contents,
        prior: await readPrior(final),
      }
    }),
  )
  const renamed: Array<(typeof staged)[number]> = []
  try {
    await Promise.all(staged.map((f) => writePrivate(f.temp, f.contents)))
    for (const f of staged) {
      await ops.rename(f.temp, f.final)
      renamed.push(f)
    }
  } catch (error) {
    for (const f of renamed.reverse()) {
      try {
        if (f.prior === null) {
          await ops.rm(f.final)
        } else {
          await writePrivate(f.undo, f.prior)
          await ops.rename(f.undo, f.final)
        }
      } catch {
        // Best-effort: the next start finds the folder stale and rebuilds.
      }
    }
    await Promise.all(
      staged
        .flatMap((f) => [f.temp, f.undo])
        .map((file) => bestEffortRm(ops, file)),
    )
    throw error
  }
}

export async function buildPlugin(
  options: BuildOptions,
  ops: FileOps = realFileOps,
): Promise<BuildResult> {
  const { outDir, ...rest } = options
  const files = await renderPlugin(rest)
  await mkdir(outDir, { recursive: true })
  await writeAll(outDir, files, ops)
  return {
    outDir,
    version: await readPackageVersion(),
    files: Object.keys(files),
  }
}

function parseArgs(argv: Array<string>): BuildOptions & { watch: boolean } {
  const value = (flag: string): string | undefined => {
    const index = argv.indexOf(flag)
    return index === -1 ? undefined : argv[index + 1]
  }
  const release = argv.includes("--release")
  const port = (flag: string): number | undefined => {
    const raw = value(flag)
    return raw === undefined ? undefined : Number.parseInt(raw, 10)
  }
  return {
    outDir: path.resolve(value("--out") ?? defaultOutDir(release)),
    release,
    maximalPort: port("--maximal-port"),
    bridgePort: port("--bridge-port"),
    watch: argv.includes("--watch"),
  }
}

async function main(): Promise<void> {
  const { watch: watching, ...options } = parseArgs(process.argv.slice(2))
  const report = async (): Promise<void> => {
    const result = await buildPlugin(options)
    console.log(`Built FigJam plugin ${result.version} → ${result.outDir}`)
  }
  await report()
  if (!watching) return
  console.log(`Watching ${SOURCE_DIR} for changes…`)
  let pending: ReturnType<typeof setTimeout> | undefined
  watch(SOURCE_DIR, { recursive: true }, () => {
    clearTimeout(pending)
    pending = setTimeout(() => {
      report().catch((error: unknown) => console.error(error))
    }, 100)
  })
}

if (import.meta.main) {
  await main()
}
