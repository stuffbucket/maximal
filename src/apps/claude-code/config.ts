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

import { currentProfileId } from "~/apps/profile-identity"
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
  AUTO_MODELS_JOURNAL_KEY,
  AUTO_MODELS_OWNERSHIP_KEY,
  buildClaudeAutoModelsState,
  CAPABLE_MODEL_KEY,
  CLASSIFIER_MODEL_KEY,
  FAST_MODEL_KEY,
  hasClaudeAutoModelMarker,
  hasOwnedClaudeAutoModelSettings,
  isUnsupportedClaudeAutoModelJournal,
  mergeClaudeAutoModelSettings,
  resumeClaudeAutoModelSettings,
  stripClaudeAutoModelSettings,
  suspendClaudeAutoModelSettings,
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
const PROFILE_OWNERSHIP_KEY = "_maximalProfile"
const PROFILE_OWNERSHIP_VERSION = 1
const HELPER_STRATEGY = "echo"

interface PriorSnapshot {
  [BASE_URL_KEY]: unknown
  [API_KEY_HELPER_KEY]: unknown
  [AUTO_MODE_SERVER_KEY]?: unknown
  [FAST_MODEL_KEY]?: unknown
  [CAPABLE_MODEL_KEY]?: unknown
  [CLASSIFIER_MODEL_KEY]?: unknown
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
    ...(CLASSIFIER_MODEL_KEY in s ?
      { [CLASSIFIER_MODEL_KEY]: s[CLASSIFIER_MODEL_KEY] }
    : {}),
  }
}

/** A snapshot written by `preparePrior` always names both routing fields. An
 *  object missing either is malformed: it cannot be transferred to another
 *  profile, and applying over it rebuilds the missing fields. */
function hasCompletePrior(settings: Record<string, unknown>): boolean {
  const snap = settings[PRIOR_KEY]
  return (
    typeof snap === "object"
    && snap !== null
    && !Array.isArray(snap)
    && BASE_URL_KEY in snap
    && API_KEY_HELPER_KEY in snap
  )
}

export function getClaudeCodeSettingsPath(): string {
  const configDir =
    process.env.CLAUDE_CONFIG_DIR ?? path.join(os.homedir(), ".claude")
  return path.join(configDir, "settings.json")
}

interface ClaudeCodeSettingsSnapshot {
  raw: string | null
  settings: Record<string, unknown>
  malformed: boolean
}

function parseClaudeCodeSettings(
  raw: string | null,
): Pick<ClaudeCodeSettingsSnapshot, "settings" | "malformed"> {
  if (raw === null) return { settings: {}, malformed: false }
  if (!raw.trim()) return { settings: {}, malformed: true }
  try {
    const parsed: unknown = parseJsonText(raw)
    if (
      typeof parsed !== "object"
      || parsed === null
      || Array.isArray(parsed)
    ) {
      return { settings: {}, malformed: true }
    }
    return {
      settings: parsed as Record<string, unknown>,
      malformed: false,
    }
  } catch {
    return { settings: {}, malformed: true }
  }
}

function readClaudeCodeSettingsSnapshot(
  filePath: string,
): ClaudeCodeSettingsSnapshot {
  const raw = readFileNoFollow(
    filePath,
    () => new Error("refusing to read Claude Code settings: symbolic link"),
  )
  return { raw, ...parseClaudeCodeSettings(raw) }
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

export type BaseUrlOwnership = "ours" | "other-maximal" | "foreign" | "absent"

/** Any port, since the proxy's port can change between runs. */
const LOOPBACK_BASE_URL = /^http:\/\/127\.0\.0\.1:\d+$/

export type ApiKeyHelperOwnership =
  | "ours"
  | "other-maximal"
  | "foreign"
  | "absent"

type ProfileMarkerOwnership = "ours" | "other-maximal" | "legacy" | "invalid"

function profileMarkerOwnership(
  settings: Record<string, unknown>,
): ProfileMarkerOwnership {
  if (!(PROFILE_OWNERSHIP_KEY in settings)) return "legacy"
  const marker = settings[PROFILE_OWNERSHIP_KEY]
  if (typeof marker !== "object" || marker === null || Array.isArray(marker)) {
    return "invalid"
  }
  const record = marker as Record<string, unknown>
  if (
    record.version !== PROFILE_OWNERSHIP_VERSION
    || typeof record.profileId !== "string"
  ) {
    return "invalid"
  }
  return record.profileId === currentProfileId() ? "ours" : "other-maximal"
}

function helperFingerprint(command: string): string {
  // This is an equality fingerprint for owned config, not a password verifier.
  // codeql[js/insufficient-password-hash]
  return createHash("sha256").update(command).digest("hex")
}

function validHelperMarker(marker: unknown, command: unknown): boolean {
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
    && (record.profileId === undefined || typeof record.profileId === "string")
  )
}

function helperMarkerProfileId(marker: unknown): string | null {
  if (typeof marker !== "object" || marker === null || Array.isArray(marker)) {
    return null
  }
  const profileId = (marker as Record<string, unknown>).profileId
  return typeof profileId === "string" ? profileId : null
}

export function getApiKeyHelperOwnership(
  settings: Record<string, unknown>,
): ApiKeyHelperOwnership {
  if (!(API_KEY_HELPER_KEY in settings)) return "absent"
  if (HELPER_OWNERSHIP_KEY in settings) {
    const marker = settings[HELPER_OWNERSHIP_KEY]
    if (!validHelperMarker(marker, settings[API_KEY_HELPER_KEY]))
      return "foreign"
    const markerProfileId = helperMarkerProfileId(marker)
    if (markerProfileId) {
      return markerProfileId === currentProfileId() ? "ours" : "other-maximal"
    }
    const profileOwnership = profileMarkerOwnership(settings)
    if (profileOwnership === "invalid") return "foreign"
    return profileOwnership === "other-maximal" ? "other-maximal" : "ours"
  }
  // Before the marker existed, maximal-owned helpers were identifiable by their
  // binary invocation signature. Keep recognizing those so they can migrate to
  // the echo strategy; unmarked echo commands remain foreign.
  return isOwnedApiKeyHelper(settings[API_KEY_HELPER_KEY], HELPER_LABEL) ?
      "ours"
    : "foreign"
}

/** Classify the URL only when it is paired with valid Maximal helper metadata.
 * An arbitrary loopback gateway is never inferred to be Maximal-owned. */
export function getBaseUrlOwnership(
  settings: Record<string, unknown>,
): BaseUrlOwnership {
  const env = readSettingsEnv(settings)
  if (!(BASE_URL_KEY in env)) return "absent"
  const url = env[BASE_URL_KEY]
  if (typeof url !== "string" || !LOOPBACK_BASE_URL.test(url)) return "foreign"
  const profile = profileMarkerOwnership(settings)
  const helper = getApiKeyHelperOwnership(settings)
  if (url === proxyBaseUrl()) {
    if (profile === "other-maximal") return "other-maximal"
    if (profile === "ours" || helper === "ours") return "ours"
    return "foreign"
  }
  if (profile === "ours" && helper === "ours") return "ours"
  if (helper === "ours" || helper === "other-maximal") {
    return "other-maximal"
  }
  return "foreign"
}

export type ClaudeCodeRoutingConflict =
  | "foreign-base-url"
  | "foreign-api-key-helper"
  | "other-maximal-config"
  | "cleanup-required"
  | null

export interface ClaudeCodeRoutingInspection {
  enabled: boolean
  conflict: ClaudeCodeRoutingConflict
}

function structuralRoutingConflict(
  settings: Record<string, unknown>,
  env: Record<string, unknown>,
  helper: ApiKeyHelperOwnership,
): ClaudeCodeRoutingConflict {
  const baseUrl = env[BASE_URL_KEY]
  if (
    BASE_URL_KEY in env
    && (typeof baseUrl !== "string" || !LOOPBACK_BASE_URL.test(baseUrl))
  ) {
    return "foreign-base-url"
  }
  if (API_KEY_HELPER_KEY in settings && helper === "foreign") {
    return "foreign-api-key-helper"
  }
  return BASE_URL_KEY in env && !(API_KEY_HELPER_KEY in settings) ?
      "foreign-base-url"
    : null
}

/** Resolve complete routing ownership. Legacy unprofiled Maximal artifacts are
 * adopted only when their endpoint exactly matches this profile's endpoint. */
export function inspectClaudeCodeRouting(
  settings: Record<string, unknown>,
): ClaudeCodeRoutingInspection {
  const env = readSettingsEnv(settings)
  const baseUrl = env[BASE_URL_KEY]
  const helper = getApiKeyHelperOwnership(settings)
  const profile = profileMarkerOwnership(settings)
  const structuralConflict = structuralRoutingConflict(settings, env, helper)

  if (structuralConflict) {
    return { enabled: false, conflict: structuralConflict }
  }
  if (
    profile === "invalid"
    || (PRIOR_KEY in settings && !hasCompletePrior(settings))
  ) {
    return { enabled: false, conflict: "cleanup-required" }
  }
  // Another profile's markers fail closed even when part of its routing was
  // removed (for example the URL was deleted): leftover owned markers are never
  // adopted silently, only through the explicit override.
  if (profile === "other-maximal" || helper === "other-maximal") {
    const marker = settings[HELPER_OWNERSHIP_KEY]
    const sameOwner =
      profile === "other-maximal"
      && helperMarkerProfileId(marker)
        === (settings[PROFILE_OWNERSHIP_KEY] as Record<string, unknown>)
          .profileId
    return {
      enabled: false,
      conflict:
        sameOwner && hasCompletePrior(settings) ?
          "other-maximal-config"
        : "cleanup-required",
    }
  }
  if (!(BASE_URL_KEY in env) || !(API_KEY_HELPER_KEY in settings)) {
    return { enabled: false, conflict: null }
  }

  if (profile === "legacy") {
    return baseUrl === proxyBaseUrl() ?
        { enabled: true, conflict: null }
      : { enabled: false, conflict: "other-maximal-config" }
  }
  return { enabled: true, conflict: null }
}

/** Inspect the on-disk file without treating unreadable or malformed content as
 * an empty configuration. Those cases require manual cleanup and stay untouched. */
export function inspectClaudeCodeRoutingFile(
  filePath: string = getClaudeCodeSettingsPath(),
): ClaudeCodeRoutingInspection {
  try {
    const snapshot = readClaudeCodeSettingsSnapshot(filePath)
    return snapshot.malformed ?
        { enabled: false, conflict: "cleanup-required" }
      : inspectClaudeCodeRouting(snapshot.settings)
  } catch {
    return { enabled: false, conflict: "cleanup-required" }
  }
}

function preparePrior(input: {
  addsAutoModeSetting: boolean
  env: Record<string, unknown>
  settings: Record<string, unknown>
}): unknown {
  const helperOwnership = getApiKeyHelperOwnership(input.settings)
  const baseUrlOwnership = getBaseUrlOwnership(input.settings)
  const maximalHelper =
    helperOwnership === "ours" || helperOwnership === "other-maximal"
  const maximalBaseUrl =
    baseUrlOwnership === "ours" || baseUrlOwnership === "other-maximal"
  const priorBaseUrl =
    maximalBaseUrl && maximalHelper ? SETTINGS_UNSET : (
      (input.env[BASE_URL_KEY] ?? SETTINGS_UNSET)
    )
  const priorHelper =
    maximalHelper ? SETTINGS_UNSET : (
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
  overrideOtherMaximal?: boolean
}

function isSettingsRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function outputAutoModelMetadata(input: {
  effectiveExisting: Record<string, unknown>
  existingJournal: unknown
  marker: ReturnType<typeof mergeClaudeAutoModelSettings>["marker"]
  unsupportedJournal: boolean
}): Record<string, unknown> {
  if (input.unsupportedJournal) {
    return {
      ...(AUTO_MODELS_OWNERSHIP_KEY in input.effectiveExisting ?
        {
          [AUTO_MODELS_OWNERSHIP_KEY]:
            input.effectiveExisting[AUTO_MODELS_OWNERSHIP_KEY],
        }
      : {}),
      [AUTO_MODELS_JOURNAL_KEY]: input.existingJournal,
    }
  }
  return input.marker ? { [AUTO_MODELS_OWNERSHIP_KEY]: input.marker } : {}
}

export function mergeBaseUrl(
  existing: Record<string, unknown>,
  helperCommand: string,
  options: AutoModelApplyOptions = {},
): Record<string, unknown> {
  const liveAutoModels = hasClaudeAutoModelMarker(existing)
  const unsupportedJournal = isUnsupportedClaudeAutoModelJournal(
    existing[AUTO_MODELS_JOURNAL_KEY],
  )
  const resumed =
    liveAutoModels || unsupportedJournal ? null : (
      resumeClaudeAutoModelSettings({
        env: readSettingsEnv(existing),
        journal: existing[AUTO_MODELS_JOURNAL_KEY],
      })
    )
  const effectiveExisting =
    resumed ?
      {
        ...existing,
        [SETTINGS_ENV_KEY]: resumed.env,
        [AUTO_MODELS_OWNERSHIP_KEY]: resumed.marker,
      }
    : existing
  const existingEnv = readSettingsEnv(effectiveExisting)
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
    settings: effectiveExisting,
  })
  if (resumed && isSettingsRecord(prior)) {
    prior = { ...prior, ...resumed.prior }
  }
  let marker: ReturnType<typeof mergeClaudeAutoModelSettings>["marker"] = null
  if (!unsupportedJournal && isSettingsRecord(prior)) {
    const autoModels = mergeClaudeAutoModelSettings({
      settings: effectiveExisting,
      env,
      prior,
      claimTiers: options.claimAutoModels,
    })
    env = autoModels.env
    prior = autoModels.prior
    marker = autoModels.marker
  }

  const {
    [AUTO_MODELS_JOURNAL_KEY]: _oldJournal,
    [AUTO_MODELS_OWNERSHIP_KEY]: _oldAutoModels,
    [PROFILE_OWNERSHIP_KEY]: _oldProfile,
    ...withoutMarker
  } = effectiveExisting
  return {
    ...withoutMarker,
    [SETTINGS_ENV_KEY]: env,
    [API_KEY_HELPER_KEY]: helperCommand,
    [HELPER_OWNERSHIP_KEY]: {
      label: HELPER_LABEL,
      strategy: HELPER_STRATEGY,
      fingerprint: helperFingerprint(helperCommand),
      profileId: currentProfileId(),
    },
    [PROFILE_OWNERSHIP_KEY]: {
      version: PROFILE_OWNERSHIP_VERSION,
      profileId: currentProfileId(),
    },
    [PRIOR_KEY]: prior,
    ...outputAutoModelMetadata({
      effectiveExisting,
      existingJournal: existing[AUTO_MODELS_JOURNAL_KEY],
      marker,
      unsupportedJournal,
    }),
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
    [PROFILE_OWNERSHIP_KEY]: _droppedProfile,
    [AUTO_MODELS_OWNERSHIP_KEY]: _droppedAutoModels,
    [AUTO_MODELS_JOURNAL_KEY]: _droppedJournal,
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

function stripBaseUrlForShutdown(
  existing: Record<string, unknown>,
): Record<string, unknown> {
  const existingJournal = existing[AUTO_MODELS_JOURNAL_KEY]
  if (isUnsupportedClaudeAutoModelJournal(existingJournal)) {
    return {
      ...stripBaseUrl(existing),
      [AUTO_MODELS_JOURNAL_KEY]: existingJournal,
    }
  }
  const snapshot = readPriorSnapshot(existing)
  const journal = suspendClaudeAutoModelSettings({
    settings: existing,
    prior: snapshot as Record<string, unknown> | null,
  })
  const stripped = stripBaseUrl(existing)
  return journal ?
      { ...stripped, [AUTO_MODELS_JOURNAL_KEY]: journal }
    : stripped
}

export function isProxyBaseUrlConfigured(
  filePath: string = getClaudeCodeSettingsPath(),
): boolean {
  return inspectClaudeCodeRoutingFile(filePath).enabled
}

export function getClaudeAutoModelsState(
  filePath: string = getClaudeCodeSettingsPath(),
): ClaudeAutoModelsState {
  const settings = readClaudeCodeSettings(filePath)
  return buildClaudeAutoModelsState(
    settings,
    readPriorSnapshot(settings) as Record<string, unknown> | null,
    inspectClaudeCodeRouting(settings).enabled,
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
  | "other-maximal-config"
  | "cleanup-required"
  | "missing-api-key"

export interface ApplyResult {
  path: string
  wrote: boolean
  skippedReason?: SkipReason
}

type ResolveHelperKey = () => ReturnType<typeof resolveApiKey>

function applySkipReason(
  snapshot: ClaudeCodeSettingsSnapshot,
  overrideOtherMaximal: boolean,
): SkipReason | null {
  if (snapshot.malformed) return "cleanup-required"
  const { conflict } = inspectClaudeCodeRouting(snapshot.settings)
  if (conflict === "other-maximal-config" && overrideOtherMaximal) return null
  return conflict
}

export function applyProxyBaseUrl(
  filePath: string = getClaudeCodeSettingsPath(),
  resolveHelperKey: ResolveHelperKey = () => ensureApiKey(HELPER_LABEL),
  options: AutoModelApplyOptions = {},
): ApplyResult {
  let snapshot = readClaudeCodeSettingsSnapshot(filePath)
  let helperCommand: string | null = null
  let retried = false
  while (true) {
    const skippedReason = applySkipReason(
      snapshot,
      options.overrideOtherMaximal === true,
    )
    if (skippedReason) {
      return { path: filePath, wrote: false, skippedReason }
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

function revertProxyBaseUrlWithMode(
  filePath: string,
  preserveAutoModels: boolean,
): RevertResult {
  const snapshot = readClaudeCodeSettingsSnapshot(filePath)
  const existing = snapshot.settings
  const inspection = inspectClaudeCodeRouting(existing)
  if (
    inspection.conflict === "other-maximal-config"
    || inspection.conflict === "cleanup-required"
  ) {
    return {
      path: filePath,
      wrote: false,
      remainingKeys: Object.keys(existing),
    }
  }
  const baseUrlOwnership = getBaseUrlOwnership(existing)
  const helperOwnership = getApiKeyHelperOwnership(existing)
  const hasSuspendedAutoModels = AUTO_MODELS_JOURNAL_KEY in existing
  if (
    baseUrlOwnership !== "ours"
    && helperOwnership !== "ours"
    && !isOwnedAutoModeServerSetting(existing)
    && !hasOwnedClaudeAutoModelSettings(existing)
    && (preserveAutoModels || !hasSuspendedAutoModels)
  ) {
    return {
      path: filePath,
      wrote: false,
      remainingKeys: Object.keys(existing),
    }
  }
  const stripped =
    preserveAutoModels ?
      stripBaseUrlForShutdown(existing)
    : stripBaseUrl(existing)
  if (Object.keys(stripped).length === 0) {
    const current = readFileNoFollow(
      filePath,
      () => new Error("refusing to remove Claude Code settings: symbolic link"),
    )
    if (current !== snapshot.raw) {
      throw new AtomicWriteConflictError(
        "refusing to remove Claude Code settings: file changed before it could be removed",
      )
    }
    fs.rmSync(filePath, { force: true })
    return { path: filePath, wrote: true, remainingKeys: [] }
  }
  writeClaudeCodeSettings(filePath, stripped, snapshot.raw)
  return {
    path: filePath,
    wrote: true,
    remainingKeys: Object.keys(stripped),
  }
}

export function revertProxyBaseUrl(
  filePath: string = getClaudeCodeSettingsPath(),
): RevertResult {
  return revertProxyBaseUrlWithMode(filePath, false)
}

export function revertProxyBaseUrlForShutdown(
  filePath: string = getClaudeCodeSettingsPath(),
): RevertResult {
  return revertProxyBaseUrlWithMode(filePath, true)
}
