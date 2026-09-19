/**
 * Read / merge / write helpers for Claude Code's `~/.claude/settings.json`.
 */

import { createHash } from "node:crypto"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import {
  echoApiKeyHelperCommand,
  isOwnedApiKeyHelper,
  resolveApiKey,
} from "~/lib/auth/api-key-helper"
import { atomicWriteJson } from "~/lib/platform/atomic-json"

/** The label Claude Code attributes its key under (Settings → API clients). */
export const HELPER_LABEL = "claude-code"

export const PROXY_BASE_URL = "http://127.0.0.1:4141"

const API_KEY_HELPER_KEY = "apiKeyHelper"
const BASE_URL_KEY = "ANTHROPIC_BASE_URL"
const ENV_KEY = "env"

/** maximal-namespaced snapshot of the two fields we touch, taken on first
 *  apply so disable can restore EXACTLY what was there before — rather than
 *  blindly deleting (which would drop a value the user happened to set to the
 *  same proxy URL / our own helper string). Claude Code ignores unknown keys,
 *  and we strip this on revert. */
const PRIOR_KEY = "_maximalPrior"
const HELPER_OWNERSHIP_KEY = "_maximalHelper"
const HELPER_STRATEGY = "echo"
/** Sentinel recording "this field was absent before we wrote it" → revert
 *  removes it (vs. an empty/real value → revert restores that value). */
const UNSET = "__UNSET__"

interface PriorSnapshot {
  [BASE_URL_KEY]: unknown
  [API_KEY_HELPER_KEY]: unknown
}

function readPriorSnapshot(
  settings: Record<string, unknown>,
): PriorSnapshot | null {
  const snap = settings[PRIOR_KEY]
  if (typeof snap !== "object" || snap === null || Array.isArray(snap)) {
    return null
  }
  const s = snap as Record<string, unknown>
  return {
    [BASE_URL_KEY]: BASE_URL_KEY in s ? s[BASE_URL_KEY] : UNSET,
    [API_KEY_HELPER_KEY]:
      API_KEY_HELPER_KEY in s ? s[API_KEY_HELPER_KEY] : UNSET,
  }
}

export function getClaudeCodeSettingsPath(): string {
  const configDir =
    process.env.CLAUDE_CONFIG_DIR ?? path.join(os.homedir(), ".claude")
  return path.join(configDir, "settings.json")
}

export function readClaudeCodeSettings(
  filePath: string = getClaudeCodeSettingsPath(),
): Record<string, unknown> {
  let raw: string
  try {
    raw = fs.readFileSync(filePath, "utf8")
  } catch {
    return {}
  }
  if (!raw.trim()) return {}
  try {
    const parsed: unknown = JSON.parse(raw)
    if (
      typeof parsed !== "object"
      || parsed === null
      || Array.isArray(parsed)
    ) {
      return {}
    }
    return parsed as Record<string, unknown>
  } catch {
    return {}
  }
}

function readEnv(settings: Record<string, unknown>): Record<string, unknown> {
  const env = settings[ENV_KEY]
  if (typeof env === "object" && env !== null && !Array.isArray(env)) {
    return env as Record<string, unknown>
  }
  return {}
}

export type BaseUrlOwnership = "ours" | "foreign" | "absent"

export function getBaseUrlOwnership(
  settings: Record<string, unknown>,
): BaseUrlOwnership {
  const env = readEnv(settings)
  if (!(BASE_URL_KEY in env)) return "absent"
  return env[BASE_URL_KEY] === PROXY_BASE_URL ? "ours" : "foreign"
}

export type ApiKeyHelperOwnership = "ours" | "foreign" | "absent"

function helperFingerprint(command: string): string {
  return createHash("sha256").update(command).digest("hex")
}

function markerOwnsHelper(marker: unknown, command: unknown): boolean {
  if (
    typeof marker !== "object"
    || marker === null
    || Array.isArray(marker)
    || typeof command !== "string"
  ) {
    return false
  }
  const record = marker as Record<string, unknown>
  return (
    record.label === HELPER_LABEL
    && record.strategy === HELPER_STRATEGY
    && record.fingerprint === helperFingerprint(command)
  )
}

export function getApiKeyHelperOwnership(
  settings: Record<string, unknown>,
): ApiKeyHelperOwnership {
  if (!(API_KEY_HELPER_KEY in settings)) return "absent"
  if (HELPER_OWNERSHIP_KEY in settings) {
    return (
        markerOwnsHelper(
          settings[HELPER_OWNERSHIP_KEY],
          settings[API_KEY_HELPER_KEY],
        )
      ) ?
        "ours"
      : "foreign"
  }
  // Before the marker existed, maximal-owned helpers were identifiable by their
  // binary invocation signature. Keep recognizing those so they can migrate to
  // the echo strategy; unmarked echo commands remain foreign.
  return isOwnedApiKeyHelper(settings[API_KEY_HELPER_KEY], HELPER_LABEL) ?
      "ours"
    : "foreign"
}

export function mergeBaseUrl(
  existing: Record<string, unknown>,
  helperCommand: string,
): Record<string, unknown> {
  const env = { ...readEnv(existing), [BASE_URL_KEY]: PROXY_BASE_URL }
  // Capture the prior values of the two fields we touch — but ONLY on the first
  // apply (when no snapshot exists yet). Re-apply / self-heal must not overwrite
  // the snapshot, or it would record OUR values as the "prior" state and disable
  // would restore the proxy URL instead of removing it. UNSET marks a field that
  // was absent so revert deletes it rather than writing the sentinel back.
  const priorEnvBaseUrl = readEnv(existing)
  const priorHelperOwnership = getApiKeyHelperOwnership(existing)
  const priorBaseUrlOwnership = getBaseUrlOwnership(existing)
  let priorBaseUrl =
    BASE_URL_KEY in priorEnvBaseUrl ? priorEnvBaseUrl[BASE_URL_KEY] : UNSET
  // A matching proxy URL alone could be user-authored, but paired with a
  // recognized maximal helper it is the pre-marker routing configuration.
  if (priorBaseUrlOwnership === "ours" && priorHelperOwnership === "ours") {
    priorBaseUrl = UNSET
  }
  // Legacy maximal helpers are owned migration artifacts, not user state to
  // resurrect when routing is later disabled.
  let priorHelper =
    API_KEY_HELPER_KEY in existing ? existing[API_KEY_HELPER_KEY] : UNSET
  if (priorHelperOwnership === "ours") priorHelper = UNSET
  const prior =
    PRIOR_KEY in existing ?
      existing[PRIOR_KEY]
    : {
        [BASE_URL_KEY]: priorBaseUrl,
        [API_KEY_HELPER_KEY]: priorHelper,
      }
  return {
    ...existing,
    [ENV_KEY]: env,
    [API_KEY_HELPER_KEY]: helperCommand,
    [HELPER_OWNERSHIP_KEY]: {
      label: HELPER_LABEL,
      strategy: HELPER_STRATEGY,
      fingerprint: helperFingerprint(helperCommand),
    },
    [PRIOR_KEY]: prior,
  }
}

/** Apply a snapshotted prior value to a record under `key`: restore the value,
 *  or omit the key when the prior was UNSET (absent). Returns a new record so we
 *  avoid a dynamically-computed `delete`. */
function withRestoredField(
  target: Record<string, unknown>,
  key: string,
  prior: unknown,
): Record<string, unknown> {
  if (prior === UNSET) {
    const { [key]: _dropped, ...without } = target
    return without
  }
  return { ...target, [key]: prior }
}

export function stripBaseUrl(
  existing: Record<string, unknown>,
): Record<string, unknown> {
  const snapshot = readPriorSnapshot(existing)
  const baseUrlOwnership = getBaseUrlOwnership(existing)
  const helperOwnership = getApiKeyHelperOwnership(existing)
  const {
    [PRIOR_KEY]: _droppedPrior,
    [HELPER_OWNERSHIP_KEY]: _droppedMarker,
    [ENV_KEY]: _droppedEnv,
    ...rest
  } = existing

  const currentEnv = readEnv(existing)
  let env = currentEnv
  if (baseUrlOwnership === "ours") {
    const { [BASE_URL_KEY]: _droppedBaseUrl, ...withoutBaseUrl } = currentEnv
    env =
      snapshot ?
        withRestoredField(withoutBaseUrl, BASE_URL_KEY, snapshot[BASE_URL_KEY])
      : withoutBaseUrl
  }

  let base = rest
  if (helperOwnership === "ours") {
    const { [API_KEY_HELPER_KEY]: _droppedHelper, ...withoutHelper } = rest
    base =
      snapshot ?
        withRestoredField(
          withoutHelper,
          API_KEY_HELPER_KEY,
          snapshot[API_KEY_HELPER_KEY],
        )
      : withoutHelper
  }

  if (Object.keys(env).length === 0) return base
  return { ...base, [ENV_KEY]: env }
}

export function isProxyBaseUrlConfigured(
  filePath: string = getClaudeCodeSettingsPath(),
): boolean {
  const settings = readClaudeCodeSettings(filePath)
  return (
    getBaseUrlOwnership(settings) === "ours"
    && getApiKeyHelperOwnership(settings) === "ours"
  )
}

export function writeClaudeCodeSettings(
  filePath: string,
  settings: Record<string, unknown>,
): void {
  atomicWriteJson(filePath, settings, { label: "Claude Code settings" })
}

export type SkipReason =
  | "already-ours"
  | "foreign-base-url"
  | "foreign-api-key-helper"
  | "missing-api-key"

export interface ApplyResult {
  path: string
  wrote: boolean
  skippedReason?: SkipReason
}

type ResolveHelperKey = () => ReturnType<typeof resolveApiKey>

export function applyProxyBaseUrl(
  filePath: string = getClaudeCodeSettingsPath(),
  resolveHelperKey: ResolveHelperKey = () => resolveApiKey(HELPER_LABEL),
): ApplyResult {
  const existing = readClaudeCodeSettings(filePath)
  const baseUrlOwnership = getBaseUrlOwnership(existing)
  const helperOwnership = getApiKeyHelperOwnership(existing)
  if (baseUrlOwnership === "foreign") {
    return { path: filePath, wrote: false, skippedReason: "foreign-base-url" }
  }
  if (helperOwnership === "foreign") {
    return {
      path: filePath,
      wrote: false,
      skippedReason: "foreign-api-key-helper",
    }
  }

  const keyResult = resolveHelperKey()
  if (!keyResult.ok) {
    return { path: filePath, wrote: false, skippedReason: "missing-api-key" }
  }
  const helperCommand = echoApiKeyHelperCommand(keyResult.key)
  if (
    baseUrlOwnership === "ours"
    && helperOwnership === "ours"
    && existing[API_KEY_HELPER_KEY] === helperCommand
  ) {
    return { path: filePath, wrote: false, skippedReason: "already-ours" }
  }

  writeClaudeCodeSettings(filePath, mergeBaseUrl(existing, helperCommand))
  return { path: filePath, wrote: true }
}

export interface RevertResult {
  path: string
  wrote: boolean
  remainingKeys: Array<string>
}

export function revertProxyBaseUrl(
  filePath: string = getClaudeCodeSettingsPath(),
): RevertResult {
  const existing = readClaudeCodeSettings(filePath)
  const baseUrlOwnership = getBaseUrlOwnership(existing)
  const helperOwnership = getApiKeyHelperOwnership(existing)
  if (baseUrlOwnership !== "ours" && helperOwnership !== "ours") {
    return {
      path: filePath,
      wrote: false,
      remainingKeys: Object.keys(existing),
    }
  }
  const stripped = stripBaseUrl(existing)
  if (Object.keys(stripped).length === 0) {
    try {
      fs.rmSync(filePath, { force: true })
    } catch {
      /* best effort */
    }
    return { path: filePath, wrote: true, remainingKeys: [] }
  }
  writeClaudeCodeSettings(filePath, stripped)
  return {
    path: filePath,
    wrote: true,
    remainingKeys: Object.keys(stripped),
  }
}
