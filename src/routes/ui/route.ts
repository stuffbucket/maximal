import { Hono } from "hono"
import { existsSync } from "node:fs"
import { dirname, join, normalize, resolve, sep } from "node:path"

import { UI_FILES } from "~/generated/ui-embed"

/**
 * Serves the web UIs under `/ui/*`:
 *   - /ui/settings  — the React settings app (Bun-bundled)
 *   - /ui/dashboard — the usage dashboard (vanilla)
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

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".mjs": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".map": "application/json; charset=utf-8",
}

function contentType(path: string): string {
  const dot = path.toLowerCase().lastIndexOf(".")
  return (
    (dot === -1 ? undefined : CONTENT_TYPES[path.toLowerCase().slice(dot)])
    ?? "application/octet-stream"
  )
}

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
  return { bytes: await file.bytes(), type: contentType(full) }
}

// `no-store` mirrors the dashboard's old serving: the Tauri WKWebView
// cached aggressively and served stale UI across upgrades otherwise.
const NO_STORE = { "cache-control": "no-store" } as const

async function serve(
  urlPath: string,
  fallbackIndex: string,
): Promise<Response> {
  const hit = (await bytesFor(urlPath)) ?? (await bytesFor(fallbackIndex))
  if (!hit) {
    return new Response(
      "UI bundle not found. Run `bun run build:ui` (or build the sidecar).\n",
      { status: 503, headers: { "content-type": "text/plain; charset=utf-8" } },
    )
  }
  return new Response(hit.bytes, {
    status: 200,
    headers: { "content-type": hit.type, ...NO_STORE },
  })
}

export const uiRoutes = new Hono()

// Bare-surface redirects to the canonical trailing-slash index.
uiRoutes.get("/settings", (c) => c.redirect("/ui/settings/", 301))
uiRoutes.get("/dashboard", (c) => c.redirect("/ui/dashboard/", 301))

uiRoutes.get("/settings/", () =>
  serve("/ui/settings/index.html", "/ui/settings/index.html"),
)
uiRoutes.get("/dashboard/", () =>
  serve("/ui/dashboard/index.html", "/ui/dashboard/index.html"),
)

// Assets + client-side routes. Settings is an SPA, so unknown sub-paths
// fall back to its index.html; the dashboard is a single page.
uiRoutes.get("/settings/*", (c) => serve(c.req.path, "/ui/settings/index.html"))
uiRoutes.get("/dashboard/*", (c) =>
  serve(c.req.path, "/ui/dashboard/index.html"),
)
