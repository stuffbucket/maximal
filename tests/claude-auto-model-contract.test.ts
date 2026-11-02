import { describe, expect, test } from "bun:test"

import {
  ClaudeAutoModelsState,
  ClaudeAutoModelsUpdateRequest,
} from "~/lib/config/settings-types"

const option = {
  id: "gpt-5.6-mini",
  name: "GPT 5.6 Mini",
  vendor: "OpenAI",
  preview: false,
}

const automatic = {
  configured: null,
  effective: option.id,
  source: "automatic" as const,
  status: "ready" as const,
  reason: "small-gpt" as const,
}

const unavailable = {
  configured: "gpt-retired",
  effective: null,
  source: "maximal-override" as const,
  status: "unavailable" as const,
  reason: "override-unavailable" as const,
}

const unresolved = {
  configured: null,
  effective: null,
  source: "none" as const,
  status: "unresolved" as const,
  reason: "no-match" as const,
}

describe("ClaudeAutoModelsState", () => {
  test("accepts ready, unavailable, and unresolved tier states", () => {
    const state = {
      applied: true,
      options: [option],
      fast: automatic,
      capable: unavailable,
    }
    expect(ClaudeAutoModelsState.parse(state)).toEqual(state)
    expect(
      ClaudeAutoModelsState.parse({
        ...state,
        applied: false,
        capable: unresolved,
      }),
    ).toEqual({ ...state, applied: false, capable: unresolved })
  })

  test("rejects contradictory tier state combinations", () => {
    expect(
      ClaudeAutoModelsState.safeParse({
        applied: true,
        options: [option],
        fast: {
          configured: null,
          effective: option.id,
          source: "automatic",
          status: "unavailable",
          reason: "override",
        },
        capable: automatic,
      }).success,
    ).toBe(false)
  })

  test.each([
    ["source", "other"],
    ["status", "missing"],
    ["reason", "fastest"],
  ])("rejects an unknown tier %s", (key, value) => {
    expect(
      ClaudeAutoModelsState.safeParse({
        applied: true,
        options: [option],
        fast: { ...automatic, [key]: value },
        capable: automatic,
      }).success,
    ).toBe(false)
  })
})

describe("ClaudeAutoModelsUpdateRequest", () => {
  test("accepts a partial explicit id or null for Automatic", () => {
    expect(ClaudeAutoModelsUpdateRequest.parse({ fast: option.id })).toEqual({
      fast: option.id,
    })
    expect(ClaudeAutoModelsUpdateRequest.parse({ capable: null })).toEqual({
      capable: null,
    })
  })

  test.each([
    {},
    { fast: "", capable: null },
    { fast: null, capable: 42 },
    { fast: null, capable: null, extra: true },
  ])("rejects malformed update body %#", (body) => {
    expect(ClaudeAutoModelsUpdateRequest.safeParse(body).success).toBe(false)
  })
})
