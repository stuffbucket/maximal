#!/usr/bin/env bun
/**
 * Build the web UIs into `shell/dist/ui/<surface>/`.
 *
 *   - settings: a React/TSX app — transpiled + bundled by Bun's bundler
 *     (replaces the old Vite build). Browser-runnable plain files.
 *   - dashboard: hand-authored vanilla HTML/CSS/JS that runs in the
 *     browser as-is. It loads its Tailwind/Lucide vendors as classic
 *     global <script>s, so it is intentionally NOT bundled (that would
 *     turn those globals into module scope). We copy its source verbatim.
 *
 * Both end up as plain static files served by the proxy under `/ui/*`
 * (src/routes/ui/route.ts): from disk in dev, embedded in the compiled
 * binary in production (see scripts/gen-ui-embed.ts).
 *
 * Usage:
 *   bun scripts/build-ui.ts            # one-shot build
 *   bun scripts/build-ui.ts --watch    # rebuild on change (dev)
 */
import { watch } from "node:fs"
import { cp, mkdir, rm } from "node:fs/promises"
import { dirname, join, resolve } from "node:path"

const REPO = resolve(import.meta.dir, "..")
const SETTINGS_ENTRY = join(REPO, "shell/ui/settings/index.html")
const DASHBOARD_SRC = join(REPO, "shell/ui/dashboard")
const SHELL_DIR = join(REPO, "shell")
const DIST_ROOT = join(REPO, "shell/dist")
const DIST = join(DIST_ROOT, "ui")
const SETTINGS_OUT = join(DIST, "settings")
const DASHBOARD_OUT = join(DIST, "dashboard")

async function buildSettings(): Promise<void> {
  await rm(SETTINGS_OUT, { recursive: true, force: true })
  await mkdir(SETTINGS_OUT, { recursive: true })
  const result = await Bun.build({
    entrypoints: [SETTINGS_ENTRY],
    outdir: SETTINGS_OUT,
    minify: true,
    sourcemap: "none",
    // The proxy serves this under /ui/settings/; emit asset URLs relative
    // to the HTML so they resolve there in both dev and prod.
    naming: { entry: "[name].[ext]", chunk: "[name]-[hash].[ext]", asset: "[name]-[hash].[ext]" },
  })
  if (!result.success) {
    for (const log of result.logs) console.error(log)
    throw new Error("settings build failed")
  }
}

async function copyDashboard(): Promise<void> {
  await rm(DASHBOARD_OUT, { recursive: true, force: true })
  await mkdir(dirname(DASHBOARD_OUT), { recursive: true })
  // Vanilla, browser-runnable source — copied verbatim (html, css, js,
  // vendor/). No transpile, no bundle.
  await cp(DASHBOARD_SRC, DASHBOARD_OUT, { recursive: true })
}

// Tauri's `frontendDist` (shell/dist) must hold the pre-boot splash it
// loads via `WebviewUrl::App("splash.html")`, plus an index.html so the
// bundler has a valid frontend root. The actual settings/dashboard UIs
// are served by the sidecar at /ui/*, so this index is just a pointer.
async function copyShellChrome(): Promise<void> {
  await mkdir(DIST_ROOT, { recursive: true })
  await cp(join(SHELL_DIR, "splash.html"), join(DIST_ROOT, "splash.html"))
  await Bun.write(
    join(DIST_ROOT, "index.html"),
    "<!doctype html><meta charset=utf-8><title>Maximal</title>"
      + "<p>Maximal is running. Open Settings from the menu-bar icon.</p>\n",
  )
}

async function buildAll(): Promise<void> {
  const t = Date.now()
  await Promise.all([buildSettings(), copyDashboard(), copyShellChrome()])
  console.error(`[build-ui] built settings + dashboard → shell/dist/ui (${Date.now() - t}ms)`)
}

await buildAll()

if (process.argv.includes("--watch")) {
  console.error("[build-ui] watching shell/ui for changes…")
  let timer: ReturnType<typeof setTimeout> | null = null
  const schedule = () => {
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => {
      void buildAll().catch((err) => console.error("[build-ui] rebuild failed:", err))
    }, 80)
  }
  watch(join(REPO, "shell/ui"), { recursive: true }, schedule)
  watch(join(REPO, "shell/src"), { recursive: true }, schedule)
  // Keep the process alive.
  await new Promise(() => {})
}
