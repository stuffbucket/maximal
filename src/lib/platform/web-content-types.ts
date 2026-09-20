/**
 * Single source of truth for static-asset Content-Types, shared by the
 * `/ui/*` route (src/routes/ui/route.ts, disk-mode serving) and the embed
 * generator (scripts/gen-ui-embed.ts, which stamps the type onto each
 * embedded asset). Keeping one map prevents the two from drifting.
 */
const CONTENT_TYPES: Record<string, string | undefined> = {
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

/** Content-Type for a file path/name, by extension. Falls back to octet-stream. */
export function contentTypeForPath(path: string): string {
  const lower = path.toLowerCase()
  const dot = lower.lastIndexOf(".")
  return (
    (dot === -1 ? undefined : CONTENT_TYPES[lower.slice(dot)])
    ?? "application/octet-stream"
  )
}
