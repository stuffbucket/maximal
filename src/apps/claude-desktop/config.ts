/**
 * Wire Claude Desktop's **third-party (Cowork 3P)** mode at the local
 * gateway.
 */

import { randomUUID } from "node:crypto"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { z } from "zod"

import { currentProfileId } from "~/apps/profile-identity"
import { isGeneratedApiKey, resolveApiKey } from "~/lib/auth/api-key-helper"
import {
  AtomicWriteConflictError,
  atomicWriteJson as atomicWriteJsonShared,
  readFileNoFollow,
} from "~/lib/platform/atomic-json"
import { parseJsonText } from "~/lib/platform/json-text"
import { proxyBaseUrl } from "~/lib/start/proxy-port"

import { withMaximalDesktopManagedMcpServers } from "./managed-mcp"
import {
  fileFingerprint,
  fingerprintMatches,
  isClaudeSealedKey,
  keyFingerprintFor,
  keyFingerprintMatches,
  managedFingerprint,
} from "./marker-evidence"
import {
  hasExactFields,
  isMaximalArtifactShape,
  isOurGatewayShape,
  profileMatches,
  routingPair,
} from "./profile-shape"

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

/** Claude's local 3P data directory per Anthropic's "Configuration
 *  implementation" page: `~/Library/Application Support/Claude-3p` (macOS),
 *  `%LOCALAPPDATA%\Claude-3p` (Windows), `~/.config/Claude-3p` (Linux). A
 *  Windows install packaged as MSIX may keep its data under its package
 *  folder instead; Anthropic doesn't document that location, so it is not
 *  guessed and not detected here. */
export function getClaude3pDir(
  home: string = os.homedir(),
  platform: NodeJS.Platform = process.platform,
): string {
  if (platform === "win32") {
    const localAppData =
      process.env.LOCALAPPDATA ?? path.join(home, "AppData", "Local")
    return path.join(localAppData, `Claude${USERDATA_3P_SUFFIX}`)
  }
  if (platform === "linux") {
    // Anthropic: `~/.config/Claude-3p/configLibrary/`. Electron's userData
    // follows XDG_CONFIG_HOME, but only for the current user: an explicit
    // other `home` (a fixture, another account) gets its own `.config`. A
    // relative XDG_CONFIG_HOME is ignored, as the XDG spec says.
    const xdg = process.env.XDG_CONFIG_HOME
    const base =
      xdg && path.isAbsolute(xdg) && home === os.homedir() ?
        xdg
      : path.join(home, ".config")
    return path.join(base, `Claude${USERDATA_3P_SUFFIX}`)
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

const HEX_DIGEST = /^[0-9a-f]{64}$/

const RoutingStateSchema = z.object({
  version: z.literal(2).optional(),
  ownerProfileId: z.string().optional(),
  profileId: z.string().regex(SAFE_PROFILE_ID),
  /** sha256 of the profile file as we wrote it — an edit means it's no
   *  longer ours to delete or overwrite. */
  fingerprint: z.string(),
  /** Evidence that survives Claude sealing the key (see marker-evidence):
   *  the managed fields except the key, and an HMAC of the plaintext key
   *  under this profile's own secret. Absent from older markers. */
  managedFingerprint: z.string().regex(HEX_DIGEST).optional(),
  keyFingerprint: z.string().regex(HEX_DIGEST).optional(),
  prior: z.object({
    appliedId: z.string(),
    /** Absent key = it was absent before; restore by deleting. */
    deploymentMode: z.unknown().optional(),
    coworkWebSearchEnabled: z.unknown().optional(),
    hadPreferences: z.boolean(),
  }),
})
export type RoutingState = z.infer<typeof RoutingStateSchema>

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

/** Desktop's config library, read once, with ownership resolved. */
export class Library {
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
      && this.profileCurrent(entry, values)
      && top.deploymentMode === "3p"
    )
  }

  /**
   * The marker's own profile as Maximal wrote it, except that Claude sealed
   * the key: exactly the managed fields, every one but the key equal to what
   * the marker recorded, and the key in Claude's sealed form. Needs the
   * evidence a current build records; an older marker stays conservative,
   * and the key's shape alone never proves anything.
   */
  sealedMaximalProfile(
    entry: MetaEntry,
    values: GatewayProfileValues,
  ): boolean {
    const { state } = this
    if (
      state?.version !== 2
      || !state.ownerProfileId
      || !state.managedFingerprint
      || !state.keyFingerprint
      || entry.name !== OWNED_ENTRY_NAME
      || state.profileId !== entry.id
    ) {
      return false
    }
    const profile = this.profile(entry.id)
    if (!profile || !hasExactFields(profile, values)) return false
    return (
      isClaudeSealedKey(profile.inferenceGatewayApiKey)
      && managedFingerprint(profile, Object.keys(values))
        === state.managedFingerprint
    )
  }

  /** The profile says what we'd write now: byte-for-byte values, or sealed
   *  by Claude with the marker recording exactly these fields and this key.
   *  A rotated key or a new port is not current, so it is rewritten. */
  profileCurrent(entry: MetaEntry, values: GatewayProfileValues): boolean {
    if (profileMatches(this.profile(entry.id), values)) return true
    const { state } = this
    return (
      state?.keyFingerprint !== undefined
      && this.sealedMaximalProfile(entry, values)
      && managedFingerprint({ ...values }, Object.keys(values))
        === state.managedFingerprint
      && keyFingerprintMatches(
        state.keyFingerprint,
        values.inferenceGatewayApiKey,
      )
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
        fingerprintMatches(this.profilePath(entry.id), this.profile(entry.id), {
          fingerprint: this.state.fingerprint,
          keyOrder: Object.keys(values),
        })
        || this.isStaleMaximalArtifact(entry, values)
        || this.sealedMaximalProfile(entry, values)
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
   * Maximal writes, and a key in the exact form Maximal generates or a
   * gateway URL and key that a Maximal write produced (this copy's own or
   * another `maximal` entry's). That is what Claude Desktop leaves when it
   * writes a stale copy of an earlier Maximal profile back over ours, or what
   * a rotated key leaves. A person's edit (their own gateway or key, even on
   * a loopback port; a folder, flag or extra field; a renamed entry) never
   * matches.
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
    if (isGeneratedApiKey(profile.inferenceGatewayApiKey)) return true
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

  const ourEntry = lib.reusableEntry(
    values,
    options.overrideOtherMaximal === true,
  )
  const profileId = ourEntry?.id ?? randomUUID()
  const ensuredWorkspaceFolders = ensureWorkspaceFolders(
    values.allowedWorkspaceFolders,
  )
  const top = readJsonObject(lib.topPath) ?? {}
  const unchanged = { dir: lib.dir, profileId, ensuredWorkspaceFolders }
  if (appliedOwnership === "ours" && lib.isCurrent(ourEntry, values, top)) {
    if (ourEntry) backfillMarkerEvidence(lib, ourEntry, values)
    return { ...unchanged, wrote: false, conflict: null }
  }

  // Re-applying over a Maximal profile (including the marker's own stale
  // entry, repaired in place) keeps the marker's snapshot; see `priorFor`
  // for a switch from elsewhere.
  const prior = priorFor(lib, appliedOwnership !== null, top)

  const profilePath = lib.profilePath(profileId)
  const existingProfile = ourEntry ? lib.profile(profileId) : null
  const profileValues = withMaximalDesktopManagedMcpServers(
    values,
    existingProfile?.managedMcpServers,
  )
  atomicWriteJson(profilePath, profileValues, readJsonText(profilePath))

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
    ...markerEvidence(values),
    prior,
  }
  atomicWriteJson(lib.statePath, state, lib.stateRaw)

  return { ...unchanged, wrote: true, conflict: null }
}

/** The evidence a marker records for `values` (see marker-evidence). */
export function markerEvidence(
  values: GatewayProfileValues,
): Pick<RoutingState, "managedFingerprint" | "keyFingerprint"> {
  const keyFingerprint = keyFingerprintFor(values.inferenceGatewayApiKey)
  return {
    managedFingerprint: managedFingerprint({ ...values }, Object.keys(values)),
    ...(keyFingerprint ? { keyFingerprint } : {}),
  }
}

/**
 * A profile already current in plaintext needs no write, but an older
 * marker over it lacks the evidence (or holds stale key evidence) that keeps
 * it recognized once Claude seals the key. Rewrite only the marker, and only
 * while the profile's bytes are exactly what that marker recorded and the
 * profile is this copy's: an edited profile or another profile's marker is
 * never touched.
 */
function backfillMarkerEvidence(
  lib: Library,
  entry: MetaEntry,
  values: GatewayProfileValues,
): void {
  const { state } = lib
  if (
    !state
    || state.profileId !== entry.id
    || fileFingerprint(lib.profilePath(entry.id)) !== state.fingerprint
  ) {
    return
  }
  const owner = currentProfileId()
  const evidence = markerEvidence(values)
  const keyCurrent =
    state.keyFingerprint !== undefined
    && keyFingerprintMatches(
      state.keyFingerprint,
      values.inferenceGatewayApiKey,
    )
  if (
    state.version === 2
    && state.ownerProfileId === owner
    && state.managedFingerprint === evidence.managedFingerprint
    && (keyCurrent || evidence.keyFingerprint === undefined)
  ) {
    return
  }
  const { keyFingerprint: _stale, ...rest } = state
  atomicWriteJson(
    lib.statePath,
    { ...rest, version: 2, ownerProfileId: owner, ...evidence },
    lib.stateRaw,
  )
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
  const applied = lib.meta.entries.find(
    (entry) => entry.id === lib.meta.appliedId,
  )
  if (!applied || !lib.profileCurrent(applied, values)) return false
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
