import { describe, expect, it } from "bun:test"

import {
  assessCaching,
  assessCostVisibility,
  assessDelta,
  extractStreamCacheRead,
  mannWhitneyU,
  mean,
  median,
  normalCdf,
  normalizeUsage,
  parseArgs,
  percentile,
  stdev,
  summarizeSamples,
} from "../scripts/dev/measure-baseline"

describe("normalizeUsage", () => {
  it("coerces present numeric fields", () => {
    expect(
      normalizeUsage({
        input_tokens: 10,
        output_tokens: 5,
        cache_read_input_tokens: 3,
      }),
    ).toEqual({
      input_tokens: 10,
      output_tokens: 5,
      cache_read_input_tokens: 3,
    })
  })

  it("defaults missing / non-finite fields to 0", () => {
    expect(normalizeUsage(undefined)).toEqual({
      input_tokens: 0,
      output_tokens: 0,
      cache_read_input_tokens: 0,
    })
    expect(
      normalizeUsage({ input_tokens: Number.NaN, output_tokens: 7 }),
    ).toEqual({
      input_tokens: 0,
      output_tokens: 7,
      cache_read_input_tokens: 0,
    })
  })
})

describe("extractStreamCacheRead", () => {
  it("takes the max cache_read across message_start and message_delta", () => {
    const sse = [
      "event: message_start",
      'data: {"usage":{"input_tokens":100,"cache_read_input_tokens":0}}',
      "event: message_delta",
      'data: {"usage":{"cache_read_input_tokens":19968}}',
    ].join("\n")
    expect(extractStreamCacheRead(sse)).toBe(19968)
  })

  it("returns 0 when no usage is present", () => {
    expect(extractStreamCacheRead("event: ping\ndata: {}\n")).toBe(0)
  })

  it("tolerates whitespace variations in the JSON", () => {
    expect(extractStreamCacheRead('{"cache_read_input_tokens" : 42 }')).toBe(42)
  })
})

describe("assessCaching", () => {
  it("reports reuse when the second read jumps well past the first", () => {
    expect(
      assessCaching({ firstCacheRead: 0, secondCacheRead: 19968 }),
    ).toEqual({ reused: true, delta: 19968 })
  })

  it("does not count a cold second request as reuse", () => {
    expect(assessCaching({ firstCacheRead: 0, secondCacheRead: 0 })).toEqual({
      reused: false,
      delta: 0,
    })
  })

  it("requires a margin so tiny noise is not a hit", () => {
    expect(
      assessCaching({ firstCacheRead: 0, secondCacheRead: 50 }).reused,
    ).toBe(false)
  })
})

describe("assessCostVisibility", () => {
  it("flags absent field as not surfaced (baseline)", () => {
    const summary = { totals: { input_tokens: 5, total_tokens: 5 } }
    expect(assessCostVisibility(summary)).toEqual({
      fieldPresent: false,
      captured: false,
      value: null,
    })
  })

  it("field present but zero → surfaced, nothing captured", () => {
    expect(assessCostVisibility({ totals: { total_nano_aiu: 0 } })).toEqual({
      fieldPresent: true,
      captured: false,
      value: 0,
    })
  })

  it("field present and positive → captured", () => {
    expect(assessCostVisibility({ totals: { total_nano_aiu: 1234 } })).toEqual({
      fieldPresent: true,
      captured: true,
      value: 1234,
    })
  })

  it("handles a malformed summary defensively", () => {
    expect(assessCostVisibility(null)).toEqual({
      fieldPresent: false,
      captured: false,
      value: null,
    })
    expect(assessCostVisibility({ totals: "nope" }).fieldPresent).toBe(false)
  })
})

describe("median", () => {
  it("returns the middle of an odd-length list", () => {
    expect(median([30, 10, 20])).toBe(20)
  })

  it("averages the two middles of an even-length list", () => {
    expect(median([10, 20, 30, 40])).toBe(25)
  })

  it("returns null for an empty list", () => {
    expect(median([])).toBeNull()
  })
})

describe("parseArgs", () => {
  it("reads label, base-url, model, cache-gap-ms flags", () => {
    const args = parseArgs([
      "--label",
      "before",
      "--base-url",
      "http://127.0.0.1:4142/",
      "--model",
      "gpt-5.4",
      "--cache-gap-ms",
      "0",
    ])
    expect(args).toEqual({
      label: "before",
      baseUrl: "http://127.0.0.1:4142",
      model: "gpt-5.4",
      cacheGapMs: 0,
      samples: 8,
      discard: 1,
      compareUrl: null,
    })
  })

  it("falls back to defaults when flags are omitted", () => {
    const args = parseArgs([])
    expect(args.label).toBe("unlabeled")
    expect(args.baseUrl).toBe("http://127.0.0.1:4141")
    expect(args.model).toBe("gpt-5-mini")
    expect(args.cacheGapMs).toBe(3000)
    expect(args.samples).toBe(8)
    expect(args.discard).toBe(1)
    expect(args.compareUrl).toBeNull()
  })

  it("reads --samples, --discard, and --compare (trailing slash trimmed)", () => {
    const args = parseArgs([
      "--samples",
      "20",
      "--discard",
      "2",
      "--compare",
      "http://127.0.0.1:4142/",
    ])
    expect(args.samples).toBe(20)
    expect(args.discard).toBe(2)
    expect(args.compareUrl).toBe("http://127.0.0.1:4142")
  })

  it("clamps nonsensical samples/discard to safe minimums", () => {
    const args = parseArgs(["--samples", "0", "--discard", "-5"])
    expect(args.samples).toBe(1)
    expect(args.discard).toBe(0)
  })
})

describe("percentile / mean / stdev", () => {
  it("interpolates percentiles", () => {
    expect(percentile([10, 20, 30, 40], 50)).toBe(25)
    expect(percentile([10, 20, 30, 40], 0)).toBe(10)
    expect(percentile([10, 20, 30, 40], 100)).toBe(40)
    expect(percentile([], 50)).toBeNull()
    expect(percentile([42], 90)).toBe(42)
  })

  it("computes mean and sample stdev", () => {
    expect(mean([2, 4, 6])).toBe(4)
    expect(mean([])).toBeNull()
    // sample stdev of [2,4,6] = 2
    expect(stdev([2, 4, 6])).toBeCloseTo(2, 6)
    expect(stdev([5])).toBeNull()
  })
})

describe("summarizeSamples", () => {
  it("reports dispersion and rounds", () => {
    const s = summarizeSamples([100, 200, 300, 400, 500])
    expect(s.n).toBe(5)
    expect(s.min).toBe(100)
    expect(s.max).toBe(500)
    expect(s.p50).toBe(300)
    expect(s.mean).toBe(300)
    expect(typeof s.stdev).toBe("number")
  })

  it("handles empty input", () => {
    expect(summarizeSamples([])).toEqual({
      n: 0,
      min: null,
      p50: null,
      p90: null,
      max: null,
      mean: null,
      stdev: null,
    })
  })
})

describe("normalCdf", () => {
  it("is ~0.5 at 0 and monotonic", () => {
    expect(normalCdf(0)).toBeCloseTo(0.5, 2)
    expect(normalCdf(1.96)).toBeCloseTo(0.975, 2)
    expect(normalCdf(-1.96)).toBeCloseTo(0.025, 2)
  })
})

describe("mannWhitneyU", () => {
  it("returns p≈1 for identical distributions", () => {
    const { p } = mannWhitneyU([1, 2, 3, 4], [1, 2, 3, 4])
    expect(p).toBeGreaterThan(0.9)
  })

  it("detects a clear separation with enough samples", () => {
    const a = [100, 105, 110, 108, 102, 107, 103, 106]
    const b = [300, 305, 310, 308, 302, 307, 303, 306]
    const { p } = mannWhitneyU(a, b)
    expect(p).toBeLessThan(0.01)
  })

  it("handles an empty group", () => {
    expect(mannWhitneyU([], [1, 2, 3])).toEqual({ u: 0, p: 1 })
  })
})

describe("assessDelta", () => {
  it("is inconclusive below the sample threshold", () => {
    const r = assessDelta([100, 200], [300, 400], { minN: 8 })
    expect(r.significant).toBeNull()
    expect(r.note).toContain("too few samples")
  })

  it("flags a real, large delta as significant", () => {
    const a = [100, 105, 110, 108, 102, 107, 103, 106]
    const b = [300, 305, 310, 308, 302, 307, 303, 306]
    const r = assessDelta(a, b, { minN: 8 })
    expect(r.significant).toBe(true)
    expect(r.medianDeltaMs).toBeGreaterThan(150)
    expect(r.pctChange).toBeGreaterThan(100)
  })

  it("flags an overlapping delta as not significant", () => {
    const a = [100, 120, 140, 110, 130, 105, 125, 115]
    const b = [110, 125, 135, 118, 128, 112, 122, 120]
    const r = assessDelta(a, b, { minN: 8 })
    expect(r.significant).toBe(false)
    expect(r.note).toContain("within noise")
  })

  it("returns nulls for empty input", () => {
    const r = assessDelta([], [1, 2, 3])
    expect(r.medianDeltaMs).toBeNull()
    expect(r.significant).toBeNull()
  })
})
