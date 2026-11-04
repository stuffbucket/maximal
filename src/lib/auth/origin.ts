/**
 * Browser `Origin` checks for the loopback surfaces (`/mcp/*`,
 * `/settings/api/*`).
 *
 * `cors()` lets any web page script the proxy, and with API-key enforcement
 * off nothing else stops a page the user happens to visit from reading or
 * writing local settings. A browser always labels such a request with its
 * page's `Origin`; CLIs, SDKs and the Tauri shell's own Rust calls send
 * none. So a request with no `Origin` is allowed, and one with an `Origin`
 * must be Maximal's own UI.
 */

import type { MiddlewareHandler } from "hono"

const LOOPBACK_HOSTNAMES = new Set(["127.0.0.1", "localhost", "[::1]"])

/** True when `origin` is present and names a non-loopback host (or isn't a
 *  parseable origin, such as the literal `null`). Any loopback port passes. */
export function hasForeignOrigin(origin: string | undefined): boolean {
  if (origin === undefined) return false
  try {
    return !LOOPBACK_HOSTNAMES.has(new URL(origin).hostname)
  } catch {
    return true
  }
}

/**
 * True when `origin` is this proxy's own web origin: `http://127.0.0.1:<port>`,
 * `http://localhost:<port>` or `http://[::1]:<port>` with the port the request
 * was addressed to (the `Host` header's). The Tauri webview loads the settings
 * UI from `http://localhost:<port>`, so its fetches arrive as that origin.
 * Another local web app on a different port, or a rebound hostname, is not.
 */
export function isTrustedOrigin(
  origin: string,
  host: string | undefined,
): boolean {
  let url: URL
  try {
    url = new URL(origin)
  } catch {
    return false
  }
  if (url.protocol !== "http:" || !LOOPBACK_HOSTNAMES.has(url.hostname)) {
    return false
  }
  if (host === undefined) return true
  try {
    return new URL(`http://${host}`).port === url.port
  } catch {
    return false
  }
}

/** Reject (403) requests a browser labelled with an untrusted `Origin`.
 *  Requests with no `Origin` pass. */
export const rejectUntrustedOrigin: MiddlewareHandler = async (c, next) => {
  const origin = c.req.header("origin")
  if (origin !== undefined && !isTrustedOrigin(origin, c.req.header("host"))) {
    return c.json(
      {
        error: {
          type: "forbidden",
          code: "ORIGIN_REJECTED",
          message: "Cross-origin requests are not allowed.",
        },
      },
      403,
    )
  }
  await next()
}
