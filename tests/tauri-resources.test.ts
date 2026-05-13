import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { resolve } from "node:path"

/**
 * Catches the "shell/dist not bundled into the Tauri app" class of
 * bug. When the proxy is packaged via `tauri build`, the menu-bar
 * binary needs `shell/dist/**\/*` (or equivalent) listed under
 * bundle.resources or the production /settings route silently 503s
 * because the sidecar's working directory has no `shell/dist`.
 *
 * Depends on the resources entry added in:
 *   feat(shell): bundle shell/dist as Tauri resource
 * If that commit hasn't landed in this worktree's base yet, this
 * test is EXPECTED TO FAIL. Rebase onto main after the parallel
 * `tauri-resources` agent merges and it should pass.
 */

const TAURI_CONF = resolve(
  import.meta.dir,
  "..",
  "shell",
  "src-tauri",
  "tauri.conf.json",
)

interface TauriConf {
  bundle?: {
    resources?: Array<string> | Record<string, string>
  }
}

function loadConf(): TauriConf {
  const raw = readFileSync(TAURI_CONF, "utf8")
  return JSON.parse(raw) as TauriConf
}

function resourcePatterns(conf: TauriConf): Array<string> {
  const r = conf.bundle?.resources
  if (!r) return []
  if (Array.isArray(r)) return r
  // Tauri 2 also accepts an object form mapping src -> dest.
  return Object.keys(r)
}

describe("tauri.conf.json bundle.resources", () => {
  test("file parses as JSON", () => {
    expect(() => loadConf()).not.toThrow()
  })

  test("bundle.resources includes the shell/dist output", () => {
    const conf = loadConf()
    const patterns = resourcePatterns(conf)

    // Accept any of the reasonable conventions; the parallel agent
    // picks one. We only require that *some* entry references the
    // shell dist directory.
    const matchers = [
      /shell[\\/]dist/i, // shell/dist or shell/dist/**
      /\.\.[\\/]dist/i, // ../dist (relative to src-tauri/)
      /\*\*[\\/]dist[\\/]\*\*/, // **/dist/**
    ]

    const matched = patterns.some((p) => matchers.some((m) => m.test(p)))

    expect(matched).toBe(true)
    if (!matched) {
      // This message is what a future failing test surfaces. It
      // points at the PRD context so the next reader knows why
      // this assertion exists.
      throw new Error(
        "tauri.conf.json bundle.resources is missing a shell/dist "
          + "entry. Packaged builds will 503 on GET /settings because the "
          + "sidecar binary can't find shell/dist. See PRD: "
          + "feat(shell): bundle shell/dist as Tauri resource.\n"
          + `Current resources: ${JSON.stringify(patterns)}`,
      )
    }
  })
})
