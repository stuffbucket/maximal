/**
 * Wire Claude Desktop's **third-party (Cowork 3P)** mode at the local
 * gateway.
 */

import { createHash, randomUUID } from "node:crypto"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { z } from "zod"

import { currentProfileId } from "~/apps/profile-identity"
import { resolveApiKey } from "~/lib/auth/api-key-helper"
import {
  AtomicWriteConflictError,
  atomicWriteJson as atomicWriteJsonShared,
  readFileNoFollow,
} from "~/lib/platform/atomic-json"
import { parseJsonText } from "~/lib/platform/json-text"
import { proxyBaseUrl } from "~/lib/start/proxy-port"

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

/** The label Claude Desktop's key is provisioned and attributed under
 *  (Settings → API clients). */
export const DESKTOP_KEY_LABEL = "claude-desktop"

/**
 * The profile we write. The key is looked up, never minted: this also runs
 * for status checks, which must not create keys. Enable provisions it first
 * (`ensureApiKey`); before that, an empty key just means "not applied".
 */
export function gatewayProfile(
  home: string = os.homedir(),
  baseUrl: string = proxyBaseUrl(),
): GatewayProfileValues {
  const key = resolveApiKey(DESKTOP_KEY_LABEL)
  return {
    inferenceProvider: "gateway",
    inferenceGatewayBaseUrl: baseUrl,
    inferenceGatewayApiKey: key.ok ? key.key : "",
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

/** Ids become file names; anything else is never ours and never touched. */
const SAFE_PROFILE_ID = /^[\w-]+$/

const MetaEntrySchema = z.looseObject({ id: z.string(), name: z.string() })
type MetaEntry = z.infer<typeof MetaEntrySchema>

/** Desktop's library index. Loose so fields a newer Desktop adds survive
 *  our rewrite. */
const MetaFileSchema = z.looseObject({
  appliedId: z.string(),
  entries: z.array(MetaEntrySchema),
})
type MetaFile = z.infer<typeof MetaFileSchema>

/** The `_meta.json` entry name that marks a profile as ours. Desktop shows
 *  it in its profile list, so it doubles as an honest label. */
const OWNED_ENTRY_NAME = "maximal"

/** Older builds named their entry "Default" and always wrote this URL and
 *  placeholder key. Such an entry counts as ours only when its profile still
 *  says exactly that — a user's own "Default" profile, even one pointing at
 *  another local gateway, never matches. */
const LEGACY_ENTRY_NAME = "Default"
const LEGACY_GATEWAY_URL = "http://127.0.0.1:4141"
const LEGACY_GATEWAY_KEY = "anything"

/**
 * What we need to put Desktop back the way we found it. Kept next to
 * Desktop's own config rather than in maximal's home: if the user wipes
 * `Claude-3p`, the snapshot goes with it, so we can never "restore" a
 * selection that no longer exists.
 */
const ROUTING_STATE_FILE = "maximal-routing.json"

const RoutingStateSchema = z.object({
  version: z.literal(2).optional(),
  ownerProfileId: z.string().optional(),
  profileId: z.string().regex(SAFE_PROFILE_ID),
  /** sha256 of the profile file as we wrote it — an edit means it's no
   *  longer ours to delete or overwrite. */
  fingerprint: z.string(),
  prior: z.object({
    appliedId: z.string(),
    /** Absent key = it was absent before; restore by deleting. */
    deploymentMode: z.unknown().optional(),
    coworkWebSearchEnabled: z.unknown().optional(),
    hadPreferences: z.boolean(),
  }),
})
type RoutingState = z.infer<typeof RoutingStateSchema>

/** Older builds kept no snapshot, so what Desktop had selected before is
 *  unknown: reverting deselects our profile and drops the keys we added. */
const LEGACY_PRIOR: RoutingState["prior"] = {
  appliedId: "",
  hadPreferences: true,
}

export type ConfigLibraryConflict =
  | "cleanup-required"
  | "foreign-gateway-profile"
  | "other-maximal-config"
  | "unreadable-profile"

function profileMatches(
  existing: Record<string, unknown> | null,
  values: GatewayProfileValues,
): boolean {
  if (!existing) return false
  return (Object.keys(values) as Array<keyof GatewayProfileValues>).every(
    (k) => JSON.stringify(existing[k]) === JSON.stringify(values[k]),
  )
}

/** The gateway shape only we write: a 127.0.0.1 gateway with the
 *  deployment-mode chooser hidden. */
function isOurGatewayShape(profile: Record<string, unknown> | null): boolean {
  return (
    profile?.inferenceProvider === "gateway"
    && profile.disableDeploymentModeChooser === true
    && typeof profile.inferenceGatewayBaseUrl === "string"
    && /^http:\/\/127\.0\.0\.1:\d+$/.test(profile.inferenceGatewayBaseUrl)
  )
}

/** The two fields that differ between Maximal copies (port and key). */
const ROUTING_FIELDS: ReadonlySet<string> = new Set([
  "inferenceGatewayBaseUrl",
  "inferenceGatewayApiKey",
])

/** Exactly the fields Maximal writes, nothing more, every one except the
 *  gateway URL and key equal to this copy's values: a profile any Maximal
 *  copy wrote, whichever copy. Any other edit is the user's. */
function isMaximalArtifactShape(
  profile: Record<string, unknown> | null,
  values: GatewayProfileValues,
): profile is Record<string, unknown> {
  if (!profile || !isOurGatewayShape(profile)) return false
  const keys = Object.keys(values) as Array<keyof GatewayProfileValues>
  if (
    Object.keys(profile).length !== keys.length
    || !keys.every((key) => Object.hasOwn(profile, key))
  ) {
    return false
  }
  if (
    typeof profile.inferenceGatewayApiKey !== "string"
    || profile.inferenceGatewayApiKey === ""
  ) {
    return false
  }
  return keys.every(
    (key) =>
      ROUTING_FIELDS.has(key)
      || JSON.stringify(profile[key]) === JSON.stringify(values[key]),
  )
}

function routingPair(profile: {
  inferenceGatewayBaseUrl?: unknown
  inferenceGatewayApiKey?: unknown
}): string {
  return JSON.stringify([
    profile.inferenceGatewayBaseUrl,
    profile.inferenceGatewayApiKey,
  ])
}

function sha256(content: string | Buffer): string {
  return createHash("sha256").update(content).digest("hex")
}

function isLegacyGatewayProfile(
  profile: Record<string, unknown> | null,
): boolean {
  return (
    isOurGatewayShape(profile)
    && profile?.inferenceGatewayBaseUrl === LEGACY_GATEWAY_URL
    && profile.inferenceGatewayApiKey === LEGACY_GATEWAY_KEY
  )
}

function readJsonText(file: string): string | null {
  return readFileNoFollow(
    file,
    () => new Error("refusing to read Claude Desktop config: symbolic link"),
  )
}

export function readJsonObject(file: string): Record<string, unknown> | null {
  const raw = readJsonText(file)
  if (raw === null) return null
  try {
    const parsed: unknown = parseJsonText(raw)
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
export function atomicWriteJson(
  file: string,
  value: unknown,
  expectedContent?: string | null,
): void {
  atomicWriteJsonShared(file, value, {
    label: "Claude Desktop config",
    ...(expectedContent !== undefined ? { expectedContent } : {}),
  })
}

function fileFingerprint(file: string): string | null {
  try {
    return sha256(fs.readFileSync(file))
  } catch {
    return null
  }
}

/**
 * Does the profile still say what the marker recorded? Claude Desktop
 * rewrites library profiles in its own formatting (no trailing newline, and
 * possibly another key order), so besides the exact bytes, the parsed
 * content serialized the way Maximal writes it also counts. Any change to a
 * value still breaks the match.
 */
function fingerprintMatches(
  file: string,
  fingerprint: string,
  keyOrder: Array<string>,
): boolean {
  if (fileFingerprint(file) === fingerprint) return true
  const parsed = readJsonObject(file)
  if (!parsed) return false
  const candidates: Array<Record<string, unknown>> = [parsed]
  if (
    Object.keys(parsed).length === keyOrder.length
    && keyOrder.every((key) => Object.hasOwn(parsed, key))
  ) {
    candidates.push(Object.fromEntries(keyOrder.map((k) => [k, parsed[k]])))
  }
  return candidates.some(
    (value) => sha256(`${JSON.stringify(value, null, 2)}\n`) === fingerprint,
  )
}

/** Desktop's config library, read once, with ownership resolved. */
class Library {
  readonly dir: string
  readonly libDir: string
  readonly metaPath: string
  readonly topPath: string
  readonly statePath: string
  readonly metaRaw: string | null
  readonly topRaw: string | null
  readonly stateRaw: string | null
  readonly meta: MetaFile
  /** `_meta.json` exists but isn't a library index we understand. Nothing
   *  is written then — rebuilding it would drop the user's entries. */
  readonly metaUnreadable: boolean
  readonly stateUnreadable: boolean
  readonly state: RoutingState | null

  constructor(dir: string) {
    this.dir = dir
    this.libDir = path.join(dir, "configLibrary")
    this.metaPath = path.join(this.libDir, "_meta.json")
    this.topPath = path.join(dir, "claude_desktop_config.json")
    this.statePath = path.join(dir, ROUTING_STATE_FILE)
    this.metaRaw = readJsonText(this.metaPath)
    this.topRaw = readJsonText(this.topPath)
    this.stateRaw = readJsonText(this.statePath)
    const meta =
      this.metaRaw !== null ?
        MetaFileSchema.safeParse(readJsonObject(this.metaPath))
      : null
    this.metaUnreadable = meta !== null && !meta.success
    this.meta = meta?.success ? meta.data : { appliedId: "", entries: [] }
    const state = RoutingStateSchema.safeParse(readJsonObject(this.statePath))
    this.stateUnreadable =
      this.stateRaw !== null
      && (!state.success
        || (state.data.version === 2
          && typeof state.data.ownerProfileId !== "string"))
    this.state = state.success && !this.stateUnreadable ? state.data : null
  }

  profilePath(id: string): string {
    if (!SAFE_PROFILE_ID.test(id)) {
      throw new Error("refusing to address an unsafe Claude Desktop profile id")
    }
    return path.join(this.libDir, `${id}.json`)
  }

  profile(id: string): Record<string, unknown> | null {
    return SAFE_PROFILE_ID.test(id) ?
        readJsonObject(this.profilePath(id))
      : null
  }

  routingStateOwnership(): "ours" | "other-maximal" | null {
    const { state } = this
    if (state?.version !== 2 || !state.ownerProfileId) return null
    return state.ownerProfileId === currentProfileId() ?
        "ours"
      : "other-maximal"
  }

  stateEntryOwnership(
    values: GatewayProfileValues,
  ): "ours" | "other-maximal" | null {
    const id = this.state?.profileId
    if (!id || !SAFE_PROFILE_ID.test(id)) return null
    const entry = this.meta.entries.find((item) => item.id === id)
    return entry ? this.entryOwnership(entry, values) : null
  }

  stateOwnership(
    entry: MetaEntry,
    values: GatewayProfileValues,
  ): "ours" | "other-maximal" | null {
    if (!SAFE_PROFILE_ID.test(entry.id) || this.state?.profileId !== entry.id) {
      return null
    }
    const stateOwner = this.routingStateOwnership()
    if (stateOwner) return stateOwner
    return (
        this.profile(entry.id)?.inferenceGatewayBaseUrl
          === values.inferenceGatewayBaseUrl
      ) ?
        "ours"
      : "other-maximal"
  }

  entryOwnership(
    entry: MetaEntry,
    values: GatewayProfileValues,
  ): "ours" | "other-maximal" | null {
    if (!SAFE_PROFILE_ID.test(entry.id)) return null
    const profile = this.profile(entry.id)
    const stateOwnership = this.stateOwnership(entry, values)
    if (stateOwnership) {
      if (!isOurGatewayShape(profile) || !this.isUnedited(entry, values)) {
        return null
      }
      return stateOwnership
    }
    const legacyShape =
      (entry.name === OWNED_ENTRY_NAME && isOurGatewayShape(profile))
      || (entry.name === LEGACY_ENTRY_NAME && isLegacyGatewayProfile(profile))
    if (!legacyShape) return null
    return profile?.inferenceGatewayBaseUrl === values.inferenceGatewayBaseUrl ?
        "ours"
      : "other-maximal"
  }

  ownedEntries(
    values: GatewayProfileValues,
    ownership: "ours" | "other-maximal" = "ours",
  ): Array<MetaEntry> {
    return this.meta.entries.filter(
      (entry) => this.entryOwnership(entry, values) === ownership,
    )
  }

  /** Our applied profile already says exactly what we'd write. */
  isCurrent(
    entry: MetaEntry | null,
    values: GatewayProfileValues,
    top: Record<string, unknown>,
  ): boolean {
    return (
      entry?.name === OWNED_ENTRY_NAME
      && this.entryOwnership(entry, values) === "ours"
      && profileMatches(this.profile(entry.id), values)
      && top.deploymentMode === "3p"
    )
  }

  /** A safe profile entry to write. Another profile's entry is reusable only
   *  during an explicit transfer, and only while its fingerprint still matches. */
  reusableEntry(
    values: GatewayProfileValues,
    allowOtherMaximal: boolean,
  ): MetaEntry | null {
    const reusable = this.meta.entries.filter((entry) => {
      const ownership = this.entryOwnership(entry, values)
      return (
        (ownership === "ours"
          || (allowOtherMaximal && ownership === "other-maximal"))
        && this.isUnedited(entry, values)
      )
    })
    return (
      reusable.find((entry) => entry.id === this.meta.appliedId)
      ?? reusable.at(0)
      ?? null
    )
  }

  appliedOwnership(
    values: GatewayProfileValues,
  ): "ours" | "other-maximal" | null {
    const entry = this.meta.entries.find(
      (item) => item.id === this.meta.appliedId,
    )
    return entry ? this.entryOwnership(entry, values) : null
  }

  /** Who the marker says owns routing: its recorded owner, or for an older
   *  ownerless marker, the attribution of its own entry. Whatever Desktop
   *  has applied, only an explicit transfer may take another copy's marker. */
  markerOwnership(
    values: GatewayProfileValues,
  ): "ours" | "other-maximal" | null {
    return this.routingStateOwnership() ?? this.stateEntryOwnership(values)
  }

  /**
   * The applied entry is the marker's own `maximal` entry with exactly the
   * fields Maximal writes, but its gateway URL or key no longer traces to a
   * Maximal write (the sibling it was copied from is gone, or a key
   * rotated). An explicit Take over repairs it in place under the marker's
   * snapshot rather than keeping a dead duplicate to switch back to. Any
   * other edit keeps it the user's.
   */
  appliedMarkerArtifact(values: GatewayProfileValues): MetaEntry | null {
    const entry = this.meta.entries.find(
      (item) => item.id === this.meta.appliedId,
    )
    if (
      !entry
      || entry.name !== OWNED_ENTRY_NAME
      || this.state?.profileId !== entry.id
      || !SAFE_PROFILE_ID.test(entry.id)
    ) {
      return null
    }
    return isMaximalArtifactShape(this.profile(entry.id), values) ? entry : null
  }

  /** Someone else's selection we mustn't switch away from on our own: a
   *  readable gateway profile (`foreign`, which an explicit take over may
   *  switch from), or a profile we can't read or safely address
   *  (`unreadable`, so can't rule one out and never switch from). */
  appliedBlock(values: GatewayProfileValues): "foreign" | "unreadable" | null {
    const id = this.meta.appliedId
    if (!id || this.appliedOwnership(values)) return null
    if (!SAFE_PROFILE_ID.test(id)) return "unreadable"
    if (!fs.existsSync(this.profilePath(id))) return null
    const profile = this.profile(id)
    if (profile === null) return "unreadable"
    return profile.inferenceProvider === undefined ? null : "foreign"
  }

  /** Deleting or overwriting is safe only for a profile exactly as Maximal
   *  wrote it. The marker's profile qualifies when it still matches the
   *  marker's fingerprint, or when it is a stale Maximal artifact (below). A
   *  legacy profile predates fingerprints, so its exact shape stands in; any
   *  other profile is left alone. */
  isUnedited(entry: MetaEntry, values: GatewayProfileValues): boolean {
    if (!SAFE_PROFILE_ID.test(entry.id)) return false
    if (this.state?.profileId === entry.id) {
      return (
        fingerprintMatches(
          this.profilePath(entry.id),
          this.state.fingerprint,
          Object.keys(values),
        ) || this.isStaleMaximalArtifact(entry, values)
      )
    }
    return (
      entry.name === LEGACY_ENTRY_NAME
      && isLegacyGatewayProfile(this.profile(entry.id))
    )
  }

  /**
   * The marker's profile no longer says what the marker recorded, yet it is
   * still exactly a Maximal artifact: our entry name, exactly the fields
   * Maximal writes, and a gateway URL and key that a Maximal write produced,
   * either this copy's own or another `maximal` entry's in the library. That
   * is what Claude Desktop leaves when it writes a stale copy of an earlier
   * Maximal profile back over ours. A user's edit (another gateway or key,
   * folder, flag, extra field, or a renamed entry) never matches.
   */
  isStaleMaximalArtifact(
    entry: MetaEntry,
    values: GatewayProfileValues,
  ): boolean {
    if (entry.name !== OWNED_ENTRY_NAME || this.state?.profileId !== entry.id) {
      return false
    }
    const profile = this.profile(entry.id)
    if (!isMaximalArtifactShape(profile, values)) return false
    const pair = routingPair(profile)
    if (pair === routingPair(values)) return true
    return this.meta.entries.some((other) => {
      if (other.id === entry.id || other.name !== OWNED_ENTRY_NAME) return false
      const sibling = this.profile(other.id)
      return (
        isMaximalArtifactShape(sibling, values) && routingPair(sibling) === pair
      )
    })
  }

  writeMeta(appliedId: string, entries: Array<MetaEntry>): void {
    atomicWriteJson(
      this.metaPath,
      { ...this.meta, appliedId, entries },
      this.metaRaw,
    )
  }
}

export interface ApplyConfigLibraryOptions {
  /** Replace routing owned by another valid Maximal profile. */
  overrideOtherMaximal?: boolean
  /** Switch Desktop away from a readable gateway profile Maximal doesn't
   *  own. That profile is never written; the snapshot switches back on
   *  revert. Unreadable files and other profiles' markers still refuse. */
  overrideForeignGateway?: boolean
}

export interface ApplyConfigLibraryResult {
  dir: string
  profileId: string
  wrote: boolean
  ensuredWorkspaceFolders: Array<string>
  /** Set when enable was refused and nothing was written. */
  conflict: ConfigLibraryConflict | null
}

function applyConflict(
  lib: Library,
  values: GatewayProfileValues,
  options: ApplyConfigLibraryOptions,
): ConfigLibraryConflict | null {
  if (lib.stateUnreadable) return "cleanup-required"
  const stateOwner = lib.routingStateOwnership()
  if (
    stateOwner === "other-maximal"
    && lib.stateEntryOwnership(values) !== stateOwner
  ) {
    return "cleanup-required"
  }
  if (
    (lib.markerOwnership(values) === "other-maximal"
      || lib.appliedOwnership(values) === "other-maximal")
    && options.overrideOtherMaximal !== true
  ) {
    return "other-maximal-config"
  }
  const block = lib.appliedBlock(values)
  if (block === "unreadable") return "unreadable-profile"
  return block === "foreign" && options.overrideForeignGateway !== true ?
      "foreign-gateway-profile"
    : null
}

export function applyConfigLibraryProfile(
  home: string = os.homedir(),
  values: GatewayProfileValues = gatewayProfile(home),
  options: ApplyConfigLibraryOptions = {},
): ApplyConfigLibraryResult {
  const lib = new Library(getClaude3pDir(home))
  if (lib.metaUnreadable) {
    throw new Error(
      `Claude Desktop's config library index (${lib.metaPath}) isn't readable;`
        + " left it untouched rather than rebuild it without your profiles.",
    )
  }
  const { meta } = lib
  const appliedOwnership = lib.appliedOwnership(values)
  // Switching away from someone else's gateway would silently take over
  // their routing, so it needs an explicit take over. Non-gateway profiles
  // carry no routing, so switching from one is safe. Either way the snapshot
  // below switches back on revert.
  const conflict = applyConflict(lib, values, options)
  if (conflict) {
    return {
      dir: lib.dir,
      profileId: "",
      wrote: false,
      ensuredWorkspaceFolders: [],
      conflict,
    }
  }

  const repair =
    options.overrideForeignGateway === true ?
      lib.appliedMarkerArtifact(values)
    : null
  const ourEntry =
    repair ?? lib.reusableEntry(values, options.overrideOtherMaximal === true)
  const profileId = ourEntry?.id ?? randomUUID()
  const ensuredWorkspaceFolders = ensureWorkspaceFolders(
    values.allowedWorkspaceFolders,
  )
  const top = readJsonObject(lib.topPath) ?? {}
  const unchanged = { dir: lib.dir, profileId, ensuredWorkspaceFolders }
  if (appliedOwnership === "ours" && lib.isCurrent(ourEntry, values, top)) {
    return { ...unchanged, wrote: false, conflict: null }
  }

  // Re-applying over a Maximal profile (or repairing the marker's own entry)
  // keeps the marker's snapshot; see `priorFor` for a switch from elsewhere.
  const prior = priorFor(lib, Boolean(appliedOwnership || repair), top)

  const profilePath = lib.profilePath(profileId)
  atomicWriteJson(profilePath, values, readJsonText(profilePath))

  const ours = { id: profileId, name: OWNED_ENTRY_NAME }
  const entries =
    ourEntry ?
      meta.entries.map((e) => (e.id === profileId ? ours : e))
    : [...meta.entries, ours]
  lib.writeMeta(profileId, entries)

  top.deploymentMode = "3p"
  top.preferences = { ...readPreferences(top), coworkWebSearchEnabled: true }
  atomicWriteJson(lib.topPath, top, lib.topRaw)

  const state: RoutingState = {
    version: 2,
    ownerProfileId: currentProfileId(),
    profileId,
    fingerprint: fileFingerprint(profilePath) ?? "",
    prior,
  }
  atomicWriteJson(lib.statePath, state, lib.stateRaw)

  return { ...unchanged, wrote: true, conflict: null }
}

/**
 * What disable restores. Over a Maximal profile, the marker's snapshot as
 * is. Switching to us from someone else's selection while a marker exists
 * keeps the marker's first top-level snapshot (those keys are still
 * Maximal's) and only records the selection to switch back to. With no
 * marker, snapshot what's there now.
 */
function priorFor(
  lib: Library,
  overMaximalProfile: boolean,
  top: Record<string, unknown>,
): RoutingState["prior"] {
  if (overMaximalProfile) return lib.state?.prior ?? LEGACY_PRIOR
  if (lib.state) return { ...lib.state.prior, appliedId: lib.meta.appliedId }
  return snapshotPrior(lib.meta.appliedId, top)
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

/** Would enable (with these overrides) be refused? Lets callers skip side
 *  effects (like minting a key) for an enable that won't take effect. */
export function configLibraryConflict(
  home: string = os.homedir(),
  values: GatewayProfileValues = gatewayProfile(home),
  options: ApplyConfigLibraryOptions = {},
): ConfigLibraryConflict | null {
  return applyConflict(new Library(getClaude3pDir(home)), values, options)
}

export function isConfigLibraryApplied(
  home: string = os.homedir(),
  values: GatewayProfileValues = gatewayProfile(home),
): boolean {
  const lib = new Library(getClaude3pDir(home))
  if (lib.stateUnreadable || lib.appliedOwnership(values) !== "ours") {
    return false
  }
  if (!profileMatches(lib.profile(lib.meta.appliedId), values)) return false
  return readJsonObject(lib.topPath)?.deploymentMode === "3p"
}

/** Who the routing marker says owns Desktop routing. Boot uses it to tell a
 *  real hand-off to another copy from a stale copy's entry being applied
 *  while this profile still holds the marker. */
export function routingMarkerOwnership(
  home: string = os.homedir(),
  values: GatewayProfileValues = gatewayProfile(home),
): "ours" | "other-maximal" | null {
  const lib = new Library(getClaude3pDir(home))
  return lib.stateUnreadable ? null : lib.markerOwnership(values)
}

/** Whether this Maximal profile may update its Desktop MCP entry. */
export function claudeDesktopMcpWritable(home: string = os.homedir()): boolean {
  const lib = new Library(getClaude3pDir(home))
  return !lib.stateUnreadable && lib.routingStateOwnership() !== "other-maximal"
}

export interface RevertResult {
  dir: string
  reverted: boolean
  /** Our profiles the user edited after we wrote them — left on disk. */
  kept: Array<string>
}

interface RevertOwnership {
  protectedByOtherProfile: boolean
  wasApplied: boolean
  stateEntry: MetaEntry | null
  stateIsOurs: boolean
}

function inspectRevertOwnership(
  lib: Library,
  values: GatewayProfileValues,
): RevertOwnership {
  const { meta, state } = lib
  const appliedEntry =
    meta.entries.find((entry) => entry.id === meta.appliedId) ?? null
  const appliedStateOwnership =
    appliedEntry ? lib.stateOwnership(appliedEntry, values) : null
  const appliedOwnership = lib.appliedOwnership(values)
  const stateEntry =
    state && SAFE_PROFILE_ID.test(state.profileId) ?
      (meta.entries.find((entry) => entry.id === state.profileId) ?? null)
    : null
  const stateIsOurs =
    stateEntry !== null && lib.stateOwnership(stateEntry, values) === "ours"
  return {
    protectedByOtherProfile:
      appliedOwnership === "other-maximal"
      || appliedStateOwnership === "other-maximal",
    wasApplied: appliedOwnership === "ours" || appliedStateOwnership === "ours",
    stateEntry,
    stateIsOurs,
  }
}

function revertCandidates(
  lib: Library,
  values: GatewayProfileValues,
  ownership: RevertOwnership,
): Array<MetaEntry> {
  const owned = lib.ownedEntries(values)
  if (
    ownership.stateIsOurs
    && ownership.stateEntry
    && SAFE_PROFILE_ID.test(ownership.stateEntry.id)
    && !owned.some((entry) => entry.id === ownership.stateEntry?.id)
  ) {
    return [...owned, ownership.stateEntry]
  }
  return owned
}

function removeOwnedProfiles(
  lib: Library,
  candidates: Array<MetaEntry>,
  values: GatewayProfileValues,
): { kept: Array<string>; removed: Set<string> } {
  const kept: Array<string> = []
  const removed = new Set<string>()
  for (const entry of candidates) {
    if (!SAFE_PROFILE_ID.test(entry.id)) continue
    const profilePath = lib.profilePath(entry.id)
    if (!lib.isUnedited(entry, values)) {
      kept.push(profilePath)
      continue
    }
    const expected = readJsonText(profilePath)
    if (readJsonText(profilePath) !== expected) {
      throw new AtomicWriteConflictError(
        "Claude Desktop profile changed before it could be removed",
      )
    }
    try {
      fs.rmSync(profilePath, { force: true })
    } catch {
      /* best effort */
    }
    removed.add(entry.id)
  }
  return { kept, removed }
}

function removeOwnedRoutingState(lib: Library, stateIsOurs: boolean): boolean {
  if (!stateIsOurs) return false
  if (readJsonText(lib.statePath) !== lib.stateRaw) {
    throw new AtomicWriteConflictError(
      "Claude Desktop routing state changed before it could be removed",
    )
  }
  try {
    fs.rmSync(lib.statePath, { force: true })
  } catch {
    /* best effort */
  }
  return true
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
  // An index we can't read can't tell us what's ours; keep the snapshot so a
  // later revert, once the index is fixed, can still restore from it.
  if (lib.metaUnreadable) return { dir: lib.dir, reverted: false, kept: [] }
  const { meta, state } = lib
  const values = gatewayProfile(home)
  const ownership = inspectRevertOwnership(lib, values)
  if (ownership.protectedByOtherProfile) {
    return { dir: lib.dir, reverted: false, kept: [] }
  }
  const { kept, removed } = removeOwnedProfiles(
    lib,
    revertCandidates(lib, values, ownership),
    values,
  )

  const entries = meta.entries.filter((e) => !removed.has(e.id))
  let appliedId = meta.appliedId
  if (ownership.wasApplied) {
    const priorId = state?.prior.appliedId ?? ""
    appliedId = entries.some((e) => e.id === priorId) ? priorId : ""
  }
  const metaChanged = removed.size > 0 || appliedId !== meta.appliedId
  if (metaChanged) lib.writeMeta(appliedId, entries)

  const topChanged =
    ownership.wasApplied && restoreTop(lib.topPath, state, lib.topRaw)

  const removedState = removeOwnedRoutingState(lib, ownership.stateIsOurs)

  return {
    dir: lib.dir,
    reverted: metaChanged || topChanged || removedState,
    kept,
  }
}

/** Put back the top-level keys we set. Without a snapshot (written by an
 *  older build) only `deploymentMode` is known to be ours. */
function restoreTop(
  topPath: string,
  state: RoutingState | null,
  expectedContent: string | null,
): boolean {
  const top = readJsonObject(topPath)
  if (!top) return false
  if (!state) {
    if (!("deploymentMode" in top)) return false
    delete top.deploymentMode
    atomicWriteJson(topPath, top, expectedContent)
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

  atomicWriteJson(topPath, top, expectedContent)
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
