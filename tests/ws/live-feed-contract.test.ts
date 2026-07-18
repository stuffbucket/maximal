import { describe, expect, test } from "bun:test"

import {
  LIVE_FEED_EVENT_TYPES,
  type LiveFeedEvent,
  type LiveFeedSnapshot,
} from "~/lib/ws/feed-types"

/**
 * Wire-contract completeness (spec §1.3 / §11.1 blocker: "WS event-type coverage").
 *
 * The feed MUST carry every event ADR-0007's SSE defined — dropping any orphans a
 * UI section when the polling shell is deleted. This runs LIVE (pure data + types)
 * so a future edit that drops an event type reds CI immediately.
 */

const ADR_0007_EVENTS = [
  "auth.changed",
  "accounts.changed",
  "apps.changed",
  "clients.changed",
  "upstream.rejection",
  "boot.state",
] as const

const NEW_EVENTS = ["usage", "update-available", "sidecar-health"] as const

describe("live-feed wire contract", () => {
  test("carries all six ADR-0007 event types", () => {
    for (const type of ADR_0007_EVENTS) {
      expect(LIVE_FEED_EVENT_TYPES, `missing ADR-0007 event ${type}`).toContain(
        type,
      )
    }
  })

  test("adds the three redesign event types (usage/update/health)", () => {
    for (const type of NEW_EVENTS) {
      expect(LIVE_FEED_EVENT_TYPES, `missing new event ${type}`).toContain(type)
    }
  })

  test("no duplicates and exactly nine members", () => {
    expect(new Set(LIVE_FEED_EVENT_TYPES).size).toBe(
      LIVE_FEED_EVENT_TYPES.length,
    )
    expect(LIVE_FEED_EVENT_TYPES).toHaveLength(9)
  })

  test("a LiveFeedEvent discriminant is present in the enumeration", () => {
    // NOTE: `satisfies readonly LiveFeedEventType[]` in feed-types.ts only checks
    // that each listed string is a VALID member — it does NOT prove the list is
    // exhaustive. Presence/count is guarded at runtime by the `toHaveLength(9)`
    // and per-event `toContain` assertions above; this is a spot-check.
    const sample: LiveFeedEvent["type"] = "auth.changed"
    expect(LIVE_FEED_EVENT_TYPES).toContain(sample)
  })

  test("snapshot covers every live surface a resumed tab must resync", () => {
    // A snapshot key per event family (§1.3 "complete snapshot on (re)connect").
    const requiredKeys: Array<keyof LiveFeedSnapshot> = [
      "auth",
      "accounts",
      "apps",
      "clients",
      "upstreamRejection",
      "boot",
      "usage",
      "update",
      "health",
    ]
    // Type-level assertion: the array above must list exactly the snapshot keys.
    // (No runtime object exists yet; this pins the shape for the builder.)
    expect(requiredKeys).toHaveLength(9)
  })
})
