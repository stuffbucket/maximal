/**
 * Read / merge / write helpers for Claude Code's `~/.claude/settings.json`.
 */

import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import { apiKeyHelperCommand } from "~/lib/api-key-helper"

export const PROXY_BASE_URL = "http://127.0.0.1:4141"
export const API_KEY_HELPER_COMMAND = apiKeyHelperCommand("claude-code")

const API_KEY_HELPER_KEY = "apiKeyHelper"
const BASE_URL_KEY = "ANTHROPIC_BASE_URL"
const ENV_KEY = "env"

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
  return settings[API_KEY_HELPER_KEY] === API_KEY_HELPER_COMMAND ?
      "ours"
    : "foreign"
}

export function mergeBaseUrl(
  existing: Record<string, unknown>,
): Record<string, unknown> {
  const env = { ...readEnv(existing), [BASE_URL_KEY]: PROXY_BASE_URL }
  return {
    ...existing,
    [ENV_KEY]: env,
    [API_KEY_HELPER_KEY]: API_KEY_HELPER_COMMAND,
  }
}

export function stripBaseUrl(
  existing: Record<string, unknown>,
): Record<string, unknown> {
  const currentEnv = readEnv(existing)
  const { [BASE_URL_KEY]: _droppedBaseUrl, ...envWithoutBaseUrl } = currentEnv
  const env =
    currentEnv[BASE_URL_KEY] === PROXY_BASE_URL ? envWithoutBaseUrl : currentEnv
  const { [ENV_KEY]: _droppedEnv, ...withoutEnv } = existing
  const { [API_KEY_HELPER_KEY]: _droppedHelper, ...withoutHelper } = withoutEnv
  const rest =
    existing[API_KEY_HELPER_KEY] === API_KEY_HELPER_COMMAND ?
      withoutHelper
    : withoutEnv
  if (Object.keys(env).length === 0) {
    return rest
  }
  return { ...rest, [ENV_KEY]: env }
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
    return { path: filePath, wrote: false, skippedReason: "already-ours" }
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
