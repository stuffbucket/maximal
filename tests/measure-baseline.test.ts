import { describe, expect, it } from "bun:test"

import {
  assessCaching,
  assessCostVisibility,
  extractStreamCacheRead,
  median,
  normalizeUsage,
  parseArgs,
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
    })
  })

  it("falls back to defaults when flags are omitted", () => {
    const args = parseArgs([])
    expect(args.label).toBe("unlabeled")
    expect(args.baseUrl).toBe("http://127.0.0.1:4141")
    expect(args.model).toBe("gpt-5-mini")
    expect(args.cacheGapMs).toBe(3000)
  })
})
