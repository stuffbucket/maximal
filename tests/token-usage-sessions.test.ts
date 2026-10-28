import { describe, expect, test } from "bun:test"

import type { InFlight } from "~/lib/token-usage/in-flight"
import type { SessionRow } from "~/lib/token-usage/store"

import {
  buildSessionsView,
  CacheObservations,
} from "~/lib/token-usage/sessions"
import { SessionsResponse } from "~/lib/token-usage/sessions-schema"

/** A minute-aligned instant, so bucket arithmetic in the tests is exact. */
const T = 1_800_000_000_000
const MINUTE = 60_000
const CLAUDE = "claude-sonnet-4"

let nextId = 1

function row(overrides: Partial<SessionRow> = {}): SessionRow {
  return {
    id: nextId++,
    session_id: "s1",
    client: "claude-code",
    client_label: null,
    model: CLAUDE,
    created_at_ms: T,
    input_tokens: 0,
    output_tokens: 0,
    cache_read_input_tokens: 0,
    cache_creation_input_tokens: 0,
    total_tokens: 0,
    cache_ttl_s: 300,
    cache_ttl_requested: 1,
    is_compact: 0,
    context_window_tokens: 200_000,
    context_ceiling_tokens: 128_000,
    compact_at_tokens: null,
    window_source: "models-endpoint",
    ...overrides,
  }
}

function inFlight(overrides: Partial<InFlight> = {}): InFlight {
  return {
    traceId: "trace",
    sessionId: "s1",
    client: "claude-code",
    model: CLAUDE,
    startedAtMs: T,
    streamedBytes: 0,
    ...overrides,
  }
}

function build(
  rows: Array<SessionRow>,
  nowMs: number,
  options: {
    inFlight?: Array<InFlight>
    observations?: CacheObservations
  } = {},
) {
  return buildSessionsView({
    rows,
    inFlight: options.inFlight ?? [],
    nowMs,
    observations: options.observations ?? new CacheObservations(),
  })
}

function only(view: SessionsResponse) {
  expect(view.sessions).toHaveLength(1)
  return view.sessions[0]
}

describe("session state", () => {
  test("is warm until the last millisecond of the cache lifetime, then cold", () => {
    const rows = [row({ created_at_ms: T, cache_ttl_s: 300 })]

    const warm = only(build(rows, T + 299_999))
    expect(warm.state).toBe("warm")
    expect(warm.cache.ttl_s).toBe(300)
    expect(warm.cache.expires_at_ms).toBe(T + 300_000)

    const cold = only(build(rows, T + 300_000))
    expect(cold.state).toBe("cold")
    expect(cold.cache.expires_at_ms).toBe(T + 300_000)
  })

  test("a session with nothing cached is cold at once and never expires", () => {
    const view = only(
      build([row({ cache_ttl_s: 0, cache_ttl_requested: 0 })], T + 1),
    )
    expect(view.state).toBe("cold")
    expect(view.cache.ttl_s).toBe(0)
    expect(view.cache.expires_at_ms).toBeNull()
  })

  test("a response in flight makes the session streaming, even when cold", () => {
    const rows = [row({ cache_ttl_s: 0 })]
    const view = only(
      build(rows, T + 10 * MINUTE, {
        inFlight: [inFlight({ sessionId: "s1" })],
      }),
    )
    expect(view.state).toBe("streaming")
  })

  test("a response in flight with no session id marks no session streaming", () => {
    const rows = [
      row({ session_id: "", client: "codex", cache_ttl_s: 0 }),
      row({ session_id: "s2", cache_ttl_s: 0 }),
    ]
    const view = build(rows, T + MINUTE, {
      inFlight: [inFlight({ sessionId: "", client: "codex" })],
    })
    expect(view.sessions.map((s) => s.state)).toEqual(["cold", "cold"])
  })
})

describe("grouping", () => {
  test("requests with no session id fold into one row per client", () => {
    const rows = [
      row({
        session_id: "",
        client: "codex",
        total_tokens: 10,
        model: "gpt-5",
      }),
      row({ session_id: "s1", total_tokens: 1 }),
      row({
        session_id: "",
        client: "codex",
        total_tokens: 15,
        model: "gpt-5-mini",
        created_at_ms: T + 1000,
      }),
      row({ session_id: "", client: "claude-code", total_tokens: 7 }),
    ]
    const view = build(rows, T + 2000)
    const codex = view.sessions.find((s) => s.id === "other:codex")
    expect(codex).toBeDefined()
    expect(codex?.client).toBe("codex")
    expect(codex?.request_count).toBe(2)
    expect(codex?.total_tokens).toBe(25)
    expect(codex?.model).toBe("gpt-5-mini")
    expect(codex?.started_at_ms).toBe(T)
    expect(codex?.last_request_at_ms).toBe(T + 1000)
    expect(view.sessions.map((s) => s.id).sort()).toEqual([
      "other:claude-code",
      "other:codex",
      "s1",
    ])
  })

  test("sessions come out in order of last activity, newest first", () => {
    const rows = [
      row({ session_id: "a", created_at_ms: T }),
      row({ session_id: "b", created_at_ms: T + 1000 }),
      row({ session_id: "c", created_at_ms: T + 2000 }),
      row({ session_id: "a", created_at_ms: T + 3000 }),
    ]
    const view = build(rows, T + 4000)
    expect(view.sessions.map((s) => s.id)).toEqual(["a", "c", "b"])
  })

  test("the latest request supplies model, client label, cache and context", () => {
    const rows = [
      row({
        model: "old-model",
        client_label: "old",
        cache_ttl_s: 3600,
        cache_read_input_tokens: 99,
        context_window_tokens: 1,
      }),
      row({
        created_at_ms: T + 1000,
        model: "new-model",
        client_label: "Claude Code",
        cache_ttl_s: 300,
        input_tokens: 100,
        cache_read_input_tokens: 2000,
        cache_creation_input_tokens: 30,
        output_tokens: 500,
        context_window_tokens: 1_000_000,
        context_ceiling_tokens: 128_000,
        compact_at_tokens: null,
        window_source: "claude-1m",
      }),
    ]
    const view = only(build(rows, T + 2000))
    expect(view.model).toBe("new-model")
    expect(view.client_label).toBe("Claude Code")
    expect(view.cache.ttl_s).toBe(300)
    expect(view.cache.last_cache_read_tokens).toBe(2000)
    expect(view.context).toEqual({
      used_tokens: 2130,
      window_tokens: 1_000_000,
      ceiling_tokens: 128_000,
      compact_at_tokens: null,
      window_source: "claude-1m",
      compacted_at_ms: null,
    })
  })

  test("compacted_at_ms is the latest compaction request", () => {
    const rows = [
      row({ is_compact: 1, created_at_ms: T }),
      row({ is_compact: 1, created_at_ms: T + 1000 }),
      row({ is_compact: 0, created_at_ms: T + 2000 }),
    ]
    expect(only(build(rows, T + 3000)).context.compacted_at_ms).toBe(T + 1000)
  })

  test("a row without a recorded window source reads as the model listing", () => {
    const view = only(build([row({ window_source: null })], T + 1))
    expect(view.context.window_source).toBe("model-listing")
  })
})

describe("minutes and rate", () => {
  test("15 one-minute buckets end at the current minute; the rate is the mean of the last 5", () => {
    const now = T + 30_000 // half-way through minute T
    const rows = [
      row({ created_at_ms: T - 15 * MINUTE, total_tokens: 1000 }), // before the window
      row({ created_at_ms: T - 14 * MINUTE, total_tokens: 7 }), // oldest bucket
      row({ created_at_ms: T - 5 * MINUTE, total_tokens: 400 }), // outside the rate
      row({ created_at_ms: T - 4 * MINUTE, total_tokens: 50 }),
      row({ created_at_ms: T - 4 * MINUTE + 59_999, total_tokens: 50 }),
      row({ created_at_ms: T + 10_000, total_tokens: 400 }),
    ]
    const view = only(build(rows, now))
    expect(view.minutes).toHaveLength(15)
    expect(view.minutes[14]).toEqual({ start_ms: T, total_tokens: 400 })
    expect(view.minutes[0]).toEqual({
      start_ms: T - 14 * MINUTE,
      total_tokens: 7,
    })
    expect(view.minutes[9]).toEqual({
      start_ms: T - 5 * MINUTE,
      total_tokens: 400,
    })
    expect(view.minutes[10]).toEqual({
      start_ms: T - 4 * MINUTE,
      total_tokens: 100,
    })
    expect(view.rate_per_min).toBe((100 + 400) / 5)
    expect(view.total_tokens).toBe(1000 + 7 + 400 + 100 + 400)
    expect(view.request_count).toBe(6)
  })
})

describe("flow_per_min", () => {
  test("counts the trailing 60 s of rows plus bytes streamed by every request in flight", () => {
    const now = T + 5 * MINUTE
    const rows = [
      row({ created_at_ms: now - MINUTE, total_tokens: 1000 }), // just outside
      row({ created_at_ms: now - MINUTE + 1, total_tokens: 30 }),
      row({ session_id: "s2", created_at_ms: now - 1, total_tokens: 12 }),
    ]
    const view = build(rows, now, {
      inFlight: [
        inFlight({ sessionId: "s1", streamedBytes: 160 }), // 10 tokens
        inFlight({ sessionId: "", streamedBytes: 32 }), // 2 tokens
      ],
    })
    expect(view.flow_per_min).toBe(30 + 12 + 10 + 2)
  })

  test("is zero with nothing recent and nothing in flight", () => {
    expect(build([row()], T + 2 * MINUTE).flow_per_min).toBe(0)
  })
})

describe("CacheObservations", () => {
  const HOUR = 3600
  const RESUME_GAP_MS = 40 * MINUTE

  function hit(observations: CacheObservations, key?: string): void {
    observations.record({
      model: CLAUDE,
      gapMs: RESUME_GAP_MS,
      requestedTtlS: HOUR,
      cacheReadTokens: 500,
      key,
    })
  }

  function miss(observations: CacheObservations, key?: string): void {
    observations.record({
      model: CLAUDE,
      gapMs: RESUME_GAP_MS,
      requestedTtlS: HOUR,
      cacheReadTokens: 0,
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
      })
    }
    observations.record({
      model: CLAUDE,
      gapMs: 300_000,
      requestedTtlS: HOUR,
      cacheReadTokens: 500,
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

describe("observations fed while building", () => {
  const HOUR = 3600
  const OTHER = "claude-haiku-4"

  /** One session: a request at T, then a resume every 40 minutes reading
   *  the given cached tokens. */
  function resumes(...cacheReads: Array<number>): Array<SessionRow> {
    return [
      row({ id: 100, created_at_ms: T, cache_ttl_s: HOUR }),
      ...cacheReads.map((cacheRead, i) =>
        row({
          id: 101 + i,
          created_at_ms: T + (i + 1) * 40 * MINUTE,
          cache_ttl_s: HOUR,
          cache_read_input_tokens: cacheRead,
        }),
      ),
    ]
  }

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
    expect(warm.state).toBe("warm")
    expect(only(build(rows, last + 300_000)).state).toBe("cold")
  })

  test("a hit after a downgrade restores the countdown", () => {
    const view = only(build(resumes(0, 0, 800), T + 121 * MINUTE))
    expect(view.cache.ttl_s).toBe(HOUR)
    expect(view.cache.downgraded).toBe(false)
    expect(view.cache.confidence).toBe("observed")
  })

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

describe("a session still streaming its first reply", () => {
  test("shows as a minimal streaming session", () => {
    const view = build([], T + 30_000, {
      inFlight: [
        inFlight({
          sessionId: "new",
          client: "codex",
          model: "gpt-5",
          startedAtMs: T + 20_000,
          streamedBytes: 160,
        }),
        inFlight({ sessionId: "new", startedAtMs: T + 25_000 }),
      ],
    })
    expect(view.sessions).toEqual([
      {
        id: "new",
        client: "codex",
        client_label: null,
        model: "gpt-5",
        started_at_ms: T + 20_000,
        last_request_at_ms: T + 20_000,
        state: "streaming",
        rate_per_min: 0,
        minutes: Array.from({ length: 15 }, (_, i) => ({
          start_ms: T - (14 - i) * MINUTE,
          total_tokens: 0,
        })),
        total_tokens: 0,
        request_count: 0,
        cache: {
          ttl_s: 0,
          expires_at_ms: null,
          confidence: "estimated",
          downgraded: false,
          last_cache_read_tokens: 0,
        },
        context: {
          used_tokens: 0,
          window_tokens: null,
          ceiling_tokens: null,
          compact_at_tokens: null,
          window_source: "model-listing",
          compacted_at_ms: null,
        },
      },
    ])
    expect(view.flow_per_min).toBe(10)
  })

  test("is not added for a session that has rows, or for an entry with no session", () => {
    const view = build([row({ session_id: "s1" })], T + 1, {
      inFlight: [inFlight({ sessionId: "s1" }), inFlight({ sessionId: "" })],
    })
    expect(view.sessions.map((s) => [s.id, s.state, s.request_count])).toEqual([
      ["s1", "streaming", 1],
    ])
  })

  test("sorts by its start among the other sessions", () => {
    const view = build(
      [row({ session_id: "old", created_at_ms: T })],
      T + 2 * MINUTE,
      { inFlight: [inFlight({ sessionId: "new", startedAtMs: T + MINUTE })] },
    )
    expect(view.sessions.map((s) => s.id)).toEqual(["new", "old"])
  })
})

describe("SessionsResponse", () => {
  test("accepts a built view, including a streaming-only session", () => {
    const view = build(
      [row(), row({ session_id: "", client: "other", window_source: null })],
      T + 1,
      {
        inFlight: [
          inFlight(),
          inFlight({ sessionId: "fresh", client: "codex" }),
        ],
      },
    )
    expect(view.sessions.map((s) => s.id)).toContain("fresh")
    expect(SessionsResponse.parse(view)).toEqual(view)
  })

  test("rejects an unknown cache confidence", () => {
    const view = build([row()], T + 1)
    const broken = {
      ...view,
      sessions: [
        {
          ...view.sessions[0],
          cache: { ...view.sessions[0].cache, confidence: "guessed" },
        },
      ],
    }
    expect(SessionsResponse.safeParse(broken).success).toBe(false)
  })

  test("requires cache.downgraded as a boolean", () => {
    const view = build([row()], T + 1)
    const { downgraded: _dropped, ...cache } = view.sessions[0].cache
    const missing = { ...view, sessions: [{ ...view.sessions[0], cache }] }
    expect(SessionsResponse.safeParse(missing).success).toBe(false)
    const wrongType = {
      ...view,
      sessions: [
        { ...view.sessions[0], cache: { ...cache, downgraded: "no" } },
      ],
    }
    expect(SessionsResponse.safeParse(wrongType).success).toBe(false)
  })
})
