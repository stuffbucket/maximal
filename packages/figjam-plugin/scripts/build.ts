import { watch } from "node:fs"
/**
 * Builds the FigJam agent plugin into a folder Figma can import:
 * `code.js` (sandbox), `ui.html` (panel) and `manifest.json`.
 *
 * Today the sources are the single-file `src/legacy/code.js` and
 * `src/legacy/ui.html`, copied through unchanged except for the version
 * stamp (code.js) and the build line (ui.html: ports, profile). Splitting them into modules happens behind this same entry point.
 *
 *   bun scripts/build.ts                 # dev build → dist/dev
 *   bun scripts/build.ts --release       # release build → dist/release
 *   bun scripts/build.ts --out <dir>     # write somewhere else
 *   bun scripts/build.ts --profile <id>  # a profile-specific dev plugin id and name
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
const PANEL_BUILD_LINE = /^const PANEL_BUILD = .*;$/m
/** A development profile id: what a Maximal dev profile calls itself (`a-z0-9-`). */
const PROFILE_ID = /^[a-z0-9][a-z0-9-]{0,39}$/

export const DEFAULT_MAXIMAL_PORT = 4141

export interface BuildOptions {
  /** Folder to write into. Created if missing. */
  outDir: string
  /** Release builds use the plain name and id; dev builds are marked "(dev)". */
  release?: boolean
  /** Maximal's port, which the panel calls for models and messages. */
  maximalPort?: number
  /**
   * A standalone bridge's WebSocket port (`bun run figjam:bridge`). Leave it
   * out when Maximal runs the bridge: the panel then reaches it through
   * Maximal's own origin, so the manifest allows nothing but Maximal.
   */
  bridgePort?: number
  /**
   * A Maximal development profile's id (`a-z0-9-`). It makes the dev plugin's
   * id and name profile-specific, so two profiles imported into one Figma
   * keep separate `clientStorage` (tokens, saved settings) and the panel can
   * tell when it reaches the wrong profile's Maximal. Omit for the shared
   * "Maximal Agent (dev)" plugin. Ignored by release builds.
   */
  profile?: string
}

export interface BuildResult {
  outDir: string
  version: string
  files: Array<string>
}

/** Every build option with its default filled in. */
export type ResolvedBuildOptions = Required<Omit<BuildOptions, "outDir">>

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

/**
 * The panel source with its build line set: the Maximal port the manifest
 * allows, a standalone bridge's port (0 when Maximal relays the bridge), and
 * the profile the plugin was built for (empty for the shared plugin). The
 * panel uses them to default its address, to explain a manifest that doesn't
 * allow the origin it is using, and to refuse a Maximal that belongs to
 * another profile. `dev` turns on the panel's console diagnostics. Nothing
 * secret goes in.
 */
export function stampPanel(
  html: string,
  options: ResolvedBuildOptions,
): string {
  const matches = html.match(new RegExp(PANEL_BUILD_LINE.source, "gm")) ?? []
  if (matches.length !== 1) {
    throw new Error(
      `Expected exactly one PANEL_BUILD line in ui.html, found ${matches.length}.`,
    )
  }
  const build = {
    maximalPort: options.maximalPort,
    bridgePort: options.bridgePort,
    profile: options.release ? "" : options.profile,
    dev: !options.release,
  }
  return html.replace(
    PANEL_BUILD_LINE,
    () => `const PANEL_BUILD = ${JSON.stringify(build)};`,
  )
}

/** The plugin's identity: shared, or specific to one Maximal dev profile. */
export function pluginIdentity(options: ResolvedBuildOptions): {
  id: string
  name: string
} {
  if (options.release) {
    return { id: "maximal-figjam-agent", name: "Maximal Agent" }
  }
  if (options.profile === "") {
    return { id: "maximal-figjam-agent-dev", name: "Maximal Agent (dev)" }
  }
  return {
    id: `maximal-figjam-agent-dev-${options.profile}`,
    name: `Maximal Agent (dev ${options.profile.slice(0, 8)})`,
  }
}

export function pluginManifest(
  options: ResolvedBuildOptions,
): Record<string, unknown> {
  return {
    ...pluginIdentity(options),
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
        `ws://localhost:${options.maximalPort}`,
        ...(options.bridgePort > 0 ?
          [`ws://localhost:${options.bridgePort}`]
        : []),
      ],
      reasoning:
        "The agent's model calls go to Maximal, a proxy running on this computer. An optional local bridge, reached through Maximal, lets a coding agent on this computer drive the board. Reading and posting the board's comments uses Figma's REST API with a personal access token the user saves in the plugin's settings.",
    },
  }
}

function resolveOptions(
  options: Omit<BuildOptions, "outDir">,
): ResolvedBuildOptions {
  const profile = options.profile ?? ""
  if (profile !== "" && !PROFILE_ID.test(profile)) {
    throw new Error(
      `A plugin profile id is lowercase letters, digits and dashes (up to 40), got "${profile}".`,
    )
  }
  return {
    release: options.release ?? false,
    maximalPort: options.maximalPort ?? DEFAULT_MAXIMAL_PORT,
    bridgePort: options.bridgePort ?? 0,
    profile,
  }
}

/** The exact files a build writes, by name. Pure: nothing touches the disk. */
export async function renderPlugin(
  options: Omit<BuildOptions, "outDir">,
): Promise<Record<"code.js" | "manifest.json" | "ui.html", string>> {
  const version = await readPackageVersion()
  const resolved = resolveOptions(options)
  return {
    "code.js": stampVersion(embeddedText(codeSource, "code.js"), version),
    "ui.html": stampPanel(embeddedText(uiSource, "ui.html"), resolved),
    "manifest.json": `${JSON.stringify(pluginManifest(resolved), null, 2)}\n`,
  }
}

// Write to a temp name and rename, so Figma never reads a half-written file.
async function writeAtomic(file: string, contents: string): Promise<void> {
  const temp = `${file}.${process.pid}.tmp`
  await writeFile(temp, contents)
  await rename(temp, file)
}

export async function buildPlugin(options: BuildOptions): Promise<BuildResult> {
  const { outDir, ...rest } = options
  const files = await renderPlugin(rest)
  await mkdir(outDir, { recursive: true })
  await Promise.all(
    Object.entries(files).map(([name, contents]) =>
      writeAtomic(path.join(outDir, name), contents),
    ),
  )
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
    profile: value("--profile"),
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
