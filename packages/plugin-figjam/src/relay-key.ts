/**
 * The FigJam relay key's lifetime: one owning Maximal process.
 *
 * Plugin generations run in child processes that inherit the parent's
 * environment, and a generation is replaced whenever the plugin inventory or
 * any plugin's settings change. A key made inside a generation would rotate
 * on every such reload and strand the panels already written. So the parent
 * (`runServer`) makes the key once, before any generation spawns, and every
 * generation reads it from the environment. A plugin started without that
 * parent (tests, a host that doesn't call `initializeFigjamRelayKey`) falls
 * back to a key of its own.
 */
import { createRelayKey } from "@stuffbucket/maximal-figjam-bridge/server"

/** Carries the owning Maximal process's relay key to plugin generations. */
export const FIGJAM_RELAY_KEY_ENV = "MAXIMAL_FIGJAM_RELAY_KEY"

/** A relay key: 32 random bytes as base64url. */
const RELAY_KEY = /^[\w-]{43}$/

/**
 * Replace any inherited value with a fresh key for this process. The owning
 * Maximal process calls this before it spawns plugin generations, so a value
 * left in the environment by whatever started Maximal is never trusted.
 */
export function initializeFigjamRelayKey(
  env: Record<string, string | undefined> = process.env,
): string {
  const key = createRelayKey()
  env[FIGJAM_RELAY_KEY_ENV] = key
  return key
}

/**
 * The key a plugin generation uses: the owning process's (inherited through
 * the environment) when it is well formed, otherwise a new one.
 */
export function generationRelayKey(
  env: Readonly<Record<string, string | undefined>> = process.env,
): string {
  const inherited = env[FIGJAM_RELAY_KEY_ENV]
  return inherited !== undefined && RELAY_KEY.test(inherited) ?
      inherited
    : createRelayKey()
}
