import consola from "consola"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"

const AUTH_APP = process.env.COPILOT_API_OAUTH_APP?.trim() || ""
const ENTERPRISE_PREFIX = process.env.COPILOT_API_ENTERPRISE_URL ? "ent_" : ""

function getDefaultAppDir(): string {
  if (process.platform === "win32") {
    const appData =
      process.env.APPDATA ?? path.join(os.homedir(), "AppData", "Roaming")
    return path.join(appData, "maximal")
  }
  return path.join(os.homedir(), ".local", "share", "maximal")
}

function getLegacyAppDir(): string {
  if (process.platform === "win32") {
    const appData =
      process.env.APPDATA ?? path.join(os.homedir(), "AppData", "Roaming")
    return path.join(appData, "copilot-api")
  }
  return path.join(os.homedir(), ".local", "share", "copilot-api")
}

const DEFAULT_DIR = getDefaultAppDir()
const LEGACY_DIR = getLegacyAppDir()
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
 * One-time rename of the pre-rename app directory to the new location,
 * so users upgrading from v0.3.x don't have to re-auth or re-configure.
 *
 * Linux/macOS: `~/.local/share/copilot-api` → `~/.local/share/maximal`
 * Windows:     `%APPDATA%\copilot-api`       → `%APPDATA%\maximal`
 *
 * Skipped when `COPILOT_API_HOME` is set (the user has explicitly
 * pointed at a custom dir) or when the new dir already exists (we've
 * already migrated, or this is a fresh install).
 */
async function migrateLegacyAppDir(): Promise<void> {
  if (process.env.COPILOT_API_HOME) return
  if (APP_DIR !== DEFAULT_DIR) return

  // Already migrated / fresh install with new layout?
  if (await pathExists(DEFAULT_DIR)) return
  // No legacy state to migrate?
  if (!(await pathExists(LEGACY_DIR))) return

  try {
    await fs.rename(LEGACY_DIR, DEFAULT_DIR)
    consola.info(`Migrated app data: ${LEGACY_DIR} → ${DEFAULT_DIR}`)
  } catch (err) {
    // Don't crash on a migration failure — fall through to creating
    // a fresh directory at the new location. Users keep their old
    // state at the legacy path and can copy by hand if needed.
    consola.warn(
      `Could not move legacy app data from ${LEGACY_DIR} to ${DEFAULT_DIR}; `
        + `using a fresh directory.`,
      err,
    )
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
