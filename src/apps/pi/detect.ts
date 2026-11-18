import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { z } from "zod"

import { parseJsonText } from "~/lib/platform/json-text"

const Manifest = z.object({
  name: z.enum([
    "@earendil-works/pi-coding-agent",
    "@mariozechner/pi-coding-agent",
  ]),
  version: z.string().min(1),
  bin: z.union([z.string(), z.object({ pi: z.string() })]),
})

export interface PiInstallation {
  path: string
  version: string
}
interface DetectOptions {
  homeDir?: string
  pathEnv?: string
  platform?: NodeJS.Platform
  appDataDir?: string
}
const manifests = new Map<
  string,
  { stamp: string; value: z.infer<typeof Manifest> | null }
>()

function manifestAt(filePath: string) {
  try {
    const stat = fs.statSync(filePath)
    if (!stat.isFile() || stat.size > 131072) return null
    const stamp = `${stat.mtimeMs}:${stat.size}`
    const cached = manifests.get(filePath)
    if (cached?.stamp === stamp) return cached.value
    const raw = parseJsonText(fs.readFileSync(filePath, "utf8"))
    const parsed = Manifest.safeParse(raw)
    const value = parsed.success ? parsed.data : null
    if (manifests.size >= 128) manifests.clear()
    manifests.set(filePath, { stamp, value })
    return value
  } catch {
    return null
  }
}

function identify(
  candidate: string,
  platform: NodeJS.Platform,
): PiInstallation | null {
  try {
    const realPath = fs.realpathSync(candidate)
    if (!fs.statSync(realPath).isFile()) return null
    if (platform !== "win32") fs.accessSync(realPath, fs.constants.X_OK)
    let directory = path.dirname(realPath)
    for (let depth = 0; depth < 3; depth += 1) {
      const manifest = manifestAt(path.join(directory, "package.json"))
      if (manifest) return { path: realPath, version: manifest.version }
      directory = path.dirname(directory)
    }
  } catch {
    /* Missing or inaccessible is not an installation. */
  }
  return null
}

function candidatesIn(
  directory: string,
  platform: NodeJS.Platform,
): Array<string> {
  if (platform !== "win32") return [path.join(directory, "pi")]
  const candidates = [
    path.join(directory, "pi.exe"),
    path.join(directory, "pi.cmd"),
  ]
  for (const name of Manifest.shape.name.options) {
    const root = path.join(directory, "node_modules", name)
    const manifest = manifestAt(path.join(root, "package.json"))
    if (!manifest) continue
    const bin =
      typeof manifest.bin === "string" ? manifest.bin : manifest.bin.pi
    candidates.push(path.resolve(root, bin))
  }
  return candidates
}

/** Identify official Pi packages by local metadata, never by executing a program named `pi`. */
export function detectPiInstallations(
  options: DetectOptions = {},
): Array<PiInstallation> {
  const platform = options.platform ?? process.platform
  const home = options.homeDir ?? os.homedir()
  const separator = platform === "win32" ? ";" : ":"
  const directories = new Set(
    (options.pathEnv ?? process.env.PATH ?? "")
      .split(separator)
      .filter(Boolean),
  )
  directories.add(path.join(home, ".local", "bin"))
  directories.add(path.join(home, ".npm-global", "bin"))
  const appData = options.appDataDir ?? process.env.APPDATA
  if (appData) directories.add(path.join(appData, "npm"))
  const candidates = [...directories].flatMap((directory) =>
    candidatesIn(directory, platform),
  )
  // mise's shim is not Pi's identity. Inspect its versioned distributions instead.
  const mise = path.join(home, ".local", "share", "mise", "installs", "pi")
  try {
    for (const version of fs.readdirSync(mise).slice(0, 64))
      candidates.push(
        path.join(mise, version, "pi", platform === "win32" ? "pi.exe" : "pi"),
      )
  } catch {
    /* Not installed through mise. */
  }
  const found = new Map<string, PiInstallation>()
  for (const candidate of candidates) {
    const installation = identify(candidate, platform)
    if (installation) found.set(installation.path, installation)
  }
  return [...found.values()]
}
