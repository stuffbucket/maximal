import { watch } from "node:fs"
/**
 * Builds the FigJam agent plugin into a folder Figma can import:
 * `code.js` (sandbox), `ui.html` (panel) and `manifest.json`.
 *
 * Today the sources are the single-file `src/legacy/code.js` and
 * `src/legacy/ui.html`, copied through unchanged except for the version
 * stamp. Splitting them into modules happens behind this same entry point.
 *
 *   bun scripts/build.ts                 # dev build → dist/dev
 *   bun scripts/build.ts --release       # release build → dist/release
 *   bun scripts/build.ts --out <dir>     # write somewhere else
 *   bun scripts/build.ts --watch         # rebuild when src/ changes
 */
import { mkdir, rename, writeFile } from "node:fs/promises"
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

// Write to a temp name and rename, so Figma never reads a half-written file.
async function writeAtomic(file: string, contents: string): Promise<void> {
  const temp = `${file}.${process.pid}.tmp`
  await writeFile(temp, contents)
  await rename(temp, file)
}

export async function buildPlugin(options: BuildOptions): Promise<BuildResult> {
  const version = await readPackageVersion()
  const resolved = {
    release: options.release ?? false,
    maximalPort: options.maximalPort ?? DEFAULT_MAXIMAL_PORT,
    bridgePort: options.bridgePort ?? DEFAULT_BRIDGE_PORT,
  }
  await mkdir(options.outDir, { recursive: true })
  const files = {
    "code.js": stampVersion(embeddedText(codeSource, "code.js"), version),
    "ui.html": embeddedText(uiSource, "ui.html"),
    "manifest.json": `${JSON.stringify(pluginManifest(resolved), null, 2)}\n`,
  }
  await Promise.all(
    Object.entries(files).map(([name, contents]) =>
      writeAtomic(path.join(options.outDir, name), contents),
    ),
  )
  return { outDir: options.outDir, version, files: Object.keys(files) }
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
