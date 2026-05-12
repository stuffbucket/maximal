import { Hono } from "hono"
import { existsSync } from "node:fs"
import { dirname, join, normalize, resolve, sep } from "node:path"

// Vite dev server port for the shell app. Matches shell/vite.config.ts.
const SHELL_VITE_PORT = 1420

const MIME_TYPES: Record<string, string> = {
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
  ".otf": "font/otf",
  ".map": "application/json; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
}

function contentTypeFor(path: string): string {
  const lower = path.toLowerCase()
  const dot = lower.lastIndexOf(".")
  if (dot === -1) return "application/octet-stream"
  return MIME_TYPES[lower.slice(dot)] ?? "application/octet-stream"
}

/**
 * Locate the built settings bundle (shell/dist) on disk.
 *
 * Order:
 *   1. MAXIMAL_SETTINGS_DIST env var (absolute path).
 *   2. Walk up from this file looking for `shell/dist/index.html`. Covers
 *      `bun run dev`, `bun run start`, and `bun run build` → dist/main.js
 *      runs from the repo root.
 *
 * Returns null if the bundle isn't found. The Tauri-compiled sidecar
 * binary embeds nothing of `shell/dist/` today; that path is owned by
 * the Tauri bundler (resources) — out of scope here.
 */
function resolveSettingsDistDir(): string | null {
  const envDir = process.env.MAXIMAL_SETTINGS_DIST
  if (envDir && existsSync(join(envDir, "index.html"))) {
    return envDir
  }

  let dir = import.meta.dir
  for (let i = 0; i < 8; i++) {
    const candidate = join(dir, "shell", "dist")
    if (existsSync(join(candidate, "index.html"))) {
      return candidate
    }
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return null
}

const SETTINGS_DIST_DIR = resolveSettingsDistDir()

/** Strip leading `/` and normalize. Reject any `..` escape attempts. */
function safeJoin(root: string, relPath: string): string | null {
  const cleaned = normalize(relPath).replace(/^[/\\]+/, "")
  if (cleaned.startsWith("..") || cleaned.includes(`..${sep}`)) return null
  const full = resolve(root, cleaned)
  if (!full.startsWith(resolve(root) + sep) && full !== resolve(root)) {
    return null
  }
  return full
}

async function serveFromDist(
  distDir: string,
  relPath: string,
): Promise<Response> {
  // index.html for the root mount, or any path that doesn't resolve to
  // a real file (SPA fallback — Vite-built single-page app behaviour).
  const rel = relPath === "" || relPath === "/" ? "index.html" : relPath
  const full = safeJoin(distDir, rel)
  if (full === null) {
    return new Response("Not found", { status: 404 })
  }

  const file = Bun.file(full)
  if (await file.exists()) {
    return new Response(await file.bytes(), {
      status: 200,
      headers: { "content-type": contentTypeFor(full) },
    })
  }

  // SPA fallback for client-side routes under /settings/*.
  const indexPath = safeJoin(distDir, "index.html")
  if (indexPath) {
    const idx = Bun.file(indexPath)
    if (await idx.exists()) {
      return new Response(await idx.bytes(), {
        status: 200,
        headers: { "content-type": "text/html; charset=utf-8" },
      })
    }
  }
  return new Response("Not found", { status: 404 })
}

async function reverseProxyToVite(
  request: Request,
  upstreamPath: string,
): Promise<Response> {
  const url = new URL(request.url)
  const upstream = new URL(upstreamPath, `http://127.0.0.1:${SHELL_VITE_PORT}`)
  upstream.search = url.search

  // Strip hop-by-hop headers; pass through the rest so Vite's HMR /
  // accept negotiation works.
  const headers = new Headers(request.headers)
  headers.delete("host")
  headers.delete("connection")

  try {
    const upstreamRes = await fetch(upstream, {
      method: request.method,
      headers,
      body:
        request.method === "GET" || request.method === "HEAD" ?
          undefined
        : request.body,
      redirect: "manual",
    })
    return upstreamRes
  } catch {
    return new Response(
      `Settings dev server unreachable on :${SHELL_VITE_PORT}.\n\n`
        + `Start it with: cd shell && bun run dev\n`
        + `Or set NODE_ENV=production and ensure shell/dist exists.\n`,
      { status: 503, headers: { "content-type": "text/plain; charset=utf-8" } },
    )
  }
}

export const settingsRoutes = new Hono()

const isDev = process.env.NODE_ENV !== "production"

// Single shared handler — serves `/settings`, `/settings/`, and any
// asset under `/settings/<rest>`. Hono's `c.req.path` is the full mount
// path, so we slice off the mount prefix to recover the asset path.
async function handle(request: Request, routePath: string): Promise<Response> {
  // routePath is everything after `/settings`. Examples:
  //   GET /settings           → ""
  //   GET /settings/          → "/"
  //   GET /settings/assets/x  → "/assets/x"
  const relPath = routePath.replace(/^\//, "")

  if (isDev) {
    // Mirror the path back onto Vite under /settings/ so Vite's
    // base-aware asset resolution works without rewrites.
    const upstreamPath = relPath === "" ? "/settings/" : `/settings/${relPath}`
    return reverseProxyToVite(request, upstreamPath)
  }

  if (!SETTINGS_DIST_DIR) {
    return new Response(
      "Settings bundle not found. Run `cd shell && bun run build` "
        + "or set MAXIMAL_SETTINGS_DIST.\n",
      { status: 503, headers: { "content-type": "text/plain; charset=utf-8" } },
    )
  }

  return serveFromDist(SETTINGS_DIST_DIR, relPath)
}

settingsRoutes.all("/", (c) => handle(c.req.raw, ""))
settingsRoutes.all("/*", (c) => {
  // c.req.path is the full path (e.g. /settings/assets/index.js);
  // slice off the "/settings" prefix here.
  const after = c.req.path.replace(/^\/settings/, "")
  return handle(c.req.raw, after || "/")
})
