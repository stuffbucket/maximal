import consola from "consola"
import { Hono } from "hono"
import { existsSync } from "node:fs"
import { dirname, join, normalize, resolve, sep } from "node:path"

import { UI_FILES } from "~/generated/ui-embed"
import { contentTypeForPath } from "~/lib/platform/web-content-types"
import { buildDebugState } from "~/routes/debug/route"

import { renderDiagnosticsPage } from "./diagnostics"
import {
  buildInlineUiState,
  injectInlineState,
  isHtmlResponse,
} from "./inline-state"

/**
 * Serves the web UI under `/ui/*`:
 *   - /ui/settings  — the React settings app (Bun-bundled), incl. the Usage
 *     section (the standalone dashboard was removed, §7)
 *   - /ui/diagnostics — the read-only diagnostics page (§1.7)
 *
 * One serving path for both, dev and prod:
 *   - Production: assets are embedded in the compiled binary via the
 *     generated `UI_FILES` map (scripts/gen-ui-embed.ts) and read from
 *     their `$bunfs` paths.
 *   - Dev/tests: `UI_FILES` is the empty stub, so we serve the built
 *     output from `shell/dist/ui` on disk (run `bun run build:ui` /
 *     `--watch`). `MAXIMAL_UI_DIST` overrides the disk location.
 */

const HAS_EMBED = Object.keys(UI_FILES).length > 0

/** Locate `shell/dist/ui` on disk (dev). Walks up from this module. */
function resolveDiskDistDir(): string | null {
  const envDir = process.env.MAXIMAL_UI_DIST
  if (envDir && existsSync(join(envDir, "settings", "index.html")))
    return envDir
  let dir = import.meta.dir
  for (let i = 0; i < 8; i++) {
    const candidate = join(dir, "shell", "dist", "ui")
    if (existsSync(join(candidate, "settings", "index.html"))) return candidate
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return null
}

const DISK_DIST_DIR = HAS_EMBED ? null : resolveDiskDistDir()

/** Reject path traversal; resolve a URL path to a real file under root. */
function safeJoinDisk(root: string, relUrlPath: string): string | null {
  const cleaned = normalize(relUrlPath).replace(/^[/\\]+/, "")
  if (cleaned.startsWith("..") || cleaned.includes(`..${sep}`)) return null
  const full = resolve(root, cleaned)
  if (!full.startsWith(resolve(root) + sep) && full !== resolve(root))
    return null
  return full
}

async function bytesFor(
  urlPath: string,
): Promise<{ bytes: Uint8Array; type: string } | null> {
  if (HAS_EMBED) {
    const entry = UI_FILES[urlPath]
    if (!entry) return null
    const file = Bun.file(entry.path)
    if (!(await file.exists())) return null
    return { bytes: await file.bytes(), type: entry.type }
  }
  // Dev/tests: resolve the disk dir per call so `MAXIMAL_UI_DIST` set by a
  // test (or a freshly-built `shell/dist`) is honoured regardless of when
  // this module was first imported.
  const distDir =
    process.env.MAXIMAL_UI_DIST ? resolveDiskDistDir() : DISK_DIST_DIR
  if (!distDir) return null
  // urlPath is `/ui/<rest>`; map to <distDir>/<rest>.
  const rel = urlPath.replace(/^\/ui\//, "")
  const full = safeJoinDisk(distDir, rel)
  if (!full) return null
  const file = Bun.file(full)
  if (!(await file.exists())) return null
  return { bytes: await file.bytes(), type: contentTypeForPath(full) }
}

// `no-store` mirrors the dashboard's old serving: the Tauri WKWebView
// cached aggressively and served stale UI across upgrades otherwise.
const NO_STORE = { "cache-control": "no-store" } as const

async function serve(
  urlPath: string,
  fallbackIndex: string,
  injectState = false,
): Promise<Response> {
  const hit = (await bytesFor(urlPath)) ?? (await bytesFor(fallbackIndex))
  if (!hit) {
    return new Response(
      "UI bundle not found. Run `bun run build:ui` (or build the sidecar).\n",
      { status: 503, headers: { "content-type": "text/plain; charset=utf-8" } },
    )
  }
  // Instant paint (§1.4): inline the current state as `window.__STATE__` into the
  // served settings HTML so the tab paints populated on first frame; the WS then
  // takes over. Best-effort — a snapshot-build failure serves the plain HTML (the
  // WS still hydrates on connect), never a 500. Only HTML responses are touched,
  // so assets pass straight through.
  let body: Uint8Array | string = hit.bytes
  if (injectState && isHtmlResponse(hit.type)) {
    try {
      const html = new TextDecoder().decode(hit.bytes)
      body = injectInlineState(html, await buildInlineUiState())
    } catch (error) {
      consola.warn(
        "inline-state injection failed; serving UI without window.__STATE__",
        error,
      )
    }
  }
  return new Response(body, {
    status: 200,
    headers: { "content-type": hit.type, ...NO_STORE },
  })
}

export const uiRoutes = new Hono()

// Bare-surface redirect to the canonical trailing-slash index.
uiRoutes.get("/settings", (c) => c.redirect("/ui/settings/", 301))

// Read-only diagnostics page (§1.7): server-rendered, mutation-free, unauthenticated
// (under the /ui prefix). CSRF-safe by construction; secret values are never shown.
// `no-store` so a browser never serves a stale runtime snapshot.
uiRoutes.get("/diagnostics", (c) =>
  c.html(renderDiagnosticsPage(buildDebugState()), 200, NO_STORE),
)

uiRoutes.get("/settings/", () =>
  serve("/ui/settings/index.html", "/ui/settings/index.html", true),
)

// Assets + client-side routes. Settings is an SPA, so unknown sub-paths fall
// back to its index.html (which gets the inlined state). Assets (JS/CSS) pass
// through untouched — only HTML is injected. (The standalone /ui/dashboard was
// removed — its usage view is now the settings SPA's Usage section, §4/§7.)
uiRoutes.get("/settings/*", (c) =>
  serve(c.req.path, "/ui/settings/index.html", true),
)
