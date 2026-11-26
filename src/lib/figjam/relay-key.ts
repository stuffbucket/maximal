import { timingSafeEqual } from "node:crypto"

/**
 * The FigJam relay key's names and checks, for the parent-owned routes.
 *
 * The key itself belongs to the owning Maximal process:
 * `initializeFigjamRelayKey()` (from `@stuffbucket/maximal-plugin-figjam`)
 * makes it once at the top of `runServer` and sets this environment variable;
 * plugin generations inherit it, and the bridge refuses a panel socket that
 * doesn't offer it. These routes only read and compare it. Only the
 * composition root may import plugin packages, so the two names are repeated
 * here; `tests/figjam-route.test.ts` pins that they agree.
 */

/** Carries the owning Maximal process's relay key to plugin generations. */
export const FIGJAM_RELAY_KEY_ENV = "MAXIMAL_FIGJAM_RELAY_KEY"

/** Header used by the panel's opaque-origin discovery request. */
export const FIGJAM_RELAY_KEY_HEADER = "x-maximal-figjam-relay-key"

/** A relay key: 32 random bytes as base64url (a valid WebSocket subprotocol). */
const RELAY_KEY = /^[\w-]{43}$/

/**
 * This process's relay key, or "" when there is none (a malformed value is
 * treated as none, so nothing can match it). Read on every request, so it
 * doesn't matter whether the routes were imported before or after startup
 * made the key.
 */
export function currentRelayKey(
  env: Readonly<Record<string, string | undefined>> = process.env,
): string {
  const value = env[FIGJAM_RELAY_KEY_ENV]
  return value !== undefined && RELAY_KEY.test(value) ? value : ""
}

/** Whether `presented` is exactly `expected`, in constant time; never when there is no key. */
export function relayKeyMatches(
  presented: string | undefined,
  expected: string,
): boolean {
  if (expected === "" || presented === undefined) return false
  const a = Buffer.from(presented)
  const b = Buffer.from(expected)
  return a.length === b.length && timingSafeEqual(a, b)
}
