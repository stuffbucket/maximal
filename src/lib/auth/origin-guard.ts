/**
 * Control-surface hardening (spec §6, ADR-0021).
 *
 * The `/settings/api/*` surface is CSRF-exposed today: auth is off by default,
 * there is no Origin check, `cors()` is `*`, and loopback gating is source-IP
 * only (a malicious page driving the user's local browser originates from
 * 127.0.0.1 and passes it). Browser-tab delivery makes a real origin, so this
 * ships with the redesign — but it is a live hole regardless.
 *
 * This module owns the CSRF/Origin concerns that are genuinely NEW (absent from
 * `request-auth.ts`):
 *   - `createOriginGuardMiddleware` — reject any request whose `Origin` is
 *     present and not localhost. `Origin` is a Forbidden header (page JS cannot
 *     forge it), so this blocks all browser-driven cross-origin calls. A MISSING
 *     Origin passes — that is the CLI/plugin invariant (§6.6): Claude Code,
 *     opencode, and SDK clients send no Origin and must stay reachable.
 *   - `buildCorsOptions` — narrow the global `cors()` from `*` to a localhost
 *     allowlist (the OPTIONS preflight is the load-bearing case — auth bypasses it).
 *
 * The OTHER §6 requirement — mandatory auth on `/settings/api/*` decoupled from
 * `enforce` (§6.2) — is deliberately NOT a new gate here. It must be delivered as
 * a mode of the EXISTING `createAuthMiddleware` (`request-auth.ts`), which already
 * lists `/settings/api` in `requireAuthPrefixes` and already models the
 * `state.shellApiKey` bypass (so "Block unknown connections" can't lock the
 * Settings UI out of itself) plus per-request client attribution. A parallel
 * `hasValidKey` predicate would silently drop that bypass + attribution — on the
 * very surface §6 is hardening. Implement §6.2 by adding an "always-enforce on
 * these prefixes" option to `createAuthMiddleware` (or a second instance scoped to
 * `MANDATORY_AUTH_PREFIX` with `isEnforcing: () => true`), so there is ONE auth
 * decision, not two.
 *
 * Integration point: the Origin guard + narrowed cors are mounted on the app in
 * `server.ts` before the sub-app routes; `MANDATORY_AUTH_PREFIX` is wired into
 * `createAuthMiddleware`'s `alwaysEnforcePrefixes`.
 */
import type { MiddlewareHandler } from "hono"

/**
 * Prefixes that mutate or expose control state and therefore need the Origin gate.
 * `/_internal/*` (incl. `/_internal/shutdown`) and read-only `/_debug/state` are in
 * scope too — the shutdown route is the same hole class (§6.1). `/ws` (the live
 * feed) is here because its snapshot exposes auth/accounts state and WebSockets
 * bypass CORS — but the handshake is an HTTP GET carrying `Origin`, so gating it
 * here 403s a cross-origin browser WS while a same-origin tab / no-Origin CLI pass.
 * `/ws` MUST equal `WS_PATH` in `routes/ws/route.ts` (drift-guarded in the tests).
 */
export const CSRF_GUARDED_PREFIXES = [
  "/settings/api",
  "/_internal",
  "/_debug/state",
  "/ws",
] as const

/**
 * Prefix that `createAuthMiddleware` must ALWAYS enforce, independent of the
 * user-facing `enforce` toggle (§6.2). Exported so the auth-middleware config and
 * its tests reference one constant, not a string literal in two places.
 */
export const MANDATORY_AUTH_PREFIX = "/settings/api"

/** Loopback hostnames a browser may report in an `Origin` for the local UI. */
const LOCALHOST_HOSTNAMES = new Set([
  "localhost",
  "127.0.0.1",
  "[::1]", // URL.hostname brackets IPv6 literals
])

function pathMatchesPrefix(path: string, prefix: string): boolean {
  return path === prefix || path.startsWith(prefix + "/")
}

/**
 * True if the request may proceed past the Origin gate.
 * - `origin === null` (no header) → true  — non-browser CLI callers (§6.6).
 * - `http://localhost:<port>` / `http://127.0.0.1:<port>` → true.
 * - anything else → false.
 *
 * Pure; the unit + mutation-test anchor for the gate.
 */
export function isAllowedOrigin(
  origin: string | null,
  boundPort: number,
): boolean {
  // No Origin header at all: the CLI/plugin/SDK invariant (§6.6). `Origin` is a
  // Forbidden header, so page JS can never suppress it — a missing one means a
  // non-browser caller, which we let through.
  if (origin === null) return true
  let url: URL
  try {
    url = new URL(origin)
  } catch {
    // Unparseable / opaque origin (e.g. the literal "null" a sandboxed iframe
    // sends) — treat as hostile.
    return false
  }
  if (!LOCALHOST_HOSTNAMES.has(url.hostname)) return false
  // A localhost UI is always served on an explicit port, so require an exact
  // match against the bound port — not a blanket "any localhost" allow (which
  // would let a page on another local port drive the control surface).
  return url.port === String(boundPort)
}

/** True if `path` falls under any guarded prefix (drives where the gate applies). */
export function isCsrfGuardedPath(path: string): boolean {
  return CSRF_GUARDED_PREFIXES.some((prefix) => pathMatchesPrefix(path, prefix))
}

export interface OriginGuardOptions {
  /** The sidecar's discovered bound port (NOT a literal 4141 — §1.1). */
  readonly boundPort: () => number
}

/** 403s a present, non-localhost `Origin` on any guarded path. */
export function createOriginGuardMiddleware(
  options: OriginGuardOptions,
): MiddlewareHandler {
  return async (c, next) => {
    if (
      isCsrfGuardedPath(c.req.path)
      && !isAllowedOrigin(c.req.header("origin") ?? null, options.boundPort())
    ) {
      return c.json(
        {
          error: {
            message: "Forbidden: cross-origin request to a control endpoint",
            type: "csrf_error",
          },
        },
        403,
      )
    }
    return next()
  }
}

/**
 * Tighten the global `cors()` from `*` to an explicit localhost allowlist. The
 * OPTIONS preflight is the load-bearing case (auth bypasses it). Returns the
 * option object for `hono/cors`'s `cors(...)`.
 */
export function buildCorsOptions(boundPort: () => number): {
  origin: (origin: string) => string | null
} {
  // hono/cors calls this with the request's `Origin`; echo it back (allow) only
  // for a localhost origin on the bound port, else return null (no
  // Access-Control-Allow-Origin header → the browser blocks the cross-origin read).
  return {
    origin: (origin: string) =>
      origin && isAllowedOrigin(origin, boundPort()) ? origin : null,
  }
}
