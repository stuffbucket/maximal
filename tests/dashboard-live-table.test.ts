import { describe, expect, test } from "bun:test"

import type { SessionView } from "../src/lib/token-usage/sessions-schema"

import {
  formatCountdown,
  liveSessions,
  sortSessions,
} from "../shell/src/dashboard/live/rows"

const NOW = 1_800_000_000_000

/** A session with `rate` tokens/min, last active at `last`, its cache
 *  running out at `expires`. */
function session(
  id: string,
  state: SessionView["state"],
  {
    rate,
    last,
    expires = null,
  }: { rate: number; last: number; expires?: number | null },
): SessionView {
  return {
    id,
    client: "claude-code",
    client_label: null,
    model: "claude-sonnet-4-5",
    started_at_ms: NOW - 3_600_000,
    last_request_at_ms: last,
    state,
    rate_per_min: rate,
    minutes: [],
    total_tokens: 0,
    request_count: 1,
    cache: {
      ttl_s: 300,
      expires_at_ms: expires,
      confidence: "requested",
      downgraded: false,
      last_cache_read_tokens: 0,
    },
    context: {
      used_tokens: 0,
      window_tokens: null,
      ceiling_tokens: null,
      compact_at_tokens: null,
      window_source: "models-endpoint",
      compacted_at_ms: null,
    },
  }
}

const ids = (sessions: Array<SessionView>): Array<string> =>
  sessions.map((s) => s.id)

describe("sortSessions", () => {
  test("streaming and warm sit above the line by rate, cold below by recency", () => {
    const { above, below } = sortSessions([
      session("cold-old", "cold", { rate: 900, last: NOW - 40 * 60_000 }),
      session("warm-slow", "warm", { rate: 100, last: NOW - 60_000 }),
      session("streaming", "streaming", { rate: 5_000, last: NOW - 1_000 }),
      session("cold-new", "cold", { rate: 0, last: NOW - 10 * 60_000 }),
      session("warm-fast", "warm", { rate: 2_000, last: NOW - 120_000 }),
    ])
    expect(ids(above)).toEqual(["streaming", "warm-fast", "warm-slow"])
    expect(ids(below)).toEqual(["cold-new", "cold-old"])
  })

  test("equal rates fall back to the latest activity first", () => {
    const { above } = sortSessions([
      session("older", "warm", { rate: 300, last: NOW - 90_000 }),
      session("newer", "warm", { rate: 300, last: NOW - 10_000 }),
    ])
    expect(ids(above)).toEqual(["newer", "older"])
  })

  test("Other requests rows sort by rate like any session", () => {
    const { above, below } = sortSessions([
      session("a", "warm", { rate: 200, last: NOW - 10_000 }),
      session("other:claude-desktop", "warm", {
        rate: 800,
        last: NOW - 50_000,
      }),
      session("other:codex", "cold", { rate: 0, last: NOW - 5 * 60_000 }),
      session("b", "cold", { rate: 0, last: NOW - 20 * 60_000 }),
    ])
    expect(ids(above)).toEqual(["other:claude-desktop", "a"])
    expect(ids(below)).toEqual(["other:codex", "b"])
  })
})

describe("liveSessions", () => {
  test("a warm session whose cache runs out moves to cold on the client", () => {
    const view = {
      flow_per_min: 0,
      sessions: [
        session("expired", "warm", {
          rate: 100,
          last: NOW - 300_000,
          expires: NOW - 1,
        }),
        session("at-edge", "warm", {
          rate: 100,
          last: NOW - 300_000,
          expires: NOW,
        }),
        session("still-warm", "warm", {
          rate: 100,
          last: NOW - 200_000,
          expires: NOW + 1,
        }),
        session("streaming", "streaming", {
          rate: 100,
          last: NOW - 400_000,
          expires: NOW - 5_000,
        }),
      ],
    }
    const states = Object.fromEntries(
      liveSessions(view, NOW).sessions.map((s) => [s.id, s.state]),
    )
    expect(states).toEqual({
      expired: "cold",
      "at-edge": "cold",
      "still-warm": "warm",
      streaming: "streaming",
    })
  })

  test("returns the same view when nothing changed", () => {
    const view = {
      flow_per_min: 0,
      sessions: [
        session("w", "warm", { rate: 1, last: NOW, expires: NOW + 60_000 }),
      ],
    }
    expect(liveSessions(view, NOW)).toBe(view)
  })
})

describe("formatCountdown", () => {
  test("a requested lifetime under 10 minutes reads as about m:ss", () => {
    expect(formatCountdown(192_000, "requested", "en")).toBe("about 3:12")
  })

  test("an observed lifetime of 10 minutes or more reads in whole minutes", () => {
    expect(formatCountdown(2_880_000, "observed", "en")).toBe("48 min")
  })

  test("an estimated lifetime says about too", () => {
    expect(formatCountdown(2_880_000, "estimated", "en")).toBe("about 48 min")
  })

  test("seconds round up, so the last second reads 0:01, never 0:00", () => {
    expect(formatCountdown(400, "observed", "en")).toBe("0:01")
    expect(formatCountdown(5_000, "observed", "en")).toBe("0:05")
  })

  test("switches to minutes at 10 minutes", () => {
    expect(formatCountdown(599_000, "observed", "en")).toBe("9:59")
    expect(formatCountdown(600_000, "observed", "en")).toBe("10 min")
  })
})
