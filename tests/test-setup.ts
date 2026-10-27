/**
 * Global test preload (registered via bunfig.toml `[test] preload`).
 *
 * Redirects every supported user-data location into a unique sandbox BEFORE any
 * application module is imported. Tests must never inspect or mutate a
 * developer's real home, credentials, client configuration, or platform data.
 * Destructive code should still accept explicit path injection; this sandbox is
 * the suite-wide backstop for a missed seam.
 *
 * Also guarantees the gitignored `src/generated/ui-embed.ts` stub exists before
 * any test module imports it. A fresh worktree never runs `bun install`, so
 * without this the server-boot tests fail with an opaque missing-module error.
 */

import { afterAll, afterEach, beforeEach, mock } from "bun:test"
import consola from "consola"
import fs from "node:fs"

import { createTestUserSandbox } from "./helpers/user-sandbox"

const userSandbox = createTestUserSandbox()

// Import project tooling only after the user environment is contained. Static
// imports execute before this module body and could otherwise resolve host paths.
const { ensureUiEmbedStub } = await import("../scripts/ensure-ui-embed-stub")

// Force the EMPTY stub: a stray build may have left a populated embed behind,
// which flips `HAS_EMBED` true and changes UI-route behavior.
ensureUiEmbedStub(true)

// Fail fast when a test starves the event loop, which per-test timeouts can't
// catch. See tests/helpers/starvation-watchdog.ts.
if (process.env.MAXIMAL_TEST_STARVATION_MS !== "0") {
  const watchdog = new Worker(
    new URL("helpers/starvation-watchdog.ts", import.meta.url),
  )
  watchdog.unref()
  setInterval(() => {
    // eslint-disable-next-line unicorn/require-post-message-target-origin -- a Worker, not a window
    watchdog.postMessage(0)
  }, 1000).unref()
}

beforeEach(() => {
  consola.level = 3
})

// Defense in depth: restore every spy after each test. `mock.module` still needs
// explicit per-file restoration; mock.restore() only covers spyOn patches.
afterEach(() => {
  mock.restore()
})

afterAll(() => {
  try {
    fs.rmSync(userSandbox.root, { recursive: true, force: true })
  } catch {
    /* best effort */
  }
})
