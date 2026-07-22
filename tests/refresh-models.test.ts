/* eslint-disable require-atomic-updates */
import { afterEach, describe, expect, it, mock } from "bun:test"
import { Hono } from "hono"

import {
  _resetPrimeStateForTests,
  _resetRefreshInFlightForTests,
  isStale,
  JITTER_MS,
  PRIME_COOLDOWN_MS,
  primeModelsCache,
  refreshIfStale,
  STALE_AFTER_MS,
  staleRefreshMiddleware,
} from "~/lib/models/refresh-models"
import { state } from "~/lib/runtime-state/state"

afterEach(() => {
  _resetRefreshInFlightForTests()
  _resetPrimeStateForTests()
  // The on-demand prime reads modelsCached(); leave the cache empty for the
  // next test so a stray primed catalog can't mask a "not primed" branch.
  state.models = undefined
})

describe("isStale", () => {
  it("returns false when the cache hasn't been primed yet", () => {
    expect(
      isStale({
        now: 1_000_000,
        loadedAtMs: null,
        staleAfterMs: STALE_AFTER_MS,
        jitterMs: 0,
      }),
    ).toBe(false)
  })

  it("returns false within the staleness window", () => {
    const loaded = 1_000_000_000
    expect(
      isStale({
        now: loaded + STALE_AFTER_MS - 1,
        loadedAtMs: loaded,
        staleAfterMs: STALE_AFTER_MS,
        jitterMs: 0,
      }),
    ).toBe(false)
  })

  it("returns true past the staleness window", () => {
    const loaded = 1_000_000_000
    expect(
      isStale({
        now: loaded + STALE_AFTER_MS + 1,
        loadedAtMs: loaded,
        staleAfterMs: STALE_AFTER_MS,
        jitterMs: 0,
      }),
    ).toBe(true)
  })

  it("returns false at the exact boundary (now === loaded + stale + jitter)", () => {
    // Strict-greater semantics: equality is NOT stale.
    const loaded = 1_000_000_000
    expect(
      isStale({
        now: loaded + STALE_AFTER_MS + 0,
        loadedAtMs: loaded,
        staleAfterMs: STALE_AFTER_MS,
        jitterMs: 0,
      }),
    ).toBe(false)
  })

  it("returns false at the exact boundary with non-zero jitter", () => {
    const loaded = 1_000_000_000
    const jitter = 7 * 60 * 1000
    expect(
      isStale({
        now: loaded + STALE_AFTER_MS + jitter,
        loadedAtMs: loaded,
        staleAfterMs: STALE_AFTER_MS,
        jitterMs: jitter,
      }),
    ).toBe(false)
  })

  it("returns false with null loadedAtMs even when 'now' is enormous", () => {
    // Pins the early-return guard against being short-circuited away.
    expect(
      isStale({
        now: Number.MAX_SAFE_INTEGER,
        loadedAtMs: null,
        staleAfterMs: STALE_AFTER_MS,
        jitterMs: 0,
      }),
    ).toBe(false)
  })

  it("respects positive jitter (extends the window)", () => {
    const loaded = 1_000_000_000
    const jitter = 5 * 60 * 1000 // +5min
    // Past stale-after but within jitter extension → not yet stale
    expect(
      isStale({
        now: loaded + STALE_AFTER_MS + jitter - 1,
        loadedAtMs: loaded,
        staleAfterMs: STALE_AFTER_MS,
        jitterMs: jitter,
      }),
    ).toBe(false)
  })

  it("respects negative jitter (shortens the window)", () => {
    const loaded = 1_000_000_000
    const jitter = -5 * 60 * 1000 // -5min
    // Past (stale-after - 5min), inside the un-jittered window
    expect(
      isStale({
        now: loaded + STALE_AFTER_MS + jitter + 1,
        loadedAtMs: loaded,
        staleAfterMs: STALE_AFTER_MS,
        jitterMs: jitter,
      }),
    ).toBe(true)
  })
})

describe("refreshIfStale", () => {
  it("primes on demand when the cache was never loaded (empty catalog self-heals)", () => {
    const refresh = mock(() => Promise.resolve())
    const result = refreshIfStale({
      getLoadedAtMs: () => null,
      refresh,
      now: () => 1_000_000_000,
      jitterMs: 0,
    })
    expect(result).toBe("priming")
    expect(refresh).toHaveBeenCalledTimes(1)
  })

  it("single-flights concurrent on-demand primes", () => {
    let resolveRefresh: (() => void) | undefined
    const refresh = mock(
      () =>
        new Promise<void>((resolve) => {
          resolveRefresh = resolve
        }),
    )
    const opts = {
      getLoadedAtMs: () => null,
      refresh,
      now: () => 1_000_000_000,
      jitterMs: 0,
    }
    expect(refreshIfStale(opts)).toBe("priming")
    expect(refreshIfStale(opts)).toBe("prime_in_flight")
    expect(refreshIfStale(opts)).toBe("prime_in_flight")
    expect(refresh).toHaveBeenCalledTimes(1)
    resolveRefresh?.()
  })

  it("cooldown bounds sequential prime retries without a timer", async () => {
    const t0 = 1_000_000_000
    const refresh = mock(() =>
      Promise.reject(new Error("models endpoint down")),
    )
    const base = {
      getLoadedAtMs: () => null,
      refresh,
      jitterMs: 0,
    }
    // First attempt fires and fails.
    expect(refreshIfStale({ ...base, now: () => t0 })).toBe("priming")
    await new Promise((r) => setTimeout(r, 0))
    expect(refresh).toHaveBeenCalledTimes(1)

    // A retry inside the cooldown window is skipped — no re-hit of the endpoint.
    expect(
      refreshIfStale({ ...base, now: () => t0 + PRIME_COOLDOWN_MS - 1 }),
    ).toBe("prime_cooldown")
    expect(refresh).toHaveBeenCalledTimes(1)

    // Past the cooldown, it fires again.
    expect(
      refreshIfStale({ ...base, now: () => t0 + PRIME_COOLDOWN_MS + 1 }),
    ).toBe("priming")
    expect(refresh).toHaveBeenCalledTimes(2)
  })

  it("returns 'fresh' inside the staleness window", () => {
    const loaded = 1_000_000_000
    const refresh = mock(() => Promise.resolve())
    const result = refreshIfStale({
      getLoadedAtMs: () => loaded,
      refresh,
      now: () => loaded + 60_000,
      jitterMs: 0,
    })
    expect(result).toBe("fresh")
    expect(refresh).not.toHaveBeenCalled()
  })

  it("fires the refresh past the staleness window", () => {
    const loaded = 1_000_000_000
    const refresh = mock(() => Promise.resolve())
    const result = refreshIfStale({
      getLoadedAtMs: () => loaded,
      refresh,
      now: () => loaded + STALE_AFTER_MS + 1,
      jitterMs: 0,
    })
    expect(result).toBe("fired")
    expect(refresh).toHaveBeenCalledTimes(1)
  })

  it("single-flights concurrent triggering calls", async () => {
    const loaded = 1_000_000_000
    let resolveRefresh: (() => void) | undefined
    const refresh = mock(
      () =>
        new Promise<void>((resolve) => {
          resolveRefresh = resolve
        }),
    )
    const opts = {
      getLoadedAtMs: () => loaded,
      refresh,
      now: () => loaded + STALE_AFTER_MS + 1,
      jitterMs: 0,
    }
    const first = refreshIfStale(opts)
    const second = refreshIfStale(opts)
    const third = refreshIfStale(opts)
    expect(first).toBe("fired")
    expect(second).toBe("in_flight")
    expect(third).toBe("in_flight")
    expect(refresh).toHaveBeenCalledTimes(1)

    // Resolve the in-flight refresh; the guard clears, next call fires
    // again (which is correct — the cache mock here doesn't actually
    // bump loaded_at_ms, so it'd still appear stale).
    resolveRefresh?.()
    await new Promise((r) => setTimeout(r, 0))
    const fourth = refreshIfStale(opts)
    expect(fourth).toBe("fired")
    expect(refresh).toHaveBeenCalledTimes(2)
  })

  it("invokes onError on rejection without throwing to caller", async () => {
    const loaded = 1_000_000_000
    const failure = new Error("upstream down")
    const refresh = mock(() => Promise.reject(failure))
    const onError = mock((_err: unknown) => {})
    const result = refreshIfStale({
      getLoadedAtMs: () => loaded,
      refresh,
      now: () => loaded + STALE_AFTER_MS + 1,
      jitterMs: 0,
      onError,
    })
    expect(result).toBe("fired")
    // Wait for the unhandled rejection path to settle
    await new Promise((r) => setTimeout(r, 0))
    expect(onError).toHaveBeenCalledTimes(1)
    expect(onError.mock.calls[0][0]).toBe(failure)
  })

  it("clears the single-flight guard after failure", async () => {
    const loaded = 1_000_000_000
    let attempt = 0
    const refresh = mock(() => {
      attempt++
      return attempt === 1 ?
          Promise.reject(new Error("first try"))
        : Promise.resolve()
    })
    const onError = mock((_err: unknown) => {})
    const opts = {
      getLoadedAtMs: () => loaded,
      refresh,
      now: () => loaded + STALE_AFTER_MS + 1,
      jitterMs: 0,
      onError,
    }
    expect(refreshIfStale(opts)).toBe("fired")
    await new Promise((r) => setTimeout(r, 0))
    expect(refreshIfStale(opts)).toBe("fired")
    expect(refresh).toHaveBeenCalledTimes(2)
  })
})

describe("primeModelsCache", () => {
  it("logs a recovery note when an empty cache repopulates", async () => {
    state.models = undefined // empty catalog
    const info = mock((..._a: Array<unknown>) => {})
    const warn = mock((..._a: Array<unknown>) => {})
    await primeModelsCache(
      () => {
        // Simulate a successful refresh that populates the cache.
        state.models = { data: [{ id: "gpt-4" }] } as never
        return Promise.resolve()
      },
      { info, warn },
    )
    expect(info).toHaveBeenCalledTimes(1)
    expect(warn).not.toHaveBeenCalled()
  })

  it("does NOT log a recovery note when the cache was already populated", async () => {
    state.models = { data: [{ id: "gpt-4" }] } as never // already primed
    const info = mock((..._a: Array<unknown>) => {})
    const warn = mock((..._a: Array<unknown>) => {})
    await primeModelsCache(() => Promise.resolve(), { info, warn })
    expect(info).not.toHaveBeenCalled()
  })

  it("warns and does not throw when the prime fails", async () => {
    state.models = undefined
    const info = mock((..._a: Array<unknown>) => {})
    const warn = mock((..._a: Array<unknown>) => {})
    // Resolves cleanly (no throw) despite the refresh rejecting.
    await primeModelsCache(() => Promise.reject(new Error("down")), {
      info,
      warn,
    })
    expect(warn).toHaveBeenCalledTimes(1)
    expect(info).not.toHaveBeenCalled()
  })
})

describe("JITTER_MS / STALE_AFTER_MS constants", () => {
  it("has sane defaults", () => {
    expect(STALE_AFTER_MS).toBe(6 * 60 * 60 * 1000)
    expect(JITTER_MS).toBe(2 * 60 * 60 * 1000)
  })
})

describe("jitter fallback (state.macMachineId)", () => {
  // The jitter source is indirectly observed: when opts.jitterMs is
  // omitted, refreshIfStale must compute jitter via jitterFor(macId).
  // For any well-formed machineId, the result must land in
  // [-JITTER_MS/2, +JITTER_MS/2). This kills the `%` → `*` and
  // `/ JITTER_MS / 2` → `* JITTER_MS / 2` mutations: under those
  // mutations, the computed jitter would explode well outside the
  // bound, causing the "barely stale" probe below to misbehave.
  const sampleMachineIds = [
    "machine-aaaaaaaa",
    "machine-bbbbbbbb",
    "abc",
    "x".repeat(64),
    "0123456789abcdef",
    "another-id-with-some-entropy-zzz",
  ]

  it("computed default jitter stays within [-JITTER_MS/2, +JITTER_MS/2)", () => {
    const loaded = 1_000_000_000
    const original = state.macMachineId
    try {
      for (const id of sampleMachineIds) {
        state.macMachineId = id

        // Probe well past stale window + max possible jitter → must fire.
        const farPast = refreshIfStale({
          getLoadedAtMs: () => loaded,
          refresh: () => Promise.resolve(),
          now: () => loaded + STALE_AFTER_MS + JITTER_MS + 1_000_000,
        })
        expect(farPast).toBe("fired")
        _resetRefreshInFlightForTests()

        // Probe well before stale window - max possible jitter → must be fresh.
        const farFuture = refreshIfStale({
          getLoadedAtMs: () => loaded,
          refresh: () => Promise.resolve(),
          now: () => loaded + STALE_AFTER_MS - JITTER_MS - 1,
        })
        expect(farFuture).toBe("fresh")
      }
    } finally {
      state.macMachineId = original
    }
  })

  it("falls back to 0 jitter when macMachineId is undefined", () => {
    const loaded = 1_000_000_000
    const original = state.macMachineId
    state.macMachineId = undefined
    try {
      // With jitterFor → 0, the boundary is exactly STALE_AFTER_MS.
      const refresh = mock(() => Promise.resolve())
      // 1ms past the un-jittered boundary should fire.
      const result = refreshIfStale({
        getLoadedAtMs: () => loaded,
        refresh,
        now: () => loaded + STALE_AFTER_MS + 1,
      })
      expect(result).toBe("fired")
      expect(refresh).toHaveBeenCalledTimes(1)
    } finally {
      state.macMachineId = original
    }
  })

  it("does not crash when onError is omitted and refresh rejects", async () => {
    const loaded = 1_000_000_000
    const refresh = mock(() => Promise.reject(new Error("boom")))
    const result = refreshIfStale({
      getLoadedAtMs: () => loaded,
      refresh,
      now: () => loaded + STALE_AFTER_MS + 1,
      jitterMs: 0,
      // onError intentionally omitted
    })
    expect(result).toBe("fired")
    // Let the rejection settle; if `?.` were removed the test process
    // would throw "opts.onError is not a function".
    await new Promise((r) => setTimeout(r, 0))
    // Single-flight should have cleared after rejection.
    const second = refreshIfStale({
      getLoadedAtMs: () => loaded,
      refresh,
      now: () => loaded + STALE_AFTER_MS + 1,
      jitterMs: 0,
    })
    expect(second).toBe("fired")
  })
})

describe("staleRefreshMiddleware", () => {
  it("calls next() and triggers refresh when stale", async () => {
    const loaded = 1_000_000_000
    // Force jitterMs=0 path indirectly: clear macMachineId so jitterFor=0.
    const original = state.macMachineId
    state.macMachineId = undefined
    try {
      const refresh = mock(() => Promise.resolve())
      // Pin Date.now well past the staleness window for this test.
      const realNow = Date.now
      Date.now = () => loaded + STALE_AFTER_MS + 10_000
      try {
        const app = new Hono()
        app.use(
          "*",
          staleRefreshMiddleware({
            getLoadedAtMs: () => loaded,
            refresh,
          }),
        )
        app.get("/ping", (c) => c.text("pong"))
        const res = await app.request("/ping")
        expect(res.status).toBe(200)
        expect(await res.text()).toBe("pong")
        expect(refresh).toHaveBeenCalledTimes(1)
      } finally {
        Date.now = realNow
      }
    } finally {
      state.macMachineId = original
    }
  })

  it("does not trigger refresh when cache is fresh", async () => {
    const loaded = 1_000_000_000
    const original = state.macMachineId
    state.macMachineId = undefined
    try {
      const refresh = mock(() => Promise.resolve())
      const realNow = Date.now
      Date.now = () => loaded + 60_000 // well within window
      try {
        const app = new Hono()
        app.use(
          "*",
          staleRefreshMiddleware({
            getLoadedAtMs: () => loaded,
            refresh,
          }),
        )
        app.get("/ping", (c) => c.text("pong"))
        const res = await app.request("/ping")
        expect(res.status).toBe(200)
        expect(refresh).not.toHaveBeenCalled()
      } finally {
        Date.now = realNow
      }
    } finally {
      state.macMachineId = original
    }
  })

  it("primes on demand (self-heals) when the cache was never loaded, without blocking the request", async () => {
    state.models = undefined // empty / never-primed catalog
    const refresh = mock(() => Promise.resolve())
    const app = new Hono()
    app.use(
      "*",
      staleRefreshMiddleware({
        getLoadedAtMs: () => null,
        refresh,
      }),
    )
    let ran = false
    app.get("/ping", (c) => {
      ran = true
      return c.text("pong")
    })
    const res = await app.request("/ping")
    expect(res.status).toBe(200)
    expect(ran).toBe(true)
    // An empty cache now triggers a background prime (fire-and-forget) so the
    // catalog self-heals on live traffic — the request still completes without
    // waiting on it.
    expect(refresh).toHaveBeenCalledTimes(1)
  })

  it("forwards refresh rejections to onError when stale", async () => {
    const loaded = 1_000_000_000
    const original = state.macMachineId
    state.macMachineId = undefined
    try {
      const failure = new Error("upstream down")
      const refresh = mock(() => Promise.reject(failure))
      const onError = mock((_err: unknown) => {})
      const realNow = Date.now
      Date.now = () => loaded + STALE_AFTER_MS + 10_000
      try {
        const app = new Hono()
        app.use(
          "*",
          staleRefreshMiddleware({
            getLoadedAtMs: () => loaded,
            refresh,
            onError,
          }),
        )
        app.get("/ping", (c) => c.text("pong"))
        const res = await app.request("/ping")
        expect(res.status).toBe(200)
        await new Promise((r) => setTimeout(r, 0))
        expect(refresh).toHaveBeenCalledTimes(1)
        expect(onError).toHaveBeenCalledTimes(1)
        expect(onError.mock.calls[0][0]).toBe(failure)
      } finally {
        Date.now = realNow
      }
    } finally {
      state.macMachineId = original
    }
  })
})
