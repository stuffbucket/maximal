/**
 * Wire Claude Desktop's **third-party (Cowork 3P)** mode at the local
 * gateway.
 *
 * Why this exists separately from `claude-desktop-config.ts`: current
 * Claude Desktop builds run third-party mode out of a **distinct
 * userData directory** — the Electron base path with a `-3p` suffix
 * (`~/Library/Application Support/Claude-3p`, verified in the app's
 * `app.asar`: `A4A="-3p"`). The classic `…/Claude/claude_desktop_config.json`
 * our older helper wrote is the standard-mode / MCP-server file and is
 * **ignored** by the 3P build. Inside the 3P dir the inference config is
 * split:
 *
 *   - `configLibrary/<id>.json`     — the applied inference profile
 *                                     (gateway wiring), pointed to by
 *   - `configLibrary/_meta.json`    — `{ appliedId, entries[] }`
 *   - `claude_desktop_config.json`  — top-level `deploymentMode` + prefs
 *
 * Empirically validated 2026-06-22: writing these three makes the app
 * boot straight into 3P (`[custom-3p] 3P mode active`), discover models
 * via the gateway `/v1/models`, and route inference at the gateway —
 * with **no Anthropic sign-in / no account** (the app self-provisions a
 * local "Cowork 3P" identity).
 *
 * Two delivery tiers:
 *   1. {@link generateManagedProfile} → a `.mobileconfig` for the
 *      managed-preferences domain `com.anthropic.claudefordesktop`. This
 *      is the **robust** path: read regardless of the userData dir,
 *      highest precedence (survives corporate MDM), forces 3P with no
 *      sign-in, and makes the in-app config read-only. Requires MDM or a
 *      one-time `profiles`/System-Settings install (admin).
 *   2. {@link applyConfigLibraryProfile} → the **no-admin fallback** that
 *      writes the configLibrary files directly. File-tier (shadowed by a
 *      managed profile) and tied to the `-3p` suffix, so it's the
 *      fallback, not the default.
 */

import { randomUUID } from "node:crypto"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

/** The Cowork-3P build appends this to the Electron userData base path. */
const USERDATA_3P_SUFFIX = "-3p"

/** Managed-preferences domain Claude Desktop reads on macOS (and the
 *  Windows policy key). Confirmed in `app.asar`. */
export const CLAUDE_3P_PREF_DOMAIN = "com.anthropic.claudefordesktop"

export interface GatewayProfileValues {
  inferenceProvider: "gateway"
  inferenceGatewayBaseUrl: string
  inferenceGatewayApiKey: string
  inferenceGatewayAuthScheme: "bearer" | "x-api-key"
  disableDeploymentModeChooser: boolean
  coworkEgressAllowedHosts: Array<string>
  allowedWorkspaceFolders: Array<string>
  // Telemetry: all three `category:"telemetry"` knobs are turned off so no
  // content/usage telemetry is sent to Anthropic (it ships to Datadog).
  disableEssentialTelemetry: boolean
  disableNonessentialTelemetry: boolean
  disableNonessentialServices: boolean
  // Updates are a *separate* concern from telemetry — left enabled so the
  // app can still check Anthropic for updates.
  disableAutoUpdates: boolean
}

/** The inference profile the app reads — exactly the keys the in-app
 *  "Configure third-party inference" window writes into `configLibrary`,
 *  and the same keys a managed profile forces. `inferenceModels` is
 *  intentionally omitted: the gateway's own `/v1/models` listing
 *  populates the picker (validated — 7 models discovered without it). */
export function gatewayProfile(
  home: string = os.homedir(),
  baseUrl = "http://127.0.0.1:4141",
): GatewayProfileValues {
  return {
    inferenceProvider: "gateway",
    inferenceGatewayBaseUrl: baseUrl,
    inferenceGatewayApiKey: "anything",
    inferenceGatewayAuthScheme: "bearer",
    // Presence of `inferenceProvider` activates 3P mode; this hides the
    // Claude.ai sign-in option so a no-account user is never prompted.
    disableDeploymentModeChooser: true,
    coworkEgressAllowedHosts: ["*"],
    allowedWorkspaceFolders: [path.join(home, "Claude")],
    // No content/usage telemetry to Anthropic (all three telemetry knobs).
    disableEssentialTelemetry: true,
    disableNonessentialTelemetry: true,
    disableNonessentialServices: true,
    // …but keep update checks with Anthropic working (separate from telemetry).
    disableAutoUpdates: false,
  }
}

/**
 * Resolve the 3P userData directory. Mirrors Electron's `userData` base
 * (`<userData>/Claude`) with the build's `-3p` suffix, so the config lands
 * where the Cowork-3P build actually reads it:
 *
 *   - macOS:   `~/Library/Application Support/Claude-3p`
 *   - Windows: `%LOCALAPPDATA%\Claude-3p`  (Anthropic's docs locate the 3P
 *              `configLibrary` under Local AppData, NOT Roaming. Note this
 *              diverges from the consumer `claude_desktop_config.json`, which
 *              IS under Roaming `%APPDATA%\Claude` — on Windows the two halves
 *              live on different drives, unlike macOS where both share
 *              `~/Library/Application Support`.)
 *
 * The `configLibrary/` subdir (added by callers) is where the applied
 * inference profile lives; the historically-wrong target was the standard-
 * mode `…\Claude\claude_desktop_config.json` (no `-3p`), which the 3P build
 * ignores. `platform` is injectable so the Windows branch is unit-testable
 * on a POSIX host.
 *
 * NOTE: an MSIX/Store install virtualizes this under
 * `%LOCALAPPDATA%\Packages\Claude_pzs8sxrjxfjjc\LocalState\Claude-3p`; this
 * returns the plain `.exe`-install path (the common case). See
 * docs/spec / the Claude-Desktop-3P memory for the MSIX wrinkle.
 */
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

/** True when `existing` carries every gateway-profile key with our values
 *  (per-key compare so a reordered on-disk profile still matches). */
function profileMatches(
  existing: Record<string, unknown> | null,
  values: GatewayProfileValues,
): boolean {
  if (!existing) return false
  return (Object.keys(values) as Array<keyof GatewayProfileValues>).every(
    (k) => JSON.stringify(existing[k]) === JSON.stringify(values[k]),
  )
}

/** Read + parse a JSON object file, or null on absent/unreadable/non-object.
 *  Callers assert the concrete shape. */
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

/** Atomic JSON write: temp-file + fsync + rename, `O_EXCL` to refuse a
 *  planted-symlink tmp, mode 0600 (the profile can carry a gateway key).
 *  Mirrors `claude-desktop-config.ts`'s writer. */
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
  /** Workspace folders ensured on disk. */
  ensuredWorkspaceFolders: Array<string>
}

/**
 * No-admin fallback: write the applied inference profile into the 3P
 * `configLibrary`, register it in `_meta.json`, and set top-level
 * `deploymentMode`. Idempotent — reuses the existing `appliedId` (so we
 * update in place rather than churn UUIDs), and skips the write when the
 * applied profile already matches. Other user preferences in the
 * top-level file and other library entries are preserved.
 */
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

  // Top-level: deploymentMode + keep web-search on; preserve all else.
  top.deploymentMode = "3p"
  const prefs =
    typeof top.preferences === "object" && top.preferences !== null ?
      (top.preferences as Record<string, unknown>)
    : {}
  top.preferences = { ...prefs, coworkWebSearchEnabled: true }
  atomicWriteJson(topPath, top)

  return { dir, profileId, wrote: true, ensuredWorkspaceFolders }
}

/** Is our gateway profile the one currently applied? Drives the Settings
 *  toggle's `enabled` state — true only when the `_meta.appliedId` profile
 *  matches {@link gatewayProfile} and top-level `deploymentMode` is `3p`. */
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
  /** Whether anything was actually removed. */
  reverted: boolean
}

/** Remove the applied gateway profile and clear `deploymentMode`,
 *  leaving other library entries and user preferences intact. */
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
      /* best effort — Claude Desktop surfaces an attach error if missing */
    }
  }
  return created
}

// ---------------------------------------------------------------------------
// Managed `.mobileconfig` (robust path) — MCX Forced preferences for the
// `com.anthropic.claudefordesktop` domain.
// ---------------------------------------------------------------------------

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
  /** Profile-level UUID. Pass a stable value to keep re-installs idempotent. */
  profileUUID?: string
  /** Inner payload UUID. */
  payloadUUID?: string
  /** "User" (per-user) or "System". */
  scope?: "User" | "System"
}

/**
 * Build a `.mobileconfig` that forces the gateway profile via the
 * macOS managed-preferences domain. Install via MDM (Intune/Jamf) or a
 * one-time `sudo profiles install -path <file>` / System Settings →
 * Profiles. Once present the app boots into 3P with no sign-in and the
 * in-app config window becomes read-only.
 */
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
