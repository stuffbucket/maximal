/**
 * Global test preload (registered via bunfig.toml `[test] preload`).
 *
 * Points COPILOT_API_HOME at a throwaway temp directory BEFORE any module is
 * imported, so paths.ts resolves PATHS.APP_DIR / ACCOUNTS_PATH / GITHUB_TOKEN_PATH
 * / logs into that temp dir. Without this, any test that exercises the real
 * registry/token helpers (e.g. forwardError -> markAuthDegraded -> the default
 * registry wrappers) reads and WRITES the developer's real
 * ~/.local/share/maximal/accounts.json — which has corrupted real sign-in state
 * during test runs. Tests must never touch real user credentials.
 *
 * Respects an explicit COPILOT_API_HOME (a test that sets its own wins).
 */

import fs from "node:fs"
import os from "node:os"
import path from "node:path"

if (!process.env.COPILOT_API_HOME) {
  const dir = path.join(os.tmpdir(), `maximal-test-home-${process.pid}`)
  fs.mkdirSync(dir, { recursive: true })
  process.env.COPILOT_API_HOME = dir
}
