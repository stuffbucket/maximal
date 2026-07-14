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

import { z } from "@hono/zod-openapi"
import {
  accessSync,
  constants as fsConstants,
  existsSync,
  readFileSync,
  statSync,
} from "node:fs"
import path from "node:path"

import {
  getActiveRecord,
  readGitHubTokenRecord,
  readRegistry,
  registryPathFor,
} from "~/lib/auth/github-token-store"
import { AppConfigSchema } from "~/lib/config/config-schema"
import { PATHS } from "~/lib/platform/paths"

/**
 * Single source of truth for the `/setup-status` response shape.
 *
 * The Zod schema is authoritative: the `SetupStatus` TypeScript type is
 * derived from it via `z.infer`, and the `/setup-status` OpenAPI
 * operation registers this same schema (see `src/routes/setup-status.ts`).
 * That route-binding is what keeps the published spec from drifting away
 * from the runtime response — there is no second hand-maintained shape to
 * fall out of sync.
 */

export const SetupCheckNameSchema = z
  .enum(["appDir", "config", "db", "githubAuth"])
  .openapi("SetupCheckName")

export const SetupCheckResultSchema = z
  .object({
    ok: z.boolean(),
    reason: z.string().optional(),
    path: z.string().optional(),
  })
  .openapi("SetupCheckResult")

export const SetupStatusSchema = z
  .object({
    ready: z.boolean(),
    checks: z.object({
      appDir: SetupCheckResultSchema,
      config: SetupCheckResultSchema,
      db: SetupCheckResultSchema,
      githubAuth: SetupCheckResultSchema,
    }),
    nextStep: SetupCheckNameSchema.nullable(),
  })
  .openapi("SetupStatus")

export type SetupCheckName = z.infer<typeof SetupCheckNameSchema>
export type SetupCheckResult = z.infer<typeof SetupCheckResultSchema>
export type SetupStatus = z.infer<typeof SetupStatusSchema>

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
  // Registry-aware: the active account's token, with the legacy single-record
  // file as a fallback, now that sign-in writes the registry. The registry is
  // the sibling `*accounts.json` of `file` (keeps the enterprise prefix), so a
  // test passing a temp `file` stays isolated. `file` is still the reported
  // path for the diagnostics line.
  const active = getActiveRecord(await readRegistry(registryPathFor(file)))
  const token =
    active?.token ?? (await readGitHubTokenRecord(file))?.accessToken
  if (!token) {
    return { ok: false, reason: "github_token missing", path: file }
  }
  if (token.length === 0) {
    return { ok: false, reason: "github_token empty", path: file }
  }
  return { ok: true, path: file }
}
