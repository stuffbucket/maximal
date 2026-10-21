/**
 * Wire Claude Desktop's **third-party (Cowork 3P)** mode at the local
 * gateway.
 */

import { createHash, randomUUID } from "node:crypto"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import { atomicWriteJson as atomicWriteJsonShared } from "~/lib/platform/atomic-json"

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
  isLocalDevMcpEnabled: boolean
  isDesktopExtensionEnabled: boolean
  isDesktopExtensionDirectoryEnabled: boolean
  isDesktopExtensionSignatureRequired: boolean
  isClaudeCodeForDesktopEnabled: boolean
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
    // Artifacts preview (favicon/iframe fetch), NOT a telemetry knob despite
    // the name — must stay false or Artifacts previews break.
    disableNonessentialServices: false,
    disableAutoUpdates: false,
    // MCP/extension surface, dropped by 3a36604 (PR #159) while it fixed the
    // configLibrary directory bug (#160). Their absence collapses to a locked
    // default once any managed config source is present, which is what
    // blocked MCPs and Plugins in Claude Desktop (#188).
    isLocalDevMcpEnabled: true,
    isDesktopExtensionEnabled: true,
    isDesktopExtensionDirectoryEnabled: true,
    isDesktopExtensionSignatureRequired: false,
    isClaudeCodeForDesktopEnabled: true,
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

interface MetaEntry {
  id: string
  name: string
}

interface MetaFile {
  appliedId: string
  entries: Array<MetaEntry>
}

/** The `_meta.json` entry name that marks a profile as ours. Desktop shows
 *  it in its profile list, so it doubles as an honest label. */
const OWNED_ENTRY_NAME = "maximal"

/** Older builds named their entry "Default" and sent this placeholder key.
 *  Such an entry counts as ours only when its profile still has that exact
 *  loopback-gateway shape — a user's own "Default" profile never matches. */
const LEGACY_ENTRY_NAME = "Default"
const LEGACY_GATEWAY_KEY = "anything"

/**
 * What we need to put Desktop back the way we found it. Kept next to
 * Desktop's own config rather than in maximal's home: if the user wipes
 * `Claude-3p`, the snapshot goes with it, so we can never "restore" a
 * selection that no longer exists.
 */
const ROUTING_STATE_FILE = "maximal-routing.json"

interface RoutingState {
  profileId: string
  /** sha256 of the profile file as we wrote it — an edit means it's no
   *  longer ours to delete. */
  fingerprint: string
  prior: {
    appliedId: string
    /** Absent key = it was absent before; restore by deleting. */
    deploymentMode?: unknown
    coworkWebSearchEnabled?: unknown
    hadPreferences: boolean
  }
}

/** Older builds kept no snapshot, so what Desktop had selected before is
 *  unknown: reverting deselects our profile and drops the keys we added. */
const LEGACY_PRIOR: RoutingState["prior"] = {
  appliedId: "",
  hadPreferences: true,
}

export type ConfigLibraryConflict = "foreign-gateway-profile"

function profileMatches(
  existing: Record<string, unknown> | null,
  values: GatewayProfileValues,
): boolean {
  if (!existing) return false
  return (Object.keys(values) as Array<keyof GatewayProfileValues>).every(
    (k) => JSON.stringify(existing[k]) === JSON.stringify(values[k]),
  )
}

function isLegacyGatewayProfile(
  profile: Record<string, unknown> | null,
): boolean {
  return (
    profile?.inferenceProvider === "gateway"
    && profile.inferenceGatewayApiKey === LEGACY_GATEWAY_KEY
    && typeof profile.inferenceGatewayBaseUrl === "string"
    && /^http:\/\/(?:127\.0\.0\.1|localhost)(?::\d+)?\/?$/.test(
      profile.inferenceGatewayBaseUrl,
    )
  )
}

export function readJsonObject(file: string): Record<string, unknown> | null {
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

/** Thin wrapper over the shared guarded writer so call sites stay terse and
 *  every Claude Desktop write refuses to follow a pre-planted `<file>.tmp`
 *  symlink (EEXIST → clear error) — the guard that only Claude Code had
 *  before #231. */
export function atomicWriteJson(file: string, value: unknown): void {
  atomicWriteJsonShared(file, value, { label: "Claude Desktop config" })
}

function fileFingerprint(file: string): string | null {
  try {
    return createHash("sha256").update(fs.readFileSync(file)).digest("hex")
  } catch {
    return null
  }
}

/** Desktop's config library, read once, with ownership resolved. */
class Library {
  readonly dir: string
  readonly libDir: string
  readonly metaPath: string
  readonly topPath: string
  readonly statePath: string
  readonly meta: MetaFile
  readonly state: RoutingState | null

  constructor(dir: string) {
    this.dir = dir
    this.libDir = path.join(dir, "configLibrary")
    this.metaPath = path.join(this.libDir, "_meta.json")
    this.topPath = path.join(dir, "claude_desktop_config.json")
    this.statePath = path.join(dir, ROUTING_STATE_FILE)
    this.meta = (readJsonObject(this.metaPath) as MetaFile | null) ?? {
      appliedId: "",
      entries: [],
    }
    this.state = readJsonObject(this.statePath) as RoutingState | null
  }

  profilePath(id: string): string {
    return path.join(this.libDir, `${id}.json`)
  }

  profile(id: string): Record<string, unknown> | null {
    return id ? readJsonObject(this.profilePath(id)) : null
  }

  isOwned(entry: MetaEntry): boolean {
    if (entry.name === OWNED_ENTRY_NAME) return true
    return (
      entry.name === LEGACY_ENTRY_NAME
      && isLegacyGatewayProfile(this.profile(entry.id))
    )
  }

  ownedEntries(): Array<MetaEntry> {
    return this.meta.entries.filter((e) => this.isOwned(e))
  }

  /** Our applied profile already says exactly what we'd write. */
  isCurrent(
    entry: MetaEntry | null,
    values: GatewayProfileValues,
    top: Record<string, unknown>,
  ): boolean {
    return (
      entry?.name === OWNED_ENTRY_NAME
      && profileMatches(this.profile(entry.id), values)
      && top.deploymentMode === "3p"
    )
  }

  /** Our entry to (re)write — the applied one if Desktop is on ours. */
  ourEntry(): MetaEntry | null {
    const owned = this.ownedEntries()
    return (
      owned.find((e) => e.id === this.meta.appliedId) ?? owned.at(0) ?? null
    )
  }

  appliedIsOurs(): boolean {
    return this.ownedEntries().some((e) => e.id === this.meta.appliedId)
  }

  /** Deleting is safe only for a profile exactly as we wrote it. A legacy
   *  profile predates fingerprints, so its shape stands in. */
  isUnedited(id: string): boolean {
    if (this.state?.profileId === id) {
      return fileFingerprint(this.profilePath(id)) === this.state.fingerprint
    }
    return isLegacyGatewayProfile(this.profile(id))
  }
}

export interface ApplyConfigLibraryResult {
  dir: string
  profileId: string
  wrote: boolean
  ensuredWorkspaceFolders: Array<string>
  /** Set when enable was refused and nothing was written. */
  conflict: ConfigLibraryConflict | null
}

export function applyConfigLibraryProfile(
  home: string = os.homedir(),
  values: GatewayProfileValues = gatewayProfile(home),
): ApplyConfigLibraryResult {
  const lib = new Library(getClaude3pDir(home))
  const { meta } = lib
  const appliedIsOurs = lib.appliedIsOurs()

  // Switching away from someone else's gateway would silently take over
  // their routing. Non-gateway profiles carry no routing, so switching from
  // one is safe — the snapshot below switches back on revert.
  if (!appliedIsOurs && isGatewayProfile(lib.profile(meta.appliedId))) {
    return {
      dir: lib.dir,
      profileId: "",
      wrote: false,
      ensuredWorkspaceFolders: [],
      conflict: "foreign-gateway-profile",
    }
  }

  const ourEntry = lib.ourEntry()
  const profileId = ourEntry?.id ?? randomUUID()
  const ensuredWorkspaceFolders = ensureWorkspaceFolders(
    values.allowedWorkspaceFolders,
  )
  const top = readJsonObject(lib.topPath) ?? {}
  const unchanged = { dir: lib.dir, profileId, ensuredWorkspaceFolders }
  if (appliedIsOurs && lib.isCurrent(ourEntry, values, top)) {
    return { ...unchanged, wrote: false, conflict: null }
  }

  // Snapshot what we're replacing on the switch to us; re-applying over our
  // own profile keeps the original snapshot.
  const prior =
    appliedIsOurs ?
      (lib.state?.prior ?? LEGACY_PRIOR)
    : snapshotPrior(meta.appliedId, top)

  const profilePath = lib.profilePath(profileId)
  atomicWriteJson(profilePath, values)

  const ours = { id: profileId, name: OWNED_ENTRY_NAME }
  const entries =
    ourEntry ?
      meta.entries.map((e) => (e.id === profileId ? ours : e))
    : [...meta.entries, ours]
  atomicWriteJson(lib.metaPath, { appliedId: profileId, entries })

  top.deploymentMode = "3p"
  top.preferences = { ...readPreferences(top), coworkWebSearchEnabled: true }
  atomicWriteJson(lib.topPath, top)

  const state: RoutingState = {
    profileId,
    fingerprint: fileFingerprint(profilePath) ?? "",
    prior,
  }
  atomicWriteJson(lib.statePath, state)

  return { ...unchanged, wrote: true, conflict: null }
}

function isGatewayProfile(profile: Record<string, unknown> | null): boolean {
  return profile?.inferenceProvider !== undefined
}

function readPreferences(
  top: Record<string, unknown>,
): Record<string, unknown> | null {
  return typeof top.preferences === "object" && top.preferences !== null ?
      (top.preferences as Record<string, unknown>)
    : null
}

function snapshotPrior(
  appliedId: string,
  top: Record<string, unknown>,
): RoutingState["prior"] {
  const prefs = readPreferences(top)
  return {
    appliedId,
    ...("deploymentMode" in top ? { deploymentMode: top.deploymentMode } : {}),
    ...(prefs && "coworkWebSearchEnabled" in prefs ?
      { coworkWebSearchEnabled: prefs.coworkWebSearchEnabled }
    : {}),
    hadPreferences: prefs !== null,
  }
}

export function isConfigLibraryApplied(
  home: string = os.homedir(),
  values: GatewayProfileValues = gatewayProfile(home),
): boolean {
  const lib = new Library(getClaude3pDir(home))
  if (!lib.appliedIsOurs()) return false
  if (!profileMatches(lib.profile(lib.meta.appliedId), values)) return false
  return readJsonObject(lib.topPath)?.deploymentMode === "3p"
}

export interface RevertResult {
  dir: string
  reverted: boolean
  /** Our profiles the user edited after we wrote them — left on disk. */
  kept: Array<string>
}

/**
 * Undo `applyConfigLibraryProfile`, touching only what we own: our
 * unedited profiles are deleted, and — if Desktop is still on our profile —
 * the prior selection and top-level keys are restored from the snapshot. A
 * profile the user selected or wrote themselves is never changed.
 */
export function revertConfigLibraryProfile(
  home: string = os.homedir(),
): RevertResult {
  const lib = new Library(getClaude3pDir(home))
  const { meta, state } = lib
  const owned = lib.ownedEntries()
  const wasApplied = lib.appliedIsOurs()
  const kept: Array<string> = []

  const removed = new Set<string>()
  for (const entry of owned) {
    if (lib.isUnedited(entry.id)) {
      try {
        fs.rmSync(lib.profilePath(entry.id), { force: true })
      } catch {
        /* best effort */
      }
      removed.add(entry.id)
    } else {
      kept.push(lib.profilePath(entry.id))
    }
  }

  const entries = meta.entries.filter((e) => !removed.has(e.id))
  let appliedId = meta.appliedId
  if (wasApplied) {
    const priorId = state?.prior.appliedId ?? ""
    appliedId = entries.some((e) => e.id === priorId) ? priorId : ""
  }
  const metaChanged = removed.size > 0 || appliedId !== meta.appliedId
  if (metaChanged) atomicWriteJson(lib.metaPath, { appliedId, entries })

  const topChanged = wasApplied && restoreTop(lib.topPath, state)

  try {
    fs.rmSync(lib.statePath, { force: true })
  } catch {
    /* best effort */
  }

  return { dir: lib.dir, reverted: metaChanged || topChanged, kept }
}

/** Put back the top-level keys we set. Without a snapshot (written by an
 *  older build) only `deploymentMode` is known to be ours. */
function restoreTop(topPath: string, state: RoutingState | null): boolean {
  const top = readJsonObject(topPath)
  if (!top) return false
  if (!state) {
    if (!("deploymentMode" in top)) return false
    delete top.deploymentMode
    atomicWriteJson(topPath, top)
    return true
  }

  const { prior } = state
  if ("deploymentMode" in prior) top.deploymentMode = prior.deploymentMode
  else delete top.deploymentMode

  const prefs =
    typeof top.preferences === "object" && top.preferences !== null ?
      { ...(top.preferences as Record<string, unknown>) }
    : {}
  if ("coworkWebSearchEnabled" in prior) {
    prefs.coworkWebSearchEnabled = prior.coworkWebSearchEnabled
  } else {
    delete prefs.coworkWebSearchEnabled
  }
  if (!prior.hadPreferences && Object.keys(prefs).length === 0) {
    delete top.preferences
  } else {
    top.preferences = prefs
  }

  atomicWriteJson(topPath, top)
  return true
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
