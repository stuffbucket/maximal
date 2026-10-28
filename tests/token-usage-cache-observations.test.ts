import { describe, expect, test } from "bun:test"

import type { SessionRow } from "~/lib/token-usage/store"

import { CacheObservations } from "~/lib/token-usage/sessions"

import { build, CLAUDE, MINUTE, only, row, T } from "./helpers/session-rows"

describe("CacheObservations", () => {
  const HOUR = 3600
  const RESUME_GAP_MS = 40 * MINUTE

  function hit(observations: CacheObservations, key?: string): void {
    observations.record({
      model: CLAUDE,
      gapMs: RESUME_GAP_MS,
      requestedTtlS: HOUR,
      cacheReadTokens: 500,
      previousContextTokens: 600,
      key,
    })
  }

  function miss(observations: CacheObservations, key?: string): void {
    observations.record({
      model: CLAUDE,
      gapMs: RESUME_GAP_MS,
      requestedTtlS: HOUR,
      cacheReadTokens: 0,
      previousContextTokens: 600,
      key,
    })
  }

  function expectDowngraded(observations: CacheObservations, yes: boolean) {
    expect(observations.isDowngraded(CLAUDE, HOUR)).toBe(yes)
    expect(observations.effectiveTtlS(CLAUDE, HOUR)).toBe(yes ? 300 : HOUR)
  }

  test("a requested lifetime is 'requested' until seen; an unrequested one is estimated", () => {
    const observations = new CacheObservations()
    expect(observations.confidence(CLAUDE, HOUR, true)).toBe("requested")
    expect(observations.confidence("gpt-5", 300, false)).toBe("estimated")
    expectDowngraded(observations, false)
  })

  test("a resume inside the lifetime that reads the cache makes it observed", () => {
    const observations = new CacheObservations()
    hit(observations)
    expect(observations.confidence(CLAUDE, HOUR, true)).toBe("observed")
    expectDowngraded(observations, false)
    expect(observations.confidence("other-model", HOUR, true)).toBe("requested")
  })

  test("one miss leaves the lifetime alone", () => {
    const observations = new CacheObservations()
    miss(observations)
    expectDowngraded(observations, false)
    expect(observations.confidence(CLAUDE, HOUR, true)).toBe("requested")
  })

  test("two misses in a row drop the model to 5 minutes", () => {
    const observations = new CacheObservations()
    miss(observations)
    miss(observations)
    expectDowngraded(observations, true)
    expect(observations.confidence(CLAUDE, HOUR, true)).toBe("estimated")
    // A 5-minute or empty lifetime on that model is not contradicted.
    expect(observations.isDowngraded(CLAUDE, 300)).toBe(false)
    expect(observations.effectiveTtlS(CLAUDE, 300)).toBe(300)
    expect(observations.confidence(CLAUDE, 300, true)).toBe("requested")
    expect(observations.effectiveTtlS(CLAUDE, 0)).toBe(0)
    // Other models are unaffected.
    expect(observations.effectiveTtlS("other-model", HOUR)).toBe(HOUR)
  })

  test("reading less than half the previous context is a miss", () => {
    const observations = new CacheObservations()
    for (const cacheReadTokens of [299, 299]) {
      observations.record({
        model: CLAUDE,
        gapMs: RESUME_GAP_MS,
        requestedTtlS: HOUR,
        cacheReadTokens,
        previousContextTokens: 600,
      })
    }
    expectDowngraded(observations, true)
    expect(observations.confidence(CLAUDE, HOUR, true)).toBe("estimated")
  })

  test("reading half the previous context or more is a hit", () => {
    const observations = new CacheObservations()
    observations.record({
      model: CLAUDE,
      gapMs: RESUME_GAP_MS,
      requestedTtlS: HOUR,
      cacheReadTokens: 300,
      previousContextTokens: 600,
    })
    expect(observations.confidence(CLAUDE, HOUR, true)).toBe("observed")
  })

  test("a hit between two misses resets the count", () => {
    const observations = new CacheObservations()
    miss(observations)
    hit(observations)
    miss(observations)
    expectDowngraded(observations, false)
    expect(observations.confidence(CLAUDE, HOUR, true)).toBe("observed")
  })

  test("a hit after a downgrade restores the model", () => {
    const observations = new CacheObservations()
    miss(observations)
    miss(observations)
    expectDowngraded(observations, true)
    hit(observations)
    expectDowngraded(observations, false)
    expect(observations.confidence(CLAUDE, HOUR, true)).toBe("observed")
  })

  test("resumes at or under 5 minutes, or past the lifetime, prove nothing", () => {
    const observations = new CacheObservations()
    for (const gapMs of [300_000, HOUR * 1000 + 1, 300_000, HOUR * 1000 + 1]) {
      observations.record({
        model: CLAUDE,
        gapMs,
        requestedTtlS: HOUR,
        cacheReadTokens: 0,
        previousContextTokens: 600,
      })
    }
    observations.record({
      model: CLAUDE,
      gapMs: 300_000,
      requestedTtlS: HOUR,
      cacheReadTokens: 500,
      previousContextTokens: 600,
    })
    expectDowngraded(observations, false)
    expect(observations.confidence(CLAUDE, HOUR, true)).toBe("requested")
  })

  test("resumes exactly at the lifetime still count", () => {
    const observations = new CacheObservations()
    for (let i = 0; i < 2; i++) {
      observations.record({
        model: CLAUDE,
        gapMs: HOUR * 1000,
        requestedTtlS: HOUR,
        cacheReadTokens: 0,
        previousContextTokens: 600,
      })
    }
    expectDowngraded(observations, true)
  })

  test("the same pair recorded under one key counts once", () => {
    const observations = new CacheObservations()
    miss(observations, "1>2")
    miss(observations, "1>2")
    expectDowngraded(observations, false)
  })

  test("a key dropped by retainKeys counts again", () => {
    const observations = new CacheObservations()
    miss(observations, "1>2")
    observations.retainKeys(new Set(["1>2"]))
    miss(observations, "1>2")
    expectDowngraded(observations, false)
    observations.retainKeys(new Set())
    miss(observations, "1>2")
    expectDowngraded(observations, true)
  })
})

/** One session: a request at T, then a resume every 40 minutes reading
 *  the given cached tokens. */
function resumes(...cacheReads: Array<number>): Array<SessionRow> {
  return [
    row({ id: 100, created_at_ms: T, cache_ttl_s: 3600 }),
    ...cacheReads.map((cacheRead, i) =>
      row({
        id: 101 + i,
        created_at_ms: T + (i + 1) * 40 * MINUTE,
        cache_ttl_s: 3600,
        cache_read_input_tokens: cacheRead,
      }),
    ),
  ]
}

describe("observations fed while building", () => {
  const HOUR = 3600

  test("a resume that read the cache shows as observed", () => {
    const view = only(build(resumes(800), T + 41 * MINUTE))
    expect(view.cache.confidence).toBe("observed")
    expect(view.cache.ttl_s).toBe(HOUR)
    expect(view.cache.downgraded).toBe(false)
    expect(view.state).toBe("warm")
  })

  test("one resume that read nothing leaves the countdown alone", () => {
    const view = only(build(resumes(0), T + 41 * MINUTE))
    expect(view.cache.ttl_s).toBe(HOUR)
    expect(view.cache.downgraded).toBe(false)
    expect(view.cache.confidence).toBe("requested")
  })

  test("two resumes in a row that read nothing shorten the countdown to 5 minutes", () => {
    const rows = resumes(0, 0)
    const last = T + 80 * MINUTE
    const warm = only(build(rows, last + 299_999))
    expect(warm.cache.ttl_s).toBe(300)
    expect(warm.cache.expires_at_ms).toBe(last + 300_000)
    expect(warm.cache.confidence).toBe("estimated")
    expect(warm.cache.downgraded).toBe(true)
    expect(warm.cache.downgraded_from_s).toBe(HOUR)
    expect(warm.state).toBe("warm")
    expect(only(build(rows, last + 300_000)).state).toBe("cold")
  })

  test("a downgraded 24-hour lifetime says which lifetime didn't hold", () => {
    const DAY = 86_400
    const rows = [0, 1, 2].map((i) =>
      row({
        id: 300 + i,
        model: "gpt-5",
        created_at_ms: T + i * 40 * MINUTE,
        cache_ttl_s: DAY,
      }),
    )
    const view = only(build(rows, T + 81 * MINUTE))
    expect(view.cache.downgraded).toBe(true)
    expect(view.cache.downgraded_from_s).toBe(DAY)
    expect(view.cache.ttl_s).toBe(300)
  })

  test("a hit after a downgrade restores the countdown", () => {
    const view = only(build(resumes(0, 0, 800), T + 121 * MINUTE))
    expect(view.cache.ttl_s).toBe(HOUR)
    expect(view.cache.downgraded).toBe(false)
    expect(view.cache.downgraded_from_s).toBeNull()
    expect(view.cache.confidence).toBe("observed")
  })
})

describe("which requests count as a resume", () => {
  const HOUR = 3600
  const OTHER = "claude-haiku-4"

  test("misses are consecutive in time across sessions, not session by session", () => {
    // Session b starts first, so a session-by-session feed would see
    // b's hit, then a's two misses, and downgrade. In time order a hit
    // sits between the misses.
    const rows = [
      row({
        id: 1,
        session_id: "b",
        created_at_ms: T - 10 * MINUTE,
        cache_ttl_s: HOUR,
      }),
      row({ id: 2, session_id: "a", created_at_ms: T, cache_ttl_s: HOUR }),
      row({
        id: 3,
        session_id: "a",
        created_at_ms: T + 40 * MINUTE,
        cache_ttl_s: HOUR,
      }),
      row({
        id: 4,
        session_id: "b",
        created_at_ms: T + 45 * MINUTE,
        cache_ttl_s: HOUR,
        cache_read_input_tokens: 800,
      }),
      row({
        id: 5,
        session_id: "a",
        created_at_ms: T + 90 * MINUTE,
        cache_ttl_s: HOUR,
      }),
    ]
    const view = build(rows, T + 91 * MINUTE)
    for (const session of view.sessions) {
      expect(session.cache.downgraded).toBe(false)
      expect(session.cache.ttl_s).toBe(HOUR)
    }
  })

  test("gaps between different sessions are not resumes", () => {
    const rows = [
      row({ session_id: "a", created_at_ms: T, cache_ttl_s: HOUR }),
      row({
        session_id: "b",
        created_at_ms: T + 40 * MINUTE,
        cache_ttl_s: HOUR,
      }),
    ]
    const view = build(rows, T + 41 * MINUTE)
    expect(view.sessions.map((s) => s.cache.confidence)).toEqual([
      "requested",
      "requested",
    ])
  })

  test("a first request on another model in the session is not a resume", () => {
    // Subagents share their parent's session id on another model. Two
    // sessions each switch to OTHER after 40 minutes, reading nothing; paired
    // with the parent's model that would be two misses in a row.
    const rows = ["a", "b"].flatMap((session, i) => [
      row({
        id: 10 + i * 2,
        session_id: session,
        created_at_ms: T + i,
        cache_ttl_s: HOUR,
      }),
      row({
        id: 11 + i * 2,
        session_id: session,
        model: OTHER,
        created_at_ms: T + 40 * MINUTE + i,
        cache_ttl_s: HOUR,
        cache_read_input_tokens: 0,
      }),
    ])
    const observations = new CacheObservations()
    const view = build(rows, T + 41 * MINUTE, { observations })
    for (const session of view.sessions) {
      expect(session.model).toBe(OTHER)
      expect(session.cache.downgraded).toBe(false)
      expect(session.cache.ttl_s).toBe(HOUR)
      expect(session.cache.confidence).toBe("requested")
    }
    expect(observations.isDowngraded(OTHER, HOUR)).toBe(false)
  })

  test("a resume pairs with the last request on its own model, past other models", () => {
    const rows = [
      row({ created_at_ms: T, cache_ttl_s: HOUR }),
      row({ model: OTHER, created_at_ms: T + MINUTE, cache_ttl_s: HOUR }),
      row({
        created_at_ms: T + 40 * MINUTE,
        cache_ttl_s: HOUR,
        cache_read_input_tokens: 800,
      }),
    ]
    const view = only(build(rows, T + 41 * MINUTE))
    expect(view.model).toBe(CLAUDE)
    expect(view.cache.confidence).toBe("observed")
  })

  test("a request that starts inside the 5-minute cache and runs past it proves nothing", () => {
    // Idle 4 minutes, then a 90 s request: completion to completion is 5:30,
    // but the cache it read was only 4 minutes old when it started.
    const rows = [
      row({
        id: 200,
        created_at_ms: T,
        cache_ttl_s: HOUR,
        cache_read_input_tokens: 80_000,
      }),
      row({
        id: 201,
        request_started_at_ms: T + 4 * MINUTE,
        created_at_ms: T + 4 * MINUTE + 90_000,
        cache_ttl_s: HOUR,
        cache_read_input_tokens: 80_000,
      }),
    ]
    const view = only(build(rows, T + 6 * MINUTE))
    expect(view.cache.confidence).toBe("requested")
  })

  test("the gap runs from the previous completion to the resuming request's start", () => {
    const rows = [
      row({
        id: 210,
        created_at_ms: T,
        cache_ttl_s: HOUR,
        cache_read_input_tokens: 80_000,
      }),
      row({
        id: 211,
        request_started_at_ms: T + 6 * MINUTE,
        created_at_ms: T + 7 * MINUTE,
        cache_ttl_s: HOUR,
        cache_read_input_tokens: 80_000,
      }),
    ]
    const view = only(build(rows, T + 8 * MINUTE))
    expect(view.cache.confidence).toBe("observed")
  })

  test("a resume that reads only a shared prefix is a miss", () => {
    // The previous request ran with 100k of context; each resume reads back
    // only 5k (tools and system), so the session's own cache did not hold.
    const rows = [0, 1, 2].map((i) =>
      row({
        id: 220 + i,
        created_at_ms: T + i * 40 * MINUTE,
        cache_ttl_s: HOUR,
        input_tokens: 15_000,
        cache_read_input_tokens: i === 0 ? 85_000 : 5_000,
        cache_creation_input_tokens: i === 0 ? 0 : 80_000,
      }),
    )
    const view = only(build(rows, T + 81 * MINUTE))
    expect(view.cache.downgraded).toBe(true)
    expect(view.cache.ttl_s).toBe(300)
    expect(view.cache.confidence).toBe("estimated")
  })

  test("a request with no recorded start proves nothing either way", () => {
    const rows = [
      row({ id: 230, created_at_ms: T, cache_ttl_s: HOUR }),
      ...[1, 2].map((i) =>
        row({
          id: 230 + i,
          request_started_at_ms: null,
          created_at_ms: T + i * 40 * MINUTE,
          cache_ttl_s: HOUR,
        }),
      ),
    ]
    const view = only(build(rows, T + 81 * MINUTE))
    expect(view.cache.downgraded).toBe(false)
    expect(view.cache.confidence).toBe("requested")
  })

  test("one miss fed across three polls of the same rows counts once", () => {
    const observations = new CacheObservations()
    const rows = resumes(0)
    const now = T + 41 * MINUTE
    const first = build(rows, now, { observations })
    const second = build(rows, now, { observations })
    const third = build(rows, now, { observations })
    expect(observations.isDowngraded(CLAUDE, HOUR)).toBe(false)
    expect(third.sessions[0].cache.downgraded).toBe(false)
    expect(second).toEqual(first)
    expect(third).toEqual(first)
  })
})
