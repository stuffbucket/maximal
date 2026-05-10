import consola from "consola"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"

const AUTH_APP = process.env.COPILOT_API_OAUTH_APP?.trim() || ""
const ENTERPRISE_PREFIX = process.env.COPILOT_API_ENTERPRISE_URL ? "ent_" : ""

const DEFAULT_DIR = path.join(os.homedir(), ".local", "share", "maximal")
const LEGACY_DIR = path.join(os.homedir(), ".local", "share", "copilot-api")
const APP_DIR = process.env.COPILOT_API_HOME || DEFAULT_DIR

const GITHUB_TOKEN_PATH = path.join(
  APP_DIR,
  AUTH_APP,
  ENTERPRISE_PREFIX + "github_token",
)
const CONFIG_PATH = path.join(APP_DIR, "config.json")

export const PATHS = {
  APP_DIR,
  GITHUB_TOKEN_PATH,
  CONFIG_PATH,
}

export async function ensurePaths(): Promise<void> {
  await migrateLegacyAppDir()
  await fs.mkdir(path.join(PATHS.APP_DIR, AUTH_APP), { recursive: true })
  await ensureFile(PATHS.GITHUB_TOKEN_PATH)
  await ensureFile(PATHS.CONFIG_PATH)
}

/**
 * One-time migration of the pre-rename `~/.local/share/copilot-api`
 * directory to the new `~/.local/share/maximal` location.
 *
 * Cold path (cleanest): the new dir doesn't exist yet. Rename
 * legacy → new in one fs.rename — atomic, preserves mtimes.
 *
 * Warm path: the new dir already exists. An older sibling maximal
 * (or this binary on a previous start) may have created the dir
 * with empty `github_token` / `config.json` placeholders that
 * skipped over the legacy state. Cherry-pick auth + config from the
 * legacy dir if (and only if) the new dir is missing or has zero-
 * byte versions of those files. Never clobber a populated file.
 *
 * Skipped entirely when COPILOT_API_HOME is set or APP_DIR points
 * outside DEFAULT_DIR.
 */
async function migrateLegacyAppDir(): Promise<void> {
  if (process.env.COPILOT_API_HOME) return
  if (APP_DIR !== DEFAULT_DIR) return
  if (!(await pathExists(LEGACY_DIR))) return

  if (!(await pathExists(DEFAULT_DIR))) {
    try {
      await fs.rename(LEGACY_DIR, DEFAULT_DIR)
      consola.info(`Migrated app data: ${LEGACY_DIR} → ${DEFAULT_DIR}`)
      return
    } catch (err) {
      consola.warn(
        `Could not move legacy app data from ${LEGACY_DIR} to ${DEFAULT_DIR}; `
          + `using a fresh directory.`,
        err,
      )
      return
    }
  }

  // Warm-migration cherry-pick: pull forward each known stateful
  // file if (and only if) the new dir's copy is absent or empty.
  for (const relPath of ["github_token", "config.json"]) {
    const fromPath = path.join(LEGACY_DIR, relPath)
    const toPath = path.join(DEFAULT_DIR, relPath)
    try {
      const fromStat = await fs.stat(fromPath)
      if (!fromStat.isFile() || fromStat.size === 0) continue
    } catch {
      continue
    }
    try {
      const toStat = await fs.stat(toPath)
      if (toStat.isFile() && toStat.size > 0) continue
    } catch {
      // toPath doesn't exist — fine, copy through
    }
    try {
      await fs.copyFile(fromPath, toPath)
      await fs.chmod(toPath, 0o600)
      consola.info(`Carried legacy ${relPath} forward from ${LEGACY_DIR}`)
    } catch (err) {
      consola.warn(`Could not carry forward ${fromPath} → ${toPath}`, err)
    }
  }
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await fs.access(p, fs.constants.F_OK)
    return true
  } catch {
    return false
  }
}

async function ensureFile(filePath: string): Promise<void> {
  try {
    await fs.access(filePath, fs.constants.W_OK)
  } catch {
    await fs.writeFile(filePath, "")
    await fs.chmod(filePath, 0o600)
  }
}
