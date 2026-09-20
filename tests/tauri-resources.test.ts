import { describe, expect, test } from "bun:test"
import { existsSync, readFileSync } from "node:fs"
import { resolve } from "node:path"

/**
 * Pins the "the packaged UI is embedded in the sidecar binary, not staged
 * as a Tauri resource" architecture (src/routes/ui/route.ts + the embed
 * generator). The old approach shipped `shell/dist` as a `bundle.resources`
 * entry and pointed the sidecar at it via MAXIMAL_SETTINGS_DIST; the CLI /
 * Homebrew bottle never carried that directory, so /settings 503'd on those
 * channels (issue #132). Embedding the UI in the binary fixes that, so the
 * resource staging must NOT come back.
 */

const REPO_ROOT = resolve(import.meta.dir, "..")
const TAURI_CONF = resolve(REPO_ROOT, "shell", "src-tauri", "tauri.conf.json")

interface TauriConf {
  bundle?: {
    resources?: Array<string> | Record<string, string>
  }
}

function loadConf(): TauriConf {
  return JSON.parse(readFileSync(TAURI_CONF, "utf8")) as TauriConf
}

function resourcePatterns(conf: TauriConf): Array<string> {
  const r = conf.bundle?.resources
  if (!r) return []
  return Array.isArray(r) ? r : Object.keys(r)
}

describe("packaged UI is embedded, not staged", () => {
  test("tauri.conf.json parses", () => {
    expect(() => loadConf()).not.toThrow()
  })

  test("does not stage shell/dist as a Tauri resource (it's embedded instead)", () => {
    const patterns = resourcePatterns(loadConf())
    const stagesDist = patterns.some((p) => /dist/i.test(p))
    expect(
      stagesDist,
      `tauri.conf.json bundle.resources stages a dist directory (${JSON.stringify(patterns)}). `
        + "The UI is now embedded in the sidecar binary (src/routes/ui/route.ts) — "
        + "staging it again resurrects the #132 split where CLI/Homebrew lacked it.",
    ).toBe(false)
  })

  test("the embed mechanism is present (generator + route)", () => {
    expect(existsSync(resolve(REPO_ROOT, "scripts", "gen-ui-embed.ts"))).toBe(
      true,
    )
    const route = readFileSync(
      resolve(REPO_ROOT, "src", "routes", "ui", "route.ts"),
      "utf8",
    )
    expect(route).toContain("UI_FILES")
  })
})
