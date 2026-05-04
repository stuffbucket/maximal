import { afterEach, describe, expect, it, mock } from "bun:test"

import {
  _resetRefreshInFlightForTests,
  isStale,
  JITTER_MS,
  refreshIfStale,
  STALE_AFTER_MS,
} from "~/lib/refresh-models"

afterEach(() => {
  _resetRefreshInFlightForTests()
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
  it("returns 'not_primed' before the first load", () => {
    const refresh = mock(() => Promise.resolve())
    const result = refreshIfStale({
      getLoadedAtMs: () => null,
      refresh,
      now: () => 1_000_000_000,
      jitterMs: 0,
    })
    expect(result).toBe("not_primed")
    expect(refresh).not.toHaveBeenCalled()
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

describe("JITTER_MS / STALE_AFTER_MS constants", () => {
  it("has sane defaults", () => {
    expect(STALE_AFTER_MS).toBe(6 * 60 * 60 * 1000)
    expect(JITTER_MS).toBe(2 * 60 * 60 * 1000)
  })
})
