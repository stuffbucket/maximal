import { describe, expect, test } from "bun:test"
import { analyzeSession } from "../src/analyze"
import type { SessionSample } from "../src/types"

const START = Date.UTC(2026, 10, 3, 12)

const sample = (
  index: number,
  overrides: Partial<SessionSample> = {},
): SessionSample => ({
  sampledAt: new Date(START + index * 60_000).toISOString(),
  sessionId: "session-1",
  client: "claude-code",
  model: "claude-opus-5-5",
  serviceStatus: "ok",
  copilotReady: true,
  mcpBrokerState: "ready",
  contextTokens: 45_000 + index * 11_000,
  contextLimit: 922_000,
  compactedAtMs: null,
  requestCount: 600 + index * 10,
  totalTokens: 1_000_000 + index * 700_000,
  cacheReadTokens: 900_000 + index * 644_000,
  ...overrides,
})

describe("deterministic session analysis", () => {
  test("does not recommend a change for healthy low-context cached traffic", () => {
    const report = analyzeSession(
      Array.from({ length: 8 }, (_, index) => sample(index)),
    )

    expect(report.verdict).toBe("no-change")
    expect(report.metrics.contextRatio).toBeCloseTo(122_000 / 922_000)
    expect(report.metrics.cacheReadShare).toBeCloseTo(0.92)
    expect(report.metrics.contextGrowthTokensPerMinute).toBeCloseTo(11_000)
    expect(report.recommendations).toEqual([])
  })

  test("watches context at the existing 75 percent warning threshold", () => {
    const report = analyzeSession([
      sample(0),
      sample(1),
      sample(2, { contextTokens: 700_000 }),
    ])

    expect(report.verdict).toBe("watch")
    expect(report.recommendations).toEqual([])
  })

  test("recommends compaction at the existing 90 percent critical threshold", () => {
    const report = analyzeSession([
      sample(0),
      sample(1),
      sample(2, { contextTokens: 830_000 }),
    ])

    expect(report.verdict).toBe("action")
    expect(report.recommendations.map(({ code }) => code)).toEqual([
      "compact-now",
    ])
  })

  test("produces the same report when recorded samples are replayed out of order", () => {
    const samples = [
      sample(0),
      sample(1),
      sample(1, {
        contextTokens: 90_000,
        requestCount: 625,
        totalTokens: 2_500_000,
        cacheReadTokens: 2_250_000,
      }),
    ]

    expect(analyzeSession([...samples].reverse())).toEqual(
      analyzeSession(samples),
    )
  })

  test("recommends a fresh session after two reported compactions", () => {
    const report = analyzeSession([
      sample(0),
      sample(1, { compactedAtMs: START + 30_000, contextTokens: 30_000 }),
      sample(2, { compactedAtMs: START + 30_000, contextTokens: 40_000 }),
      sample(3, { compactedAtMs: START + 150_000, contextTokens: 25_000 }),
    ])

    expect(report.metrics.compactionCount).toBe(2)
    expect(report.recommendations.map(({ code }) => code)).toEqual([
      "start-fresh-session",
    ])
  })

  test("requires consecutive health failures before recommending investigation", () => {
    const report = analyzeSession([
      sample(0),
      sample(1, { copilotReady: false, serviceStatus: "degraded" }),
      sample(2, { copilotReady: false, serviceStatus: "degraded" }),
    ])

    expect(report.metrics.trailingHealthFailures).toBe(2)
    expect(report.recommendations[0]?.code).toBe(
      "investigate-service-health",
    )
    expect(report.recommendations[0]?.severity).toBe("critical")
  })

  test("returns insufficient data instead of a stable no-change verdict", () => {
    const report = analyzeSession([sample(0)])

    expect(report.verdict).toBe("insufficient-data")
    expect(report.recommendations).toEqual([])
  })

  test("does not treat repeated metric collection gaps as no change", () => {
    const missingMetrics = {
      model: "unknown",
      contextTokens: null,
      contextLimit: null,
      compactedAtMs: null,
      requestCount: null,
      totalTokens: null,
      cacheReadTokens: null,
    }
    const report = analyzeSession([
      sample(0, missingMetrics),
      sample(1, missingMetrics),
      sample(2, missingMetrics),
    ])

    expect(report.verdict).toBe("insufficient-data")
    expect(report.observations).toContain(
      "0 samples include session metrics; 3 are required for a stable no-change verdict.",
    )
  })

  test("does not report stale metrics as current after collection gaps", () => {
    const missingMetrics = {
      model: "unknown",
      contextTokens: null,
      contextLimit: null,
      compactedAtMs: null,
      requestCount: null,
      totalTokens: null,
      cacheReadTokens: null,
    }
    const report = analyzeSession([
      sample(0),
      sample(1),
      sample(2),
      ...Array.from({ length: 5 }, (_, index) =>
        sample(index + 3, missingMetrics),
      ),
    ])

    expect(report.verdict).toBe("insufficient-data")
    expect(report.metrics.contextRatio).toBeNull()
    expect(report.metrics.tokenThroughputPerMinute).toBeNull()
    expect(report.observations).toContain(
      "The latest sample has no session metrics; performance conclusions are not current.",
    )
  })

  test("uses locale-independent ordering for equal-time samples", () => {
    const report = analyzeSession([
      sample(0, { model: "a-model" }),
      sample(0, { model: "Z-model" }),
      sample(0, { model: "a-model" }),
    ])

    expect(report.model).toBe("a-model")
  })

  test("rejects non-integer policy counts", () => {
    expect(() => analyzeSession([sample(0)], { minimumSamples: 1.5 })).toThrow(
      "minimumSamples must be a positive integer",
    )
  })
})
