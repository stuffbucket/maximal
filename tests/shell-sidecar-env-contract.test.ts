import { describe, expect, test } from "bun:test"
import { readdirSync, readFileSync } from "node:fs"
import { resolve } from "node:path"

/**
 * The Tauri shell hands the sidecar its launch context through environment
 * variables it sets on the spawned process (shell/src-tauri/src/lib.rs), and
 * the sidecar reads them back by bare string literal somewhere under src/.
 * There is no compiler spanning that Rust↔TS boundary, so a one-sided rename
 * fails silently — and each of these contracts breaks a *different* launch
 * behaviour with no error:
 *
 *   MAXIMAL_SIDECAR_PARENT_PID — the parent-death watchdog. Drift → the
 *     sidecar never self-terminates when the tray app is force-killed, so a
 *     proxy is orphaned on :4141 and the *next* launch hits "port busy".
 *   MAXIMAL_SHELL_KEY — the shell-internal API key the webview sends on every
 *     /settings/api/* call. Drift → the user's own UI gets 401s after they
 *     flip "Block unknown connections", which reads as "sign-in is broken".
 *
 * (The settings/dashboard UI itself is embedded in the sidecar binary and
 * served at /ui/*, so the shell no longer passes a UI directory — there is
 * no MAXIMAL_SETTINGS_DIST contract to pin.)
 *
 * These tests pin both ends of each contract: the Rust spawn block must set
 * the name, and some TS source under src/ must read it. A rename on either
 * side fails CI instead of a user's launch.
 */

const REPO_ROOT = resolve(import.meta.dir, "..")
const SHELL_LIB_RS = resolve(REPO_ROOT, "shell", "src-tauri", "src", "lib.rs")
const SRC_DIR = resolve(REPO_ROOT, "src")

/** Env-var names the shell injects into the sidecar that the sidecar must read. */
const LAUNCH_ENV_CONTRACTS = [
  "MAXIMAL_SIDECAR_PARENT_PID",
  "MAXIMAL_SHELL_KEY",
] as const

function readAllTsSources(dir: string): string {
  let combined = ""
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = resolve(dir, entry.name)
    if (entry.isDirectory()) {
      combined += readAllTsSources(full)
    } else if (entry.name.endsWith(".ts") || entry.name.endsWith(".tsx")) {
      combined += readFileSync(full, "utf8")
    }
  }
  return combined
}

const rustSource = readFileSync(SHELL_LIB_RS, "utf8")
const tsSources = readAllTsSources(SRC_DIR)

describe("shell ↔ sidecar launch env contract", () => {
  for (const name of LAUNCH_ENV_CONTRACTS) {
    test(`${name}: shell sets it (lib.rs) and the sidecar reads it (src/)`, () => {
      // Rust side: `cmd.env("NAME", …)` — match the name as a quoted literal
      // anywhere in the spawn wiring (whitespace/newlines vary).
      const rustSets = rustSource.includes(`"${name}"`)
      expect(
        rustSets,
        `shell/src-tauri/src/lib.rs no longer sets ${name} on the sidecar — `
          + `the sidecar still reads it, so launch wiring is now one-sided.`,
      ).toBe(true)

      // TS side: `process.env.NAME` or `process.env["NAME"]`.
      const tsReads =
        tsSources.includes(`process.env.${name}`)
        || tsSources.includes(`process.env["${name}"]`)
      expect(
        tsReads,
        `No src/**/*.ts reads ${name} — the shell still injects it, so the `
          + `value is set but nothing consumes it (silent launch regression).`,
      ).toBe(true)
    })
  }
})
