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
 * Integration point (not done here): mount the Origin guard + narrowed cors on the
 * app in `server.ts` BEFORE the sub-app routes. Kept out of the live app in this
 * scaffold so the 130 existing `~/server` tests stay green.
 */
import type { MiddlewareHandler } from "hono"

import { notImplemented } from "~/lib/dev/not-implemented"

/**
 * Prefixes that mutate or expose control state and therefore need the Origin gate.
 * `/_internal/*` (incl. `/_internal/shutdown`) and read-only `/_debug/state` are in
 * scope too — the shutdown route is the same hole class (§6.1).
 */
export const CSRF_GUARDED_PREFIXES = [
  "/settings/api",
  "/_internal",
  "/_debug/state",
] as const

/**
 * Prefix that `createAuthMiddleware` must ALWAYS enforce, independent of the
 * user-facing `enforce` toggle (§6.2). Exported so the auth-middleware config and
 * its tests reference one constant, not a string literal in two places.
 */
export const MANDATORY_AUTH_PREFIX = "/settings/api"

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
  return notImplemented("isAllowedOrigin", { origin, boundPort })
}

/** True if `path` falls under any guarded prefix (drives where the gate applies). */
export function isCsrfGuardedPath(path: string): boolean {
  return notImplemented("isCsrfGuardedPath", { path })
}

export interface OriginGuardOptions {
  /** The sidecar's discovered bound port (NOT a literal 4141 — §1.1). */
  readonly boundPort: () => number
}

/** 403s a present, non-localhost `Origin`/`Referer` on any guarded path. */
export function createOriginGuardMiddleware(
  options: OriginGuardOptions,
): MiddlewareHandler {
  // NOTE: the implementation will be `async` (it awaits `next()`); the stub is
  // sync because it only throws. Restore `async` when filling in the body.
  return (c, next) => {
    // TODO(single-window §6.1): if isCsrfGuardedPath(path) and Origin present and
    // !isAllowedOrigin(origin, boundPort()) → 403; else next().
    return notImplemented("originGuardMiddleware", {
      options,
      path: c.req.path,
      next,
    })
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
  return notImplemented("buildCorsOptions", { boundPort })
}
