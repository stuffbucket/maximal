/**
 * `pricedModelIsPaid` is the paid/free interpreter for Copilot's per-model
 * `token_prices` (ADR-0016, divergence 1). Since the 2026-06-01 per-token
 * billing change, `token_prices` is the PRIMARY pricing signal; the legacy
 * `is_premium` flag is only a fallback when `token_prices` is absent.
 *
 * These tests pin the contract the token-usage recorder relies on:
 *   - any advertised non-zero rate ⇒ paid (true);
 *   - present-but-all-zero ⇒ free (false);
 *   - absent / empty / non-numeric ⇒ unknown (null → caller falls back).
 *
 * Encoded unit assumption: we read presence + sign only, never magnitude, so
 * the per-token-vs-per-1M question does not change any result here. If that
 * ever stops being true, this file is where the assumption breaks first.
 */

import { describe, expect, test } from "bun:test"

import type { TokenPrices } from "~/services/copilot/get-models"

import { pricedModelIsPaid } from "~/services/copilot/get-models"

describe("pricedModelIsPaid", () => {
  test("a positive input rate marks the model paid", () => {
    // gpt-5-mini shape from ADR-0016: cheap but NOT free.
    const prices: TokenPrices = {
      input: 0.25,
      output: 2.0,
      cache_read: 0.025,
      cache_write: 0.3,
    }
    expect(pricedModelIsPaid(prices)).toBe(true)
  })

  test("any single non-zero rate is enough to be paid", () => {
    expect(pricedModelIsPaid({ input: 0, output: 0, cache_read: 0.01 })).toBe(
      true,
    )
  })

  test("present-but-all-zero rates read as free", () => {
    expect(
      pricedModelIsPaid({ input: 0, output: 0, cache_read: 0, cache_write: 0 }),
    ).toBe(false)
  })

  test("magnitude does not matter — a per-token rate still reads paid", () => {
    // Whether the unit is per-1M ($2.00) or per-token (0.000002), any positive
    // rate is paid. This is the encoded unit-agnostic assumption.
    expect(pricedModelIsPaid({ output: 0.000002 })).toBe(true)
  })

  test("absent / empty / non-numeric token_prices is unknown (null)", () => {
    expect(pricedModelIsPaid(undefined)).toBeNull()
    expect(pricedModelIsPaid(null)).toBeNull()
    expect(pricedModelIsPaid({})).toBeNull()
    // Non-finite / non-numeric values are ignored; an all-garbage object is
    // indistinguishable from "no rates advertised".
    expect(pricedModelIsPaid({ input: Number.NaN })).toBeNull()
  })

  test("tolerates extra/renamed keys via the index signature", () => {
    expect(pricedModelIsPaid({ some_future_rate: 5 })).toBe(true)
  })
})
