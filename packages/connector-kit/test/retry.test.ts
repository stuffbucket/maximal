import { describe, expect, test } from "bun:test"

import { DEFAULT_LIMITS, resolveLimits } from "../src/upstream/limits"
import { backoffDelay, cooldownFor } from "../src/upstream/retry"
import { parseRetryAfter } from "../src/upstream/retry-after"

const NOW = Date.UTC(2025, 0, 1)
const half = () => 0.5

describe("parseRetryAfter", () => {
  test("delta-seconds, decimals, HTTP-dates; uncapped; garbage is undefined", () => {
    expect(parseRetryAfter("0", NOW)).toBe(0)
    expect(parseRetryAfter("7", NOW)).toBe(7000)
    expect(parseRetryAfter(" 7.5 ", NOW)).toBe(7500)
    expect(parseRetryAfter("9999", NOW)).toBe(9_999_000)
    expect(parseRetryAfter(7, NOW)).toBe(7000)
    expect(parseRetryAfter(new Date(NOW + 12_000).toUTCString(), NOW)).toBe(
      12_000,
    )
    expect(parseRetryAfter(new Date(NOW - 12_000).toUTCString(), NOW)).toBe(0)
    for (const bad of [
      "soon",
      "-5",
      "2024-01-01",
      "",
      "1e3",
      null,
      undefined,
      -1,
    ])
      expect(parseRetryAfter(bad, NOW)).toBeUndefined()
  })
})

const policy = DEFAULT_LIMITS.retry
const delay = (retry: number, hintMs: number | undefined, random = half) =>
  backoffDelay(policy, retry, { hintMs, random })

describe("backoff", () => {
  test("fallback schedule with equal jitter; a hint wins when longer, never shorter", () => {
    expect([0, 1, 2, 3, 4].map((n) => delay(n, undefined))).toEqual([
      2000, 4000, 8000, 16_000, 16_000,
    ])
    expect(delay(0, undefined, () => 0)).toBe(1500)
    expect(delay(0, undefined, () => 0.999_999)).toBe(2500)
    // Retry-After 3 s: 3 s plus 0–250 ms (none at 0.5), not the 2 s fallback.
    expect(delay(0, 3000)).toBe(3000)
    expect(delay(0, 3000, () => 0)).toBe(3250)
    // Retry-After 0: the fallback still applies.
    expect(delay(0, 0)).toBe(2000)
  })

  test("the shared cool-down is the hint, else the fallback's jitter floor", () => {
    expect(cooldownFor(policy, 0, 5000)).toBe(5000)
    expect(cooldownFor(policy, 1, undefined)).toBe(3000)
  })
})

describe("resolveLimits", () => {
  test("defaults ← manifest ← options, merging lanes and retry per key", () => {
    const limits = resolveLimits([
      { maxConcurrency: 6, lanes: { teams: { maxConcurrency: 2 } } },
      {
        lanes: { teams: { minIntervalMs: 500 } },
        retry: { budgetMs: 10_000 },
      },
    ])
    expect(limits.maxConcurrency).toBe(6)
    expect(limits.lanes).toEqual({
      teams: { maxConcurrency: 2, minIntervalMs: 500 },
    })
    expect(limits.retry).toEqual({ ...DEFAULT_LIMITS.retry, budgetMs: 10_000 })
  })

  test("`retryDelaysMs` sets the fallback and, unless given, the attempts", () => {
    expect(resolveLimits([], [10]).retry).toMatchObject({
      attempts: 2,
      fallbackDelaysMs: [10],
    })
    expect(
      resolveLimits([{ retry: { attempts: 4 } }], [10]).retry.attempts,
    ).toBe(4)
    expect(resolveLimits([{ minConcurrency: 9 }]).minConcurrency).toBe(4)
  })
})
