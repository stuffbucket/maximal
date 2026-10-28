import { describe, expect, test } from "bun:test"

import type { SessionView } from "../src/lib/token-usage/sessions-schema"

import {
  COLD_ROWS,
  clockFormatter,
  coldRows,
  contextMeter,
  downgradedText,
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
      downgraded_from_s: null,
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

  test("just under 10 minutes rounds up to 10 min, never 10:00", () => {
    expect(formatCountdown(599_500, "observed", "en")).toBe("10 min")
    expect(formatCountdown(599_001, "requested", "en")).toBe("about 10 min")
  })
})

describe("formatCountdown in hours", () => {
  test("an hour or more reads in hours", () => {
    expect(formatCountdown(3_600_000, "observed", "en")).toBe("1 hr")
    expect(formatCountdown(86_280_000, "requested", "en")).toBe("about 24 hr")
  })

  test("just under an hour still reads in hours once it rounds up to 60 min", () => {
    expect(formatCountdown(3_599_000, "observed", "en")).toBe("1 hr")
    expect(formatCountdown(3_540_000, "observed", "en")).toBe("59 min")
  })

  test("the hours follow the locale", () => {
    expect(formatCountdown(86_280_000, "observed", "de")).toBe("24 Std.")
  })
})

describe("clockFormatter", () => {
  // Local times, so the test holds in any time zone.
  const now = new Date(2026, 9, 28, 15, 0).getTime()

  test("a time today reads as the time alone", () => {
    const at = new Date(2026, 9, 28, 10, 42).getTime()
    expect(clockFormatter("en")(at, now)).toBe("10:42 AM")
  })

  test("a time on another day adds a short day", () => {
    const at = new Date(2026, 9, 27, 10, 42).getTime()
    // ICU versions punctuate the day differently ("Di. 10:42" on macOS,
    // "Di., 10:42" on Linux), so check the parts, not the exact string.
    const en = clockFormatter("en")(at, now)
    expect(en).toContain("Tue")
    expect(en).toContain("10:42")
    const de = clockFormatter("de")(at, now)
    expect(de).toContain("Di")
    expect(de).toContain("10:42")
  })
})

describe("downgradedText", () => {
  test("names the lifetime that didn't hold", () => {
    expect(downgradedText(3600, "en")).toBe(
      "Cache didn't last 1 hour; using 5 min",
    )
    expect(downgradedText(86_400, "en")).toBe(
      "Cache didn't last 24 hours; using 5 min",
    )
  })
})

/** A session's context: a 200,000 window that is also the ceiling. */
function context(
  overrides: Partial<SessionView["context"]>,
): SessionView["context"] {
  return {
    used_tokens: 0,
    window_tokens: 200_000,
    ceiling_tokens: 200_000,
    compact_at_tokens: null,
    window_source: "models-endpoint",
    compacted_at_ms: null,
    ...overrides,
  }
}

describe("contextMeter", () => {
  test("a window no larger than the ceiling fills against the window, unmarked", () => {
    const meter = contextMeter(context({ used_tokens: 150_000 }), "en")
    expect(meter).toEqual({
      percent: 75,
      level: "low",
      fill: 75,
      compactAt: null,
      title: "150,000 of 200,000 (the size Maximal lists for this model)",
    })
    expect(meter?.title).toBe(
      "150,000 of 200,000 (the size Maximal lists for this model)",
    )
  })

  test("a lower ceiling is the track: the fill is the percent, and the tooltip names both", () => {
    const meter = contextMeter(
      context({
        used_tokens: 119_000,
        window_tokens: 272_000,
        ceiling_tokens: 128_000,
        compact_at_tokens: 115_200,
        window_source: "codex-catalog",
      }),
      "en",
    )
    expect(meter?.level).toBe("out")
    expect(meter?.percent).toBeCloseTo((119_000 / 128_000) * 100, 5)
    expect(meter?.fill).toBe(meter?.percent)
    expect(meter?.compactAt).toBeCloseTo((115_200 / 128_000) * 100, 5)
    expect(meter).not.toHaveProperty("ceilingAt")
    expect(meter?.title).toBe(
      "119,000 of 128,000, Copilot's limit (272,000 is the size Codex uses for this model)\nCompacts at 115,200",
    )
  })

  test("the 1M window Claude Code asked for is not credited with the ceiling", () => {
    const meter = contextMeter(
      context({
        used_tokens: 84_000,
        window_tokens: 1_000_000,
        ceiling_tokens: 168_000,
        window_source: "claude-1m",
      }),
      "en",
    )
    expect(meter?.percent).toBe(50)
    expect(meter?.title).toBe(
      "84,000 of 168,000, Copilot's limit (1,000,000 is the 1M window Claude Code asked for)",
    )
  })

  test("a compaction point at or past the limit gets no tick or line", () => {
    const meter = contextMeter(
      context({
        used_tokens: 10_000,
        window_tokens: 272_000,
        ceiling_tokens: 128_000,
        compact_at_tokens: 244_800,
        window_source: "codex-catalog",
      }),
      "en",
    )
    expect(meter?.compactAt).toBeNull()
    expect(meter?.title).not.toContain("Compacts")
  })

  test("a fill past the limit stays within the track", () => {
    const meter = contextMeter(context({ used_tokens: 260_000 }), "en")
    expect(meter?.percent).toBe(130)
    expect(meter?.fill).toBe(100)
  })

  test("no window and no ceiling: no meter", () => {
    expect(
      contextMeter(
        context({ window_tokens: null, ceiling_tokens: null }),
        "en",
      ),
    ).toBeNull()
  })
})

describe("coldRows", () => {
  const cold = Array.from({ length: COLD_ROWS + 5 }, (_, i) =>
    session(`c${i}`, "cold", { rate: 0, last: NOW - i * 60_000 }),
  )

  test("shows the first rows and counts the rest", () => {
    const { shown, hidden } = coldRows(cold, false)
    expect(COLD_ROWS).toBe(20)
    expect(ids(shown)).toEqual(ids(cold.slice(0, 20)))
    expect(hidden).toBe(5)
  })

  test("shows them all once expanded, or when they fit", () => {
    expect(coldRows(cold, true)).toEqual({ shown: cold, hidden: 0 })
    expect(coldRows(cold.slice(0, 20), false).hidden).toBe(0)
  })
})
