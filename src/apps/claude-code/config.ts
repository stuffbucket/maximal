/**
 * Read / merge / write helpers for Claude Code's `~/.claude/settings.json`.
 */

import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import { apiKeyHelperCommand, isOwnedApiKeyHelper } from "~/lib/api-key-helper"

/** The label Claude Code attributes its key under (Settings → API clients). */
const HELPER_LABEL = "claude-code"

export const PROXY_BASE_URL = "http://127.0.0.1:4141"
/** The apiKeyHelper command for THIS running binary (absolute execPath). A
 *  config carrying an older path is still recognized as ours via
 *  `isOwnedApiKeyHelper` and healed to this value on apply/boot. */
export const API_KEY_HELPER_COMMAND = apiKeyHelperCommand(HELPER_LABEL)

const API_KEY_HELPER_KEY = "apiKeyHelper"
const BASE_URL_KEY = "ANTHROPIC_BASE_URL"
const ENV_KEY = "env"

/** maximal-namespaced snapshot of the two fields we touch, taken on first
 *  apply so disable can restore EXACTLY what was there before — rather than
 *  blindly deleting (which would drop a value the user happened to set to the
 *  same proxy URL / our own helper string). Claude Code ignores unknown keys,
 *  and we strip this on revert. */
const PRIOR_KEY = "_maximalPrior"
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

export function getApiKeyHelperOwnership(
  settings: Record<string, unknown>,
): ApiKeyHelperOwnership {
  if (!(API_KEY_HELPER_KEY in settings)) return "absent"
  // Ours by SIGNATURE, not exact string: a command pointing at an older
  // maximal path still ends with `--apiKeyHelper claude-code`, so we recognize
  // it as ours (to heal/strip it) rather than misclassifying it as foreign.
  return isOwnedApiKeyHelper(settings[API_KEY_HELPER_KEY], HELPER_LABEL) ?
      "ours"
    : "foreign"
}

export function mergeBaseUrl(
  existing: Record<string, unknown>,
): Record<string, unknown> {
  const env = { ...readEnv(existing), [BASE_URL_KEY]: PROXY_BASE_URL }
  // Capture the prior values of the two fields we touch — but ONLY on the first
  // apply (when no snapshot exists yet). Re-apply / self-heal must not overwrite
  // the snapshot, or it would record OUR values as the "prior" state and disable
  // would restore the proxy URL instead of removing it. UNSET marks a field that
  // was absent so revert deletes it rather than writing the sentinel back.
  const priorEnvBaseUrl = readEnv(existing)
  const prior =
    PRIOR_KEY in existing ?
      existing[PRIOR_KEY]
    : {
        [BASE_URL_KEY]:
          BASE_URL_KEY in priorEnvBaseUrl ?
            priorEnvBaseUrl[BASE_URL_KEY]
          : UNSET,
        [API_KEY_HELPER_KEY]:
          API_KEY_HELPER_KEY in existing ? existing[API_KEY_HELPER_KEY] : UNSET,
      }
  return {
    ...existing,
    [ENV_KEY]: env,
    [API_KEY_HELPER_KEY]: API_KEY_HELPER_COMMAND,
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

  // Drop our snapshot key + the env wrapper; rebuild env below.
  const {
    [PRIOR_KEY]: _droppedPrior,
    [ENV_KEY]: _droppedEnv,
    ...rest
  } = existing
  const currentEnv = readEnv(existing)
  const { [BASE_URL_KEY]: _droppedBaseUrl, ...envWithoutBaseUrl } = currentEnv
  const { [API_KEY_HELPER_KEY]: _droppedHelper, ...withoutHelper } = rest

  if (snapshot) {
    // RESTORE path: put the two fields back to exactly what was there before we
    // first applied (or remove them if they were absent). This correctly
    // handles the case where the user's own prior value happened to equal the
    // proxy URL / our helper string — a blind delete would have lost it.
    const env = withRestoredField(
      envWithoutBaseUrl,
      BASE_URL_KEY,
      snapshot[BASE_URL_KEY],
    )
    const base = withRestoredField(
      withoutHelper,
      API_KEY_HELPER_KEY,
      snapshot[API_KEY_HELPER_KEY],
    )
    if (Object.keys(env).length === 0) return base
    return { ...base, [ENV_KEY]: env }
  }

  // FALLBACK (no snapshot — e.g. a config written before snapshots existed):
  // delete only the values that are ours, ownership-guarded as before.
  const env =
    currentEnv[BASE_URL_KEY] === PROXY_BASE_URL ? envWithoutBaseUrl : currentEnv
  const baseRest =
    isOwnedApiKeyHelper(existing[API_KEY_HELPER_KEY], HELPER_LABEL) ?
      withoutHelper
    : rest
  if (Object.keys(env).length === 0) {
    return baseRest
  }
  return { ...baseRest, [ENV_KEY]: env }
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
  const dir = path.dirname(filePath)
  fs.mkdirSync(dir, { recursive: true })
  const tmp = `${filePath}.tmp`
  const json = `${JSON.stringify(settings, null, 2)}\n`
  try {
    fs.unlinkSync(tmp)
  } catch (err: unknown) {
    if (!(err instanceof Error) || !("code" in err) || err.code !== "ENOENT") {
      throw err
    }
  }
  let fd: number
  try {
    fd = fs.openSync(
      tmp,
      fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL,
      0o600,
    )
  } catch (err: unknown) {
    if (err instanceof Error && "code" in err && err.code === "EEXIST") {
      throw new Error(
        `refusing to write Claude Code settings: ${tmp} already exists (possible symlink attack); remove it and retry`,
      )
    }
    throw err
  }
  try {
    fs.writeFileSync(fd, json)
    fs.fsyncSync(fd)
  } finally {
    fs.closeSync(fd)
  }
  fs.renameSync(tmp, filePath)
}

export type SkipReason =
  | "already-ours"
  | "foreign-base-url"
  | "foreign-api-key-helper"

export interface ApplyResult {
  path: string
  wrote: boolean
  skippedReason?: SkipReason
}

export function applyProxyBaseUrl(
  filePath: string = getClaudeCodeSettingsPath(),
): ApplyResult {
  const existing = readClaudeCodeSettings(filePath)
  const baseUrlOwnership = getBaseUrlOwnership(existing)
  const helperOwnership = getApiKeyHelperOwnership(existing)
  if (baseUrlOwnership === "ours" && helperOwnership === "ours") {
    // Both ours. Skip UNLESS the helper command points at a stale maximal path
    // (ours by signature but not the current execPath) — then heal it to the
    // current absolute path so a moved/updated app keeps working.
    if (existing[API_KEY_HELPER_KEY] === API_KEY_HELPER_COMMAND) {
      return { path: filePath, wrote: false, skippedReason: "already-ours" }
    }
    writeClaudeCodeSettings(filePath, mergeBaseUrl(existing))
    return { path: filePath, wrote: true }
  }
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
  writeClaudeCodeSettings(filePath, mergeBaseUrl(existing))
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
