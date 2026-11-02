/**
 * Read / merge / write helpers for Claude Code's `~/.claude/settings.json`.
 */

import { createHash } from "node:crypto"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { isDeepStrictEqual } from "node:util"

import type { ClaudeAutoModelsState } from "~/lib/config/settings-types"
import type { ClaudeAutoTier } from "~/lib/models/claude-auto-models"

import {
  echoApiKeyHelperCommand,
  ensureApiKey,
  isOwnedApiKeyHelper,
  resolveApiKey,
} from "~/lib/auth/api-key-helper"
import {
  AtomicWriteConflictError,
  atomicWriteJson,
  readFileNoFollow,
} from "~/lib/platform/atomic-json"
import { parseJsonText } from "~/lib/platform/json-text"
import { proxyBaseUrl } from "~/lib/start/proxy-port"

import {
  AUTO_MODELS_OWNERSHIP_KEY,
  buildClaudeAutoModelsState,
  CAPABLE_MODEL_KEY,
  FAST_MODEL_KEY,
  hasOwnedClaudeAutoModelSettings,
  mergeClaudeAutoModelSettings,
  stripClaudeAutoModelSettings,
} from "./auto-model-settings"
import {
  readSettingsEnv,
  SETTINGS_ENV_KEY,
  SETTINGS_UNSET,
  withRestoredField,
} from "./settings-record"

/** The label Claude Code attributes its key under (Settings → API clients). */
export const HELPER_LABEL = "claude-code"

const API_KEY_HELPER_KEY = "apiKeyHelper"
const BASE_URL_KEY = "ANTHROPIC_BASE_URL"
const AUTO_MODE_SERVER_KEY = "CLAUDE_CODE_AUTO_MODE_SERVER"
const AUTO_MODE_SERVER_DISABLED = "0"

/** maximal-namespaced snapshot of the fields we touch, taken on first
 *  apply so disable can restore EXACTLY what was there before — rather than
 *  blindly deleting (which would drop a value the user happened to set to the
 *  same proxy URL / our own helper string). Claude Code ignores unknown keys,
 *  and we strip this on revert. */
const PRIOR_KEY = "_maximalPrior"
const HELPER_OWNERSHIP_KEY = "_maximalHelper"
const HELPER_STRATEGY = "echo"

interface PriorSnapshot {
  [BASE_URL_KEY]: unknown
  [API_KEY_HELPER_KEY]: unknown
  [AUTO_MODE_SERVER_KEY]?: unknown
  [FAST_MODEL_KEY]?: unknown
  [CAPABLE_MODEL_KEY]?: unknown
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
    [BASE_URL_KEY]: BASE_URL_KEY in s ? s[BASE_URL_KEY] : SETTINGS_UNSET,
    [API_KEY_HELPER_KEY]:
      API_KEY_HELPER_KEY in s ? s[API_KEY_HELPER_KEY] : SETTINGS_UNSET,
    ...(AUTO_MODE_SERVER_KEY in s ?
      { [AUTO_MODE_SERVER_KEY]: s[AUTO_MODE_SERVER_KEY] }
    : {}),
    ...(FAST_MODEL_KEY in s ? { [FAST_MODEL_KEY]: s[FAST_MODEL_KEY] } : {}),
    ...(CAPABLE_MODEL_KEY in s ?
      { [CAPABLE_MODEL_KEY]: s[CAPABLE_MODEL_KEY] }
    : {}),
  }
}

export function getClaudeCodeSettingsPath(): string {
  const configDir =
    process.env.CLAUDE_CONFIG_DIR ?? path.join(os.homedir(), ".claude")
  return path.join(configDir, "settings.json")
}

interface ClaudeCodeSettingsSnapshot {
  raw: string | null
  settings: Record<string, unknown>
}

function parseClaudeCodeSettings(raw: string | null): Record<string, unknown> {
  if (!raw?.trim()) return {}
  try {
    const parsed: unknown = parseJsonText(raw)
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

function readClaudeCodeSettingsSnapshot(
  filePath: string,
): ClaudeCodeSettingsSnapshot {
  const raw = readFileNoFollow(
    filePath,
    () => new Error("refusing to read Claude Code settings: symbolic link"),
  )
  return { raw, settings: parseClaudeCodeSettings(raw) }
}

export function readClaudeCodeSettings(
  filePath: string = getClaudeCodeSettingsPath(),
): Record<string, unknown> {
  try {
    return readClaudeCodeSettingsSnapshot(filePath).settings
  } catch {
    return {}
  }
}

export type BaseUrlOwnership = "ours" | "foreign" | "absent"

/** Any port, since the proxy's port can change between runs. */
const LOOPBACK_BASE_URL = /^http:\/\/127\.0\.0\.1:\d+$/

/**
 * Our URL is the current proxy URL, or — after a port change — a loopback
 * URL sitting next to our own fingerprinted apiKeyHelper. A loopback URL
 * without our helper is some other local proxy the user set up, so it stays
 * foreign.
 */
export function getBaseUrlOwnership(
  settings: Record<string, unknown>,
): BaseUrlOwnership {
  const env = readSettingsEnv(settings)
  if (!(BASE_URL_KEY in env)) return "absent"
  const url = env[BASE_URL_KEY]
  if (url === proxyBaseUrl()) return "ours"
  return (
      typeof url === "string"
        && LOOPBACK_BASE_URL.test(url)
        && getApiKeyHelperOwnership(settings) === "ours"
    ) ?
      "ours"
    : "foreign"
}

export type ApiKeyHelperOwnership = "ours" | "foreign" | "absent"

function helperFingerprint(command: string): string {
  // This is an equality fingerprint for owned config, not a password verifier.
  // codeql[js/insufficient-password-hash]
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

function preparePrior(input: {
  addsAutoModeSetting: boolean
  env: Record<string, unknown>
  settings: Record<string, unknown>
}): unknown {
  const helperOwnership = getApiKeyHelperOwnership(input.settings)
  const baseUrlOwnership = getBaseUrlOwnership(input.settings)
  const priorBaseUrl =
    baseUrlOwnership === "ours" && helperOwnership === "ours" ?
      SETTINGS_UNSET
    : (input.env[BASE_URL_KEY] ?? SETTINGS_UNSET)
  const priorHelper =
    helperOwnership === "ours" ? SETTINGS_UNSET : (
      (input.settings[API_KEY_HELPER_KEY] ?? SETTINGS_UNSET)
    )
  const existingPrior = readPriorSnapshot(input.settings)
  if (PRIOR_KEY in input.settings) {
    if (
      existingPrior
      && input.addsAutoModeSetting
      && !(AUTO_MODE_SERVER_KEY in existingPrior)
    ) {
      return {
        ...(input.settings[PRIOR_KEY] as Record<string, unknown>),
        [AUTO_MODE_SERVER_KEY]: SETTINGS_UNSET,
      }
    }
    return input.settings[PRIOR_KEY]
  }
  return {
    [BASE_URL_KEY]: priorBaseUrl,
    [API_KEY_HELPER_KEY]: priorHelper,
    ...(input.addsAutoModeSetting ?
      { [AUTO_MODE_SERVER_KEY]: SETTINGS_UNSET }
    : {}),
  }
}

interface AutoModelApplyOptions {
  claimAutoModels?: ReadonlySet<ClaudeAutoTier>
}

export function mergeBaseUrl(
  existing: Record<string, unknown>,
  helperCommand: string,
  options: AutoModelApplyOptions = {},
): Record<string, unknown> {
  const existingEnv = readSettingsEnv(existing)
  const addsAutoModeSetting = !(AUTO_MODE_SERVER_KEY in existingEnv)
  let env: Record<string, unknown> = {
    ...existingEnv,
    [BASE_URL_KEY]: proxyBaseUrl(),
    ...(addsAutoModeSetting ?
      { [AUTO_MODE_SERVER_KEY]: AUTO_MODE_SERVER_DISABLED }
    : {}),
  }
  let prior = preparePrior({
    addsAutoModeSetting,
    env: existingEnv,
    settings: existing,
  })
  let marker: ReturnType<typeof mergeClaudeAutoModelSettings>["marker"] = null
  if (typeof prior === "object" && prior !== null && !Array.isArray(prior)) {
    const autoModels = mergeClaudeAutoModelSettings({
      settings: existing,
      env,
      prior: prior as Record<string, unknown>,
      claimTiers: options.claimAutoModels,
    })
    env = autoModels.env
    prior = autoModels.prior
    marker = autoModels.marker
  }

  const { [AUTO_MODELS_OWNERSHIP_KEY]: _oldAutoModels, ...withoutMarker } =
    existing
  return {
    ...withoutMarker,
    [SETTINGS_ENV_KEY]: env,
    [API_KEY_HELPER_KEY]: helperCommand,
    [HELPER_OWNERSHIP_KEY]: {
      label: HELPER_LABEL,
      strategy: HELPER_STRATEGY,
      fingerprint: helperFingerprint(helperCommand),
    },
    [PRIOR_KEY]: prior,
    ...(marker ? { [AUTO_MODELS_OWNERSHIP_KEY]: marker } : {}),
  }
}

function isOwnedAutoModeServerSetting(
  settings: Record<string, unknown>,
): boolean {
  const snapshot = readPriorSnapshot(settings)
  return (
    snapshot?.[AUTO_MODE_SERVER_KEY] === SETTINGS_UNSET
    && readSettingsEnv(settings)[AUTO_MODE_SERVER_KEY]
      === AUTO_MODE_SERVER_DISABLED
  )
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
    [AUTO_MODELS_OWNERSHIP_KEY]: _droppedAutoModels,
    [SETTINGS_ENV_KEY]: _droppedEnv,
    ...rest
  } = existing

  const currentEnv = readSettingsEnv(existing)
  let env = currentEnv
  if (baseUrlOwnership === "ours") {
    const { [BASE_URL_KEY]: _droppedBaseUrl, ...withoutBaseUrl } = currentEnv
    env =
      snapshot ?
        withRestoredField(withoutBaseUrl, BASE_URL_KEY, snapshot[BASE_URL_KEY])
      : withoutBaseUrl
  }
  if (isOwnedAutoModeServerSetting(existing)) {
    const { [AUTO_MODE_SERVER_KEY]: _droppedAutoMode, ...withoutAutoMode } = env
    env = withoutAutoMode
  }
  env = stripClaudeAutoModelSettings({
    settings: existing,
    env,
    prior: snapshot as Record<string, unknown> | null,
  })

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
  return { ...base, [SETTINGS_ENV_KEY]: env }
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

export function getClaudeAutoModelsState(
  filePath: string = getClaudeCodeSettingsPath(),
): ClaudeAutoModelsState {
  const settings = readClaudeCodeSettings(filePath)
  return buildClaudeAutoModelsState(
    settings,
    readPriorSnapshot(settings) as Record<string, unknown> | null,
    getBaseUrlOwnership(settings) === "ours"
      && getApiKeyHelperOwnership(settings) === "ours",
  )
}

export function writeClaudeCodeSettings(
  filePath: string,
  settings: Record<string, unknown>,
  expectedContent?: string | null,
): void {
  atomicWriteJson(filePath, settings, {
    label: "Claude Code settings",
    ...(expectedContent !== undefined ? { expectedContent } : {}),
  })
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
  resolveHelperKey: ResolveHelperKey = () => ensureApiKey(HELPER_LABEL),
  options: AutoModelApplyOptions = {},
): ApplyResult {
  let snapshot = readClaudeCodeSettingsSnapshot(filePath)
  let helperCommand: string | null = null
  let retried = false
  while (true) {
    const baseUrlOwnership = getBaseUrlOwnership(snapshot.settings)
    const helperOwnership = getApiKeyHelperOwnership(snapshot.settings)
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
    if (helperCommand === null) {
      const keyResult = resolveHelperKey()
      if (!keyResult.ok) {
        return {
          path: filePath,
          wrote: false,
          skippedReason: "missing-api-key",
        }
      }
      helperCommand = echoApiKeyHelperCommand(keyResult.key)
    }

    const merged = mergeBaseUrl(snapshot.settings, helperCommand, options)
    if (isDeepStrictEqual(snapshot.settings, merged)) {
      return { path: filePath, wrote: false, skippedReason: "already-ours" }
    }
    try {
      writeClaudeCodeSettings(filePath, merged, snapshot.raw)
      return { path: filePath, wrote: true }
    } catch (error) {
      if (!(error instanceof AtomicWriteConflictError) || retried) throw error
      retried = true
      snapshot = readClaudeCodeSettingsSnapshot(filePath)
    }
  }
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
  if (
    baseUrlOwnership !== "ours"
    && helperOwnership !== "ours"
    && !isOwnedAutoModeServerSetting(existing)
    && !hasOwnedClaudeAutoModelSettings(existing)
  ) {
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
