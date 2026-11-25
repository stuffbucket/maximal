/**
 * Presence: whether the person is at the machine, as the menu-bar shell last
 * reported it (screen locked or not, seconds since the last input).
 *
 * Local only and in memory: nothing is written to disk, logged or sent
 * anywhere. Consumers (budget limits that apply only while away) call
 * `currentPresence()`.
 *
 * A report older than `PRESENCE_STALE_MS`, or none at all (no shell, the CLI,
 * a platform that can't tell), reads as unknown: `locked` and `idleSeconds`
 * are null and `stale` is true. Treat unknown as NOT away.
 *
 * Staleness runs on the time the sidecar received the report, not the
 * report's own `at`, so a skewed shell clock can't keep a dead report alive.
 */

import type {
  PresenceReport,
  PresenceStatus,
} from "~/lib/config/settings-types"

import { settingsEventBus } from "~/lib/config/settings-events"

/** A report is stale after this long without an update. The shell reports
 *  every 5 s, so this tolerates several missed ones. */
export const PRESENCE_STALE_MS = 30_000

interface Latest {
  locked: boolean | null
  idleSeconds: number | null
  receivedAt: number
}

let latest: Latest | null = null

/** The latest report, or unknown when it is stale or there is none. */
export function currentPresence(now: number = Date.now()): PresenceStatus {
  if (!latest || now - latest.receivedAt > PRESENCE_STALE_MS) {
    return { locked: null, idleSeconds: null, stale: true }
  }
  return {
    locked: latest.locked,
    idleSeconds: latest.idleSeconds,
    stale: false,
  }
}

/**
 * Keep a report from the shell. Publishes `presence.changed` only when the
 * lock state a consumer would see changes (including unknown to known after
 * a stale gap), never for idle time alone. Returns the status now in effect.
 */
export function recordPresence(
  report: PresenceReport,
  now: number = Date.now(),
): PresenceStatus {
  const before = currentPresence(now)
  latest = {
    locked: report.locked,
    idleSeconds: report.idleSeconds,
    receivedAt: now,
  }
  const after = currentPresence(now)
  if (before.locked !== after.locked) {
    settingsEventBus.publish("presence.changed", after)
  }
  return after
}

/** Forget the latest report. Tests only. */
export function __resetPresenceForTests(): void {
  latest = null
}
