import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"

const AUTH_APP = process.env.COPILOT_API_OAUTH_APP?.trim() || ""
const ENTERPRISE_PREFIX = process.env.COPILOT_API_ENTERPRISE_URL ? "ent_" : ""

/** Inputs to {@link resolveAppDir}, injected so the resolver is pure/testable. */
export interface AppDirEnv {
  platform: NodeJS.Platform
  homedir: string
  /** `COPILOT_API_HOME` override (highest precedence on every platform). */
  copilotApiHome?: string
  /** `%APPDATA%` (win32 only); falls back to `<home>\AppData\Roaming`. */
  appData?: string
}

/**
 * Resolve the single app-data root, per the cross-platform convention:
 *   - `COPILOT_API_HOME` overrides everywhere (highest precedence).
 *   - win32:  `%APPDATA%\maximal`  (fallback `<home>\AppData\Roaming\maximal`).
 *   - else:   `<home>/.local/share/maximal`  (macOS + Linux, unchanged).
 *
 * Logs live at `<root>/logs` on every platform — the caller derives that from
 * this single root, so there is exactly one place the convention is encoded.
 */
export function resolveAppDir(env: AppDirEnv): string {
  const override = env.copilotApiHome?.trim()
  if (override) {
    return override
  }
  if (env.platform === "win32") {
    const roaming =
      env.appData?.trim() || path.join(env.homedir, "AppData", "Roaming")
    return path.join(roaming, "maximal")
  }
  return path.join(env.homedir, ".local", "share", "maximal")
}

const APP_DIR = resolveAppDir({
  platform: process.platform,
  homedir: os.homedir(),
  copilotApiHome: process.env.COPILOT_API_HOME,
  appData: process.env.APPDATA,
})

const GITHUB_TOKEN_PATH = path.join(
  APP_DIR,
  AUTH_APP,
  ENTERPRISE_PREFIX + "github_token",
)
// Multi-account registry (schema v2). Co-located with the legacy single-record
// token file so it inherits the same oauth-app + enterprise-prefix namespacing.
const ACCOUNTS_PATH = path.join(
  APP_DIR,
  AUTH_APP,
  ENTERPRISE_PREFIX + "accounts.json",
)
const CONFIG_PATH = path.join(APP_DIR, "config.json")

export const PATHS = {
  APP_DIR,
  GITHUB_TOKEN_PATH,
  ACCOUNTS_PATH,
  CONFIG_PATH,
}

export async function ensurePaths(): Promise<void> {
  await fs.mkdir(path.join(PATHS.APP_DIR, AUTH_APP), { recursive: true })
  await ensureFile(PATHS.GITHUB_TOKEN_PATH)
  await ensureFile(PATHS.CONFIG_PATH)
}

async function ensureFile(filePath: string): Promise<void> {
  try {
    await fs.access(filePath, fs.constants.W_OK)
  } catch {
    await fs.writeFile(filePath, "")
    await fs.chmod(filePath, 0o600)
  }
}
