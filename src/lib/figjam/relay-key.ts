import { randomBytes } from "node:crypto"

/** Private capability shared only with the staged FigJam panel for this run. */
export const FIGJAM_RELAY_KEY_ENV = "MAXIMAL_FIGJAM_RELAY_KEY"

/** Header used by the panel's opaque-origin discovery request. */
export const FIGJAM_RELAY_KEY_HEADER = "x-maximal-figjam-relay-key"

/**
 * Replace any inherited value with a fresh per-process relay capability.
 * `runServer` calls this before importing the routes or starting plugins.
 */
export function initializeFigjamRelayKey(
  env: Record<string, string | undefined> = process.env,
): string {
  const key = randomBytes(32).toString("base64url")
  env[FIGJAM_RELAY_KEY_ENV] = key
  return key
}
