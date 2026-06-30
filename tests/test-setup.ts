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
 *
 * Also guarantees the gitignored `src/generated/ui-embed.ts` stub exists
 * before any test module imports it (src/routes/ui/route.ts). A fresh
 * `git worktree` never runs `bun install`, so without this the server-boot
 * tests fail with an opaque "Cannot find module '~/generated/ui-embed'".
 */

import { beforeEach } from "bun:test"
import consola from "consola"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import { ensureUiEmbedStub } from "../scripts/ensure-ui-embed-stub"

// Reset the global consola level before every test. Some tests bump it to 5
// (verbose mode, e.g. start-run-server) and don't restore it, leaking debug
// logging into later tests — notably the RFC 8628 device-code poll loop in
// poll-access-token.ts, which logs every poll and floods output with hundreds
// of lines. Level 3 (Info) hides debug(4)/trace(5); errors/warns still show.
beforeEach(() => {
  consola.level = 3
})

// Force the EMPTY stub: a stray build (build:ui / app:dev / ui:harness) may have
// left a populated embed behind, which flips `HAS_EMBED` true and makes the
// ui-route tests serve the real embedded UI instead of their fixture dir.
ensureUiEmbedStub(true)

if (!process.env.COPILOT_API_HOME) {
  const dir = path.join(os.tmpdir(), `maximal-test-home-${process.pid}`)
  fs.mkdirSync(dir, { recursive: true })
  process.env.COPILOT_API_HOME = dir
}
