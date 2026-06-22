import { describe, expect, test } from "bun:test"
import { existsSync, readFileSync } from "node:fs"
import { join, resolve } from "node:path"

/**
 * Production-build smoke test for the web UI. Catches the "build stopped
 * producing servable assets" regression.
 *
 * GATED OFF BY DEFAULT — set MAXIMAL_TEST_BUILD=1 to enable. CI flips the
 * flag. The build is fast (Bun bundler), but it writes into shell/dist,
 * which we don't want every `bun test` loop to do.
 */

const REPO_ROOT = resolve(import.meta.dir, "..")
const DIST_UI = join(REPO_ROOT, "shell", "dist", "ui")
const SETTINGS_INDEX = join(DIST_UI, "settings", "index.html")
const DASHBOARD_INDEX = join(DIST_UI, "dashboard", "index.html")

const ENABLED = process.env.MAXIMAL_TEST_BUILD === "1"

describe.skipIf(!ENABLED)("web UI production build", () => {
  test("`bun run build:ui` produces settings + dashboard under shell/dist/ui", async () => {
    const proc = Bun.spawn(["bun", "run", "build:ui"], {
      cwd: REPO_ROOT,
      stdout: "pipe",
      stderr: "pipe",
    })
    const exitCode = await proc.exited
    if (exitCode !== 0) {
      const stderr = await new Response(proc.stderr).text()
      const stdout = await new Response(proc.stdout).text()
      throw new Error(
        `build:ui exited ${exitCode}.\nstdout:\n${stdout}\nstderr:\n${stderr}`,
      )
    }
    expect(exitCode).toBe(0)

    // Settings: Bun-bundled React app — HTML plus hashed JS/CSS siblings.
    expect(existsSync(SETTINGS_INDEX)).toBe(true)
    const settingsHtml = readFileSync(SETTINGS_INDEX, "utf8")
    expect(
      settingsHtml.match(/(?:src|href)="\.\/[^"]+\.(?:js|mjs|css)"/g)?.length
        ?? 0,
    ).toBeGreaterThan(0)

    // Dashboard: vanilla, copied verbatim — references its sibling assets.
    expect(existsSync(DASHBOARD_INDEX)).toBe(true)
    const dashboardHtml = readFileSync(DASHBOARD_INDEX, "utf8")
    expect(dashboardHtml).toContain("./main.js")
  }, 60_000)
})
