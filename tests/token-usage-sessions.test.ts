import { describe, expect, test } from "bun:test"

import { SessionsResponse } from "~/lib/token-usage/sessions-schema"

import {
  build,
  CLAUDE,
  inFlight,
  MINUTE,
  only,
  row,
  T,
} from "./helpers/session-rows"

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

  test("on one model, the latest request supplies client label, cache and context", () => {
    const rows = [
      row({
        model: "new-model",
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

  test("an integration's own key label is not shown as a custom label", () => {
    const view = build(
      [
        row({ session_id: "a", client_label: "claude-code" }),
        row({
          session_id: "b",
          client: "claude-desktop",
          client_label: "claude-desktop",
        }),
        row({ session_id: "c", client: "codex", client_label: "codex" }),
        row({ session_id: "d", client_label: "Laptop" }),
      ],
      T + 1,
    )
    const labels = Object.fromEntries(
      view.sessions.map((s) => [s.id, s.client_label]),
    )
    expect(labels).toEqual({ a: null, b: null, c: null, d: "Laptop" })
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

describe("several models in one session", () => {
  const HAIKU = "claude-haiku-4"

  test("a side request on another model does not take over the session", () => {
    // The main model asked for an hour; a subagent request on Haiku with no
    // cache marker came after it under the same session id.
    const rows = [
      row({
        created_at_ms: T,
        cache_ttl_s: 3600,
        input_tokens: 2_000,
        cache_read_input_tokens: 90_000,
        total_tokens: 92_500,
        context_window_tokens: 200_000,
      }),
      row({
        model: HAIKU,
        created_at_ms: T + 2 * MINUTE,
        cache_ttl_s: 0,
        cache_ttl_requested: 0,
        input_tokens: 3_000,
        total_tokens: 3_200,
        context_window_tokens: 100_000,
      }),
    ]
    const view = only(build(rows, T + 3 * MINUTE))
    expect(view.model).toBe(CLAUDE)
    expect(view.state).toBe("warm")
    expect(view.cache.ttl_s).toBe(3600)
    expect(view.cache.expires_at_ms).toBe(T + 3_600_000)
    expect(view.context.used_tokens).toBe(92_000)
    expect(view.context.window_tokens).toBe(200_000)
    // The latest activity is still the side request's.
    expect(view.last_request_at_ms).toBe(T + 2 * MINUTE)
  })

  test("the session stays warm until the last model's cache runs out", () => {
    const rows = [
      row({ created_at_ms: T, cache_ttl_s: 300, total_tokens: 50_000 }),
      row({
        model: HAIKU,
        created_at_ms: T + MINUTE,
        cache_ttl_s: 3600,
        total_tokens: 1_000,
      }),
      row({
        created_at_ms: T + 2 * MINUTE,
        cache_ttl_s: 300,
        total_tokens: 50_000,
      }),
    ]
    const warm = only(build(rows, T + 10 * MINUTE))
    expect(warm.model).toBe(CLAUDE)
    expect(warm.state).toBe("warm")
    expect(warm.cache.expires_at_ms).toBe(T + MINUTE + 3_600_000)
    expect(warm.cache.ttl_s).toBe(3600)
    const cold = only(build(rows, T + MINUTE + 3_600_000))
    expect(cold.state).toBe("cold")
    expect(cold.cache.expires_at_ms).toBe(T + MINUTE + 3_600_000)
  })

  test("the main model is the one with the most tokens in the session", () => {
    const rows = [
      row({ model: HAIKU, created_at_ms: T, total_tokens: 900 }),
      row({ created_at_ms: T + 1000, total_tokens: 400 }),
      row({ model: HAIKU, created_at_ms: T + 2000, total_tokens: 900 }),
      row({ created_at_ms: T + 3000, total_tokens: 400 }),
    ]
    expect(only(build(rows, T + 4000)).model).toBe(HAIKU)
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
  test("counts the trailing 60 s of rows plus text streamed by every request in flight", () => {
    const now = T + 5 * MINUTE
    const rows = [
      row({ created_at_ms: now - MINUTE, input_tokens: 1000 }), // just outside
      row({ created_at_ms: now - MINUTE + 1, output_tokens: 30 }),
      row({ session_id: "s2", created_at_ms: now - 1, input_tokens: 12 }),
    ]
    const view = build(rows, now, {
      inFlight: [
        inFlight({ sessionId: "s1", streamedChars: 40 }), // 10 tokens
        inFlight({ sessionId: "", streamedChars: 8 }), // 2 tokens
      ],
    })
    expect(view.flow_per_min).toBe(30 + 12 + 10 + 2)
  })

  test("leaves out cache reads, so a resent context doesn't read as flow", () => {
    const now = T + 5 * MINUTE
    const rows = [
      row({
        created_at_ms: now - 1000,
        input_tokens: 100,
        output_tokens: 50,
        cache_creation_input_tokens: 30,
        cache_read_input_tokens: 100_000,
        total_tokens: 100_180,
      }),
    ]
    expect(build(rows, now).flow_per_min).toBe(180)
  })

  test("is zero with nothing recent and nothing in flight", () => {
    expect(build([row()], T + 2 * MINUTE).flow_per_min).toBe(0)
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
          streamedChars: 40,
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
          downgraded_from_s: null,
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
