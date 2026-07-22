import { describe, expect, test } from "bun:test"
import { existsSync, readFileSync } from "node:fs"
import { join, resolve } from "node:path"

/**
 * Production-build smoke test for the web UI. Catches the "build stopped
 * producing servable assets" regression.
 *
 * GATED OFF BY DEFAULT — set MAXIMAL_TEST_BUILD=1 to enable. CI sets it on
 * the `bun test` step (.github/workflows/ci.yml). The build is fast (Bun
 * bundler), but it writes into shell/dist, which we don't want every local
 * `bun test` loop to do.
 *
 * The single-window redesign (#343) collapsed the app to one bundled
 * surface (settings) plus the standalone native chrome (splash +
 * update-confirm). The separate dashboard surface was removed, so this only
 * asserts what `build:ui` actually produces today.
 */

const REPO_ROOT = resolve(import.meta.dir, "..")
const DIST_ROOT = join(REPO_ROOT, "shell", "dist")
const DIST_UI = join(DIST_ROOT, "ui")
const SETTINGS_INDEX = join(DIST_UI, "settings", "index.html")

const ENABLED = process.env.MAXIMAL_TEST_BUILD === "1"

describe.skipIf(!ENABLED)("web UI production build", () => {
  test("`bun run build:ui` produces the settings surface + native chrome", async () => {
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

    // Native chrome copied verbatim (copyShellChrome): the pre-boot splash,
    // the branded update-confirm window, the root pointer page, and the
    // vendored fonts those surfaces reference.
    for (const asset of [
      "splash.html",
      "update-confirm.html",
      "index.html",
      "vendor/fonts/fraunces-latin.woff2",
      "vendor/fonts/commissioner-latin.woff2",
    ]) {
      expect(existsSync(join(DIST_ROOT, asset))).toBe(true)
    }
  }, 60_000)
})
