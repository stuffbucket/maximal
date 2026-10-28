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

  test("a requested lifetime is 'requested' until seen; an unrequested one is estimated", () => {
    const observations = new CacheObservations()
    expect(observations.confidence(CLAUDE, HOUR, true)).toBe("requested")
    expect(observations.confidence("gpt-5", 300, false)).toBe("estimated")
    expect(observations.effectiveTtlS(CLAUDE, HOUR)).toBe(HOUR)
  })

  test("a resume inside the lifetime that reads the cache makes it observed", () => {
    const observations = new CacheObservations()
    observations.record({
      model: CLAUDE,
      gapMs: RESUME_GAP_MS,
      requestedTtlS: HOUR,
      cacheReadTokens: 500,
    })
    expect(observations.confidence(CLAUDE, HOUR, true)).toBe("observed")
    expect(observations.effectiveTtlS(CLAUDE, HOUR)).toBe(HOUR)
    expect(observations.confidence("other-model", HOUR, true)).toBe("requested")
  })

  test("a resume inside the lifetime that reads nothing drops the model to 5 minutes", () => {
    const observations = new CacheObservations()
    observations.record({
      model: CLAUDE,
      gapMs: RESUME_GAP_MS,
      requestedTtlS: HOUR,
      cacheReadTokens: 0,
    })
    expect(observations.effectiveTtlS(CLAUDE, HOUR)).toBe(300)
    expect(observations.confidence(CLAUDE, HOUR, true)).toBe("estimated")
    // A 5-minute request on that model is not contradicted by the failure.
    expect(observations.effectiveTtlS(CLAUDE, 300)).toBe(300)
    expect(observations.confidence(CLAUDE, 300, true)).toBe("requested")
    expect(observations.effectiveTtlS(CLAUDE, 0)).toBe(0)
  })

  test("a failure is not undone by a later success", () => {
    const observations = new CacheObservations()
    observations.record({
      model: CLAUDE,
      gapMs: RESUME_GAP_MS,
      requestedTtlS: HOUR,
      cacheReadTokens: 0,
    })
    observations.record({
      model: CLAUDE,
      gapMs: RESUME_GAP_MS,
      requestedTtlS: HOUR,
      cacheReadTokens: 500,
    })
    expect(observations.effectiveTtlS(CLAUDE, HOUR)).toBe(300)
    expect(observations.confidence(CLAUDE, HOUR, true)).toBe("estimated")
  })

  test("resumes at or under 5 minutes, or past the lifetime, prove nothing", () => {
    const observations = new CacheObservations()
    observations.record({
      model: CLAUDE,
      gapMs: 300_000,
      requestedTtlS: HOUR,
      cacheReadTokens: 0,
    })
    observations.record({
      model: CLAUDE,
      gapMs: HOUR * 1000 + 1,
      requestedTtlS: HOUR,
      cacheReadTokens: 0,
    })
    observations.record({
      model: CLAUDE,
      gapMs: 300_000,
      requestedTtlS: HOUR,
      cacheReadTokens: 500,
    })
    expect(observations.effectiveTtlS(CLAUDE, HOUR)).toBe(HOUR)
    expect(observations.confidence(CLAUDE, HOUR, true)).toBe("requested")
  })

  test("a resume exactly at the lifetime still counts", () => {
    const observations = new CacheObservations()
    observations.record({
      model: CLAUDE,
      gapMs: HOUR * 1000,
      requestedTtlS: HOUR,
      cacheReadTokens: 0,
    })
    expect(observations.effectiveTtlS(CLAUDE, HOUR)).toBe(300)
  })

  test("the same pair recorded under one key counts once", () => {
    const observations = new CacheObservations()
    observations.record({
      model: CLAUDE,
      gapMs: RESUME_GAP_MS,
      requestedTtlS: HOUR,
      cacheReadTokens: 500,
      key: "1>2",
    })
    observations.record({
      model: CLAUDE,
      gapMs: RESUME_GAP_MS,
      requestedTtlS: HOUR,
      cacheReadTokens: 0,
      key: "1>2",
    })
    expect(observations.confidence(CLAUDE, HOUR, true)).toBe("observed")
  })
})

describe("observations fed while building", () => {
  const HOUR = 3600

  function resumedSession(cacheRead: number): Array<SessionRow> {
    return [
      row({ id: 10, created_at_ms: T, cache_ttl_s: HOUR }),
      row({
        id: 11,
        created_at_ms: T + 40 * MINUTE,
        cache_ttl_s: HOUR,
        cache_read_input_tokens: cacheRead,
      }),
    ]
  }

  test("a resume that read the cache shows as observed", () => {
    const view = only(build(resumedSession(800), T + 41 * MINUTE))
    expect(view.cache.confidence).toBe("observed")
    expect(view.cache.ttl_s).toBe(HOUR)
    expect(view.state).toBe("warm")
  })

  test("a resume that read nothing shortens the countdown to 5 minutes", () => {
    const rows = resumedSession(0)
    const last = T + 40 * MINUTE
    const warm = only(build(rows, last + 299_999))
    expect(warm.cache.ttl_s).toBe(300)
    expect(warm.cache.expires_at_ms).toBe(last + 300_000)
    expect(warm.cache.confidence).toBe("estimated")
    expect(warm.state).toBe("warm")
    expect(only(build(rows, last + 300_000)).state).toBe("cold")
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

  test("repeated builds over the same rows give the same view", () => {
    const observations = new CacheObservations()
    const rows = [
      ...resumedSession(800),
      row({
        id: 12,
        created_at_ms: T + 80 * MINUTE,
        cache_ttl_s: HOUR,
        cache_read_input_tokens: 0,
      }),
    ]
    const now = T + 81 * MINUTE
    const first = build(rows, now, { observations })
    const second = build(rows, now, { observations })
    const third = build(rows, now, { observations })
    expect(second).toEqual(first)
    expect(third).toEqual(first)
  })
})

describe("SessionsResponse", () => {
  test("accepts a built view", () => {
    const view = build(
      [row(), row({ session_id: "", client: "other", window_source: null })],
      T + 1,
      { inFlight: [inFlight()] },
    )
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
})
