/**
 * First-run / runtime setup detection.
 *
 * Composes existing helpers (paths, config, github-token-store) into a
 * single JSON-friendly snapshot the Tauri shell can poll on launch. Each
 * check is observational and fast (sub-ms); no network, no live token
 * introspection. The proxy's existing boot path self-heals appDir,
 * config, and db on its own — this function reports what is, not what
 * should be.
 *
 * Canonical evaluation order: appDir → config → db → githubAuth. The
 * first failing check (in that order) is surfaced as `nextStep`. If
 * everything passes, `nextStep` is null and `ready` is true.
 *
 * See docs/first-run-setup-prd.md.
 */

import {
  accessSync,
  constants as fsConstants,
  existsSync,
  readFileSync,
  statSync,
} from "node:fs"
import path from "node:path"

import { AppConfigSchema } from "./config-schema"
import { readGitHubTokenRecord } from "./github-token-store"
import { PATHS } from "./paths"

export type SetupCheckName = "appDir" | "config" | "db" | "githubAuth"

export interface SetupCheckResult {
  ok: boolean
  reason?: string
  path?: string
}

export interface SetupStatus {
  ready: boolean
  checks: Record<SetupCheckName, SetupCheckResult>
  nextStep: SetupCheckName | null
}

const CHECK_ORDER: ReadonlyArray<SetupCheckName> = [
  "appDir",
  "config",
  "db",
  "githubAuth",
]

const DB_FILENAME = "copilot-api.sqlite"

export interface SetupPaths {
  appDir: string
  configPath: string
  dbPath: string
  githubTokenPath: string
}

function defaultPaths(): SetupPaths {
  return {
    appDir: PATHS.APP_DIR,
    configPath: PATHS.CONFIG_PATH,
    dbPath: path.join(PATHS.APP_DIR, DB_FILENAME),
    githubTokenPath: PATHS.GITHUB_TOKEN_PATH,
  }
}

export async function evaluateSetup(
  paths: SetupPaths = defaultPaths(),
): Promise<SetupStatus> {
  const checks: Record<SetupCheckName, SetupCheckResult> = {
    appDir: checkAppDir(paths.appDir),
    config: checkConfig(paths.configPath),
    db: checkDb(paths.dbPath),
    githubAuth: await checkGithubAuth(paths.githubTokenPath),
  }
  const nextStep = CHECK_ORDER.find((name) => !checks[name].ok) ?? null
  return {
    ready: nextStep === null,
    checks,
    nextStep,
  }
}

function checkAppDir(dir: string): SetupCheckResult {
  if (!existsSync(dir)) {
    return { ok: false, reason: "directory does not exist", path: dir }
  }
  try {
    accessSync(dir, fsConstants.W_OK)
  } catch {
    return { ok: false, reason: "directory not writable", path: dir }
  }
  return { ok: true, path: dir }
}

function checkConfig(file: string): SetupCheckResult {
  if (!existsSync(file)) {
    // Absent is OK — getConfig() falls back to defaults. The proxy will
    // create the file on first write.
    return { ok: true, path: file }
  }
  let raw: string
  try {
    raw = readFileSync(file, "utf8")
  } catch (err) {
    return {
      ok: false,
      reason: `cannot read: ${(err as Error).message}`,
      path: file,
    }
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return { ok: false, reason: "invalid JSON", path: file }
  }
  const result = AppConfigSchema.safeParse(parsed)
  if (!result.success) {
    const firstIssue = result.error.issues[0]
    const where =
      firstIssue.path.length > 0 ? firstIssue.path.join(".") : "(root)"
    return {
      ok: false,
      reason: `schema mismatch at ${where}`,
      path: file,
    }
  }
  return { ok: true, path: file }
}

function checkDb(file: string): SetupCheckResult {
  if (!existsSync(file)) {
    // Absent is OK — token-usage code creates the file on first write.
    return { ok: true, path: file }
  }
  let size: number
  try {
    size = statSync(file).size
  } catch {
    return { ok: false, reason: "cannot stat", path: file }
  }
  if (size === 0) {
    return { ok: false, reason: "empty file", path: file }
  }
  return { ok: true, path: file }
}

async function checkGithubAuth(file: string): Promise<SetupCheckResult> {
  if (!existsSync(file)) {
    return { ok: false, reason: "github_token missing", path: file }
  }
  const record = await readGitHubTokenRecord(file)
  if (!record) {
    return { ok: false, reason: "github_token unreadable", path: file }
  }
  if (!record.accessToken || record.accessToken.length === 0) {
    return { ok: false, reason: "github_token empty", path: file }
  }
  return { ok: true, path: file }
}
