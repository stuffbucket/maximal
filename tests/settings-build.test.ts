import { describe, expect, test } from "bun:test"
import { existsSync, readFileSync } from "node:fs"
import { join, resolve } from "node:path"

/**
 * Production-build smoke test for the settings shell. Catches the
 * "frontend agent stopped producing dist" regression.
 *
 * GATED OFF BY DEFAULT — set MAXIMAL_TEST_BUILD=1 to enable. The
 * Vite build can take 10-30s and rebuilds node_modules state, which
 * is too heavy for the regular `bun test` loop. CI flips the flag.
 */

const REPO_ROOT = resolve(import.meta.dir, "..")
const SHELL_DIR = join(REPO_ROOT, "shell")
const DIST_DIR = join(SHELL_DIR, "dist")
const INDEX_HTML = join(DIST_DIR, "index.html")

const ENABLED = process.env.MAXIMAL_TEST_BUILD === "1"

describe.skipIf(!ENABLED)("settings shell production build", () => {
  test("bun run build produces shell/dist/index.html with /settings/ asset refs", async () => {
    const proc = Bun.spawn(["bun", "run", "build"], {
      cwd: SHELL_DIR,
      stdout: "pipe",
      stderr: "pipe",
    })

    const startedAt = Date.now()
    const exitCode = await proc.exited
    const elapsed = Date.now() - startedAt

    if (exitCode !== 0) {
      const stderr = await new Response(proc.stderr).text()
      const stdout = await new Response(proc.stdout).text()
      throw new Error(
        `bun run build exited ${exitCode} after ${elapsed}ms.\n`
          + `stdout:\n${stdout}\nstderr:\n${stderr}`,
      )
    }

    expect(exitCode).toBe(0)

    if (elapsed > 30_000) {
      // Don't hard-fail on slow CI runners; surface as a warning
      // via a soft assertion that still passes but is noisy.
      console.warn(
        `[settings-build] Vite build took ${elapsed}ms (>30s budget). `
          + `If this trends up, audit shell/ deps and vite.config.ts.`,
      )
    }

    expect(existsSync(INDEX_HTML)).toBe(true)

    const html = readFileSync(INDEX_HTML, "utf8")

    // shell/vite.config.ts sets `base: "/settings/"` precisely so
    // asset URLs work behind the proxy. If someone removes that,
    // assets resolve at /assets/... and the proxy 404s them.
    const jsMatches = html.match(
      /(?:src|href)="\/settings\/[^"]+\.(?:js|mjs)"/g,
    )
    const cssMatches = html.match(/href="\/settings\/[^"]+\.css"/g)

    expect(jsMatches?.length ?? 0).toBeGreaterThan(0)
    expect(cssMatches?.length ?? 0).toBeGreaterThan(0)
  }, 35_000)
})
