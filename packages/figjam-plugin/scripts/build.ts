import { watch } from "node:fs"
/**
 * Builds the FigJam agent plugin into a folder Figma can import:
 * `code.js` (sandbox), `ui.html` (panel) and `manifest.json`.
 *
 * Today the sources are the single-file `src/legacy/code.js` and
 * `src/legacy/ui.html`, copied through unchanged except for the version
 * stamp and the ports stamped into the panel (`PANEL_BUILD`). Splitting them
 * into modules happens behind this same entry point.
 *
 *   bun scripts/build.ts                 # dev build → dist/dev
 *   bun scripts/build.ts --release       # release build → dist/release
 *   bun scripts/build.ts --out <dir>     # write somewhere else
 *   bun scripts/build.ts --watch         # rebuild when src/ changes
 */
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises"
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

export const DEFAULT_MAXIMAL_PORT = 4141
export const DEFAULT_BRIDGE_PORT = 4150

export interface BuildOptions {
  /** Folder to write into. Created if missing. */
  outDir: string
  /** Release builds use the plain name and id; dev builds are marked "(dev)". */
  release?: boolean
  /** Maximal's port, which the panel calls for models and messages. */
  maximalPort?: number
  /** The bridge's WebSocket port, for coding agents driving the board. */
  bridgePort?: number
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

/** The `PANEL_BUILD` line stamped into the panel for these ports. */
export function panelBuildLine(ports: {
  maximalPort: number
  bridgePort: number
}): string {
  assertPort("Maximal port", ports.maximalPort)
  assertPort("bridge port", ports.bridgePort)
  const build = {
    maximalPort: ports.maximalPort,
    bridgePort: ports.bridgePort,
  }
  return `const PANEL_BUILD = ${JSON.stringify(build)};`
}

/**
 * The panel source with its `PANEL_BUILD` line set to the ports the manifest
 * allows, so the panel dials exactly the origins in `devAllowedDomains`.
 */
export function stampPanel(
  html: string,
  ports: { maximalPort: number; bridgePort: number },
): string {
  const line = panelBuildLine(ports)
  const matches = html.match(new RegExp(PANEL_BUILD_LINE.source, "gm")) ?? []
  if (matches.length !== 1) {
    throw new Error(
      `Expected exactly one PANEL_BUILD line in ui.html, found ${matches.length}.`,
    )
  }
  return html.replace(PANEL_BUILD_LINE, () => line)
}

export function pluginManifest(
  options: Required<Omit<BuildOptions, "outDir">>,
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

function resolveOptions(
  options: Omit<BuildOptions, "outDir">,
): Required<Omit<BuildOptions, "outDir">> {
  return {
    release: options.release ?? false,
    maximalPort: options.maximalPort ?? DEFAULT_MAXIMAL_PORT,
    bridgePort: options.bridgePort ?? DEFAULT_BRIDGE_PORT,
  }
}

/**
 * The exact files a build writes, by name. Pure: nothing touches the disk.
 * These three are the plugin's managed outputs; a folder is current only when
 * every one holds exactly these bytes.
 */
export async function renderPlugin(
  options: Omit<BuildOptions, "outDir">,
): Promise<PluginFiles> {
  const version = await readPackageVersion()
  const resolved = resolveOptions(options)
  return {
    "code.js": stampVersion(embeddedText(codeSource, "code.js"), version),
    "ui.html": stampPanel(embeddedText(uiSource, "ui.html"), resolved),
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
  options: Omit<BuildOptions, "outDir">,
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
 * Put the managed files in place. Each file is written to a temp name first,
 * so Figma never reads a half-written file, and then renamed over its final
 * name. Each rename is atomic, but the three together are not: a process
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
    await Promise.all(staged.map((f) => writeFile(f.temp, f.contents)))
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
          await writeFile(f.undo, f.prior)
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
    outDir: path.resolve(
      value("--out")
        ?? path.join(PACKAGE_DIR, "dist", release ? "release" : "dev"),
    ),
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
