/**
 * The relay helpers capability plugins share: usage normalization and the
 * body's model rewrite.
 */
import { describe, expect, test } from "bun:test"

import { plainUsage, responsesUsage, withUpstreamModel } from "../src/relay"

describe("responsesUsage", () => {
  test("splits cached tokens out of the input and keeps the reported total", () => {
    expect(
      responsesUsage({
        input_tokens: 40,
        input_tokens_details: { cached_tokens: 8 },
        output_tokens: 5,
        total_tokens: 45,
      }),
    ).toEqual({
      input_tokens: 32,
      output_tokens: 5,
      cache_read_input_tokens: 8,
      total_tokens: 45,
    })
  })

  test("leaves the total out when the reply has none, and survives a missing or odd usage", () => {
    expect(responsesUsage({ input_tokens: 3, output_tokens: 1 })).toEqual({
      input_tokens: 3,
      output_tokens: 1,
      cache_read_input_tokens: 0,
    })
    expect(responsesUsage(undefined)).toEqual({
      input_tokens: 0,
      output_tokens: 0,
      cache_read_input_tokens: 0,
    })
    expect(responsesUsage("nope")).toEqual(responsesUsage(undefined))
  })

  test("never goes negative or fractional", () => {
    expect(
      responsesUsage({
        input_tokens: 2,
        input_tokens_details: { cached_tokens: 9.7 },
        output_tokens: -4,
      }),
    ).toEqual({
      input_tokens: 0,
      output_tokens: 0,
      cache_read_input_tokens: 9,
    })
  })
})

describe("plainUsage", () => {
  test("keeps input and output as the reply gave them", () => {
    expect(plainUsage({ input_tokens: 30, output_tokens: 4 })).toEqual({
      input_tokens: 30,
      output_tokens: 4,
    })
    expect(plainUsage(null)).toEqual({
      input_tokens: undefined,
      output_tokens: undefined,
    })
  })
})

describe("withUpstreamModel", () => {
  test("returns a body that already names the model as is", () => {
    const body = { model: "m", prompt: "x" }
    expect(withUpstreamModel(body, "m")).toBe(body)
  })

  test("sets the model on a copy of a JSON body", () => {
    const body = { model: "copilot/m", prompt: "x" }
    expect(withUpstreamModel(body, "m")).toEqual({ model: "m", prompt: "x" })
    expect(body.model).toBe("copilot/m")
  })

  test("copies a form with the model replaced, files kept, the original untouched", async () => {
    const form = new FormData()
    form.append("model", "copilot/m")
    form.append("prompt", "x")
    form.append("image[]", new File([new Uint8Array([1, 2])], "a.png"))

    const out = withUpstreamModel(form, "m")

    expect(out).toBeInstanceOf(FormData)
    const copy = out as FormData
    expect(copy.get("model")).toBe("m")
    expect(copy.getAll("model")).toHaveLength(1)
    expect(copy.get("prompt")).toBe("x")
    const file = copy.get("image[]") as File
    expect(file.name).toBe("a.png")
    expect(Array.from(new Uint8Array(await file.arrayBuffer()))).toEqual([1, 2])
    expect(form.get("model")).toBe("copilot/m")
  })

  test("returns a form that already names the model as is", () => {
    const form = new FormData()
    form.append("model", "m")
    expect(withUpstreamModel(form, "m")).toBe(form)
  })
})
