/**
 * Wire Claude Desktop's **third-party (Cowork 3P)** mode at the local
 * gateway.
 */

import { randomUUID } from "node:crypto"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

const USERDATA_3P_SUFFIX = "-3p"

export const CLAUDE_3P_PREF_DOMAIN = "com.anthropic.claudefordesktop"

export interface GatewayProfileValues {
  inferenceProvider: "gateway"
  inferenceGatewayBaseUrl: string
  inferenceGatewayApiKey: string
  inferenceGatewayAuthScheme: "bearer" | "x-api-key"
  disableDeploymentModeChooser: boolean
  coworkEgressAllowedHosts: Array<string>
  allowedWorkspaceFolders: Array<string>
  disableEssentialTelemetry: boolean
  disableNonessentialTelemetry: boolean
  disableNonessentialServices: boolean
  disableAutoUpdates: boolean
}

export function gatewayProfile(
  home: string = os.homedir(),
  baseUrl = "http://127.0.0.1:4141",
): GatewayProfileValues {
  return {
    inferenceProvider: "gateway",
    inferenceGatewayBaseUrl: baseUrl,
    inferenceGatewayApiKey: "anything",
    inferenceGatewayAuthScheme: "bearer",
    disableDeploymentModeChooser: true,
    coworkEgressAllowedHosts: ["*"],
    allowedWorkspaceFolders: [path.join(home, "Claude")],
    disableEssentialTelemetry: true,
    disableNonessentialTelemetry: true,
    disableNonessentialServices: true,
    disableAutoUpdates: false,
  }
}

export function getClaude3pDir(
  home: string = os.homedir(),
  platform: NodeJS.Platform = process.platform,
): string {
  if (platform === "win32") {
    const localAppData =
      process.env.LOCALAPPDATA ?? path.join(home, "AppData", "Local")
    return path.join(localAppData, `Claude${USERDATA_3P_SUFFIX}`)
  }
  return path.join(
    home,
    "Library",
    "Application Support",
    `Claude${USERDATA_3P_SUFFIX}`,
  )
}

interface MetaFile {
  appliedId: string
  entries: Array<{ id: string; name: string }>
}

function profileMatches(
  existing: Record<string, unknown> | null,
  values: GatewayProfileValues,
): boolean {
  if (!existing) return false
  return (Object.keys(values) as Array<keyof GatewayProfileValues>).every(
    (k) => JSON.stringify(existing[k]) === JSON.stringify(values[k]),
  )
}

function readJsonObject(file: string): Record<string, unknown> | null {
  let raw: string
  try {
    raw = fs.readFileSync(file, "utf8")
  } catch {
    return null
  }

  try {
    const parsed: unknown = JSON.parse(raw)
    if (
      typeof parsed !== "object"
      || parsed === null
      || Array.isArray(parsed)
    ) {
      return null
    }
    return parsed as Record<string, unknown>
  } catch {
    return null
  }
}

function atomicWriteJson(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const tmp = `${file}.tmp`
  try {
    fs.unlinkSync(tmp)
  } catch (err: unknown) {
    if (!(err instanceof Error) || !("code" in err) || err.code !== "ENOENT") {
      throw err
    }
  }
  const fd = fs.openSync(
    tmp,
    fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL,
    0o600,
  )
  try {
    fs.writeFileSync(fd, `${JSON.stringify(value, null, 2)}\n`)
    fs.fsyncSync(fd)
  } finally {
    fs.closeSync(fd)
  }
  fs.renameSync(tmp, file)
}

export interface ApplyConfigLibraryResult {
  dir: string
  profileId: string
  wrote: boolean
  ensuredWorkspaceFolders: Array<string>
}

export function applyConfigLibraryProfile(
  home: string = os.homedir(),
  values: GatewayProfileValues = gatewayProfile(home),
): ApplyConfigLibraryResult {
  const dir = getClaude3pDir(home)
  const libDir = path.join(dir, "configLibrary")
  const metaPath = path.join(libDir, "_meta.json")

  const meta = (readJsonObject(metaPath) as MetaFile | null) ?? {
    appliedId: "",
    entries: [],
  }

  const profileId = meta.appliedId || randomUUID()
  const profilePath = path.join(libDir, `${profileId}.json`)

  const ensuredWorkspaceFolders = ensureWorkspaceFolders(
    values.allowedWorkspaceFolders,
  )

  const existingProfile = readJsonObject(profilePath)
  const topPath = path.join(dir, "claude_desktop_config.json")
  const top = readJsonObject(topPath) ?? {}
  const alreadyApplied =
    meta.appliedId === profileId
    && profileMatches(existingProfile, values)
    && top.deploymentMode === "3p"
  if (alreadyApplied) {
    return { dir, profileId, wrote: false, ensuredWorkspaceFolders }
  }

  atomicWriteJson(profilePath, values)

  const entries =
    meta.entries.some((e) => e.id === profileId) ?
      meta.entries
    : [...meta.entries, { id: profileId, name: "Default" }]
  atomicWriteJson(metaPath, { appliedId: profileId, entries })

  top.deploymentMode = "3p"
  const prefs =
    typeof top.preferences === "object" && top.preferences !== null ?
      (top.preferences as Record<string, unknown>)
    : {}
  top.preferences = { ...prefs, coworkWebSearchEnabled: true }
  atomicWriteJson(topPath, top)

  return { dir, profileId, wrote: true, ensuredWorkspaceFolders }
}

export function isConfigLibraryApplied(
  home: string = os.homedir(),
  values: GatewayProfileValues = gatewayProfile(home),
): boolean {
  const dir = getClaude3pDir(home)
  const libDir = path.join(dir, "configLibrary")
  const meta = readJsonObject(
    path.join(libDir, "_meta.json"),
  ) as MetaFile | null
  if (!meta?.appliedId) return false
  const profile = readJsonObject(path.join(libDir, `${meta.appliedId}.json`))
  if (!profileMatches(profile, values)) return false
  const top = readJsonObject(path.join(dir, "claude_desktop_config.json"))
  return top?.deploymentMode === "3p"
}

export interface RevertResult {
  dir: string
  reverted: boolean
}

export function revertConfigLibraryProfile(
  home: string = os.homedir(),
): RevertResult {
  const dir = getClaude3pDir(home)
  const libDir = path.join(dir, "configLibrary")
  const metaPath = path.join(libDir, "_meta.json")
  const meta = readJsonObject(metaPath) as MetaFile | null
  let reverted = false
  if (meta?.appliedId) {
    try {
      fs.rmSync(path.join(libDir, `${meta.appliedId}.json`), { force: true })
    } catch {
      /* best effort */
    }
    const entries = meta.entries.filter((e) => e.id !== meta.appliedId)
    atomicWriteJson(metaPath, { appliedId: "", entries })
    reverted = true
  }
  const topPath = path.join(dir, "claude_desktop_config.json")
  const top = readJsonObject(topPath)
  if (top && "deploymentMode" in top) {
    delete top.deploymentMode
    atomicWriteJson(topPath, top)
    reverted = true
  }
  return { dir, reverted }
}

function ensureWorkspaceFolders(folders: Array<string>): Array<string> {
  const created: Array<string> = []
  for (const folder of folders) {
    try {
      fs.mkdirSync(folder, { recursive: true })
      created.push(folder)
    } catch {
      /* best effort */
    }
  }
  return created
}

function plistEscape(s: string): string {
  return s
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
}

function plistValue(v: unknown, indent: number): string {
  const pad = "  ".repeat(indent)
  if (typeof v === "string") return `${pad}<string>${plistEscape(v)}</string>`
  if (typeof v === "boolean") return `${pad}<${v ? "true" : "false"}/>`
  if (Array.isArray(v)) {
    const items = v.map((x) => plistValue(x, indent + 1)).join("\n")
    return `${pad}<array>\n${items}\n${pad}</array>`
  }
  if (typeof v === "object" && v !== null) {
    const body = Object.entries(v)
      .map(
        ([k, val]) =>
          `${pad}  <key>${plistEscape(k)}</key>\n${plistValue(val, indent + 1)}`,
      )
      .join("\n")
    return `${pad}<dict>\n${body}\n${pad}</dict>`
  }
  throw new Error(`unsupported plist value: ${typeof v}`)
}

export interface ManagedProfileOptions {
  profileUUID?: string
  payloadUUID?: string
  scope?: "User" | "System"
}

export function generateManagedProfile(
  home: string = os.homedir(),
  values: GatewayProfileValues = gatewayProfile(home),
  opts: ManagedProfileOptions = {},
): string {
  const profileUUID = opts.profileUUID ?? randomUUID()
  const payloadUUID = opts.payloadUUID ?? randomUUID()
  const scope = opts.scope ?? "User"
  const settings = plistValue(values, 8)
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>PayloadContent</key>
  <array>
    <dict>
      <key>PayloadType</key>
      <string>com.apple.ManagedClient.preferences</string>
      <key>PayloadVersion</key>
      <integer>1</integer>
      <key>PayloadIdentifier</key>
      <string>com.maximal.claude3p.mcx</string>
      <key>PayloadUUID</key>
      <string>${payloadUUID}</string>
      <key>PayloadEnabled</key>
      <true/>
      <key>PayloadContent</key>
      <dict>
        <key>${CLAUDE_3P_PREF_DOMAIN}</key>
        <dict>
          <key>Forced</key>
          <array>
            <dict>
              <key>mcx_preference_settings</key>
${settings}
            </dict>
          </array>
        </dict>
      </dict>
    </dict>
  </array>
  <key>PayloadType</key>
  <string>Configuration</string>
  <key>PayloadVersion</key>
  <integer>1</integer>
  <key>PayloadIdentifier</key>
  <string>com.maximal.claude3p</string>
  <key>PayloadUUID</key>
  <string>${profileUUID}</string>
  <key>PayloadDisplayName</key>
  <string>maximal — Claude Desktop third-party gateway</string>
  <key>PayloadDescription</key>
  <string>Routes Claude Desktop (Cowork 3P) at the local maximal gateway (${plistEscape(values.inferenceGatewayBaseUrl)}). No Anthropic sign-in required.</string>
  <key>PayloadOrganization</key>
  <string>maximal</string>
  <key>PayloadScope</key>
  <string>${scope}</string>
</dict>
</plist>
`
}
