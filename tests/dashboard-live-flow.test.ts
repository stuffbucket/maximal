import { describe, expect, test } from "bun:test"

import type { FlowPalette } from "../shell/src/dashboard/live/flow-types"
import type { SessionsResponse } from "../src/lib/token-usage/sessions-schema"

import { liveFlowSnapshot } from "../shell/src/dashboard/live/flow-plan"

const palette: FlowPalette = {
  surface: "white",
  text: "black",
  muted: "gray",
  border: "gray",
  input: "teal",
  output: "blue",
  cacheRead: "purple",
  cacheWrite: "pink",
  fontFamily: "sans-serif",
  labelFontSize: 14,
  detailFontSize: 12,
  labelFontWeight: "500",
  particleScaleTemplate: "1 particle ≈ __RATE__ tokens/s",
}

function view(): SessionsResponse {
  return {
    flow_per_min: 1_000,
    sessions: [
      {
        id: "session-a",
        client: "claude-code",
        client_label: "Laptop",
        model: "claude-sonnet-4-5",
        state: "streaming",
        rate_per_min: 600,
        rates: {
          input_per_min: 200,
          output_per_min: 200,
          cache_read_per_min: 100,
          cache_write_per_min: 100,
          total_per_min: 600,
        },
        model_rates: [
          {
            model: "claude-sonnet-4-5",
            input_per_min: 200,
            output_per_min: 200,
            cache_read_per_min: 100,
            cache_write_per_min: 100,
            total_per_min: 600,
          },
        ],
        last_request_at_ms: 2,
        cache: { last_cache_read_tokens: 200 },
      },
      {
        id: "session-b",
        client: "codex",
        client_label: null,
        model: "gpt-5-codex",
        state: "warm",
        rate_per_min: 400,
        rates: {
          input_per_min: 240,
          output_per_min: 160,
          cache_read_per_min: 0,
          cache_write_per_min: 0,
          total_per_min: 400,
        },
        model_rates: [
          {
            model: "gpt-5-codex",
            input_per_min: 240,
            output_per_min: 160,
            cache_read_per_min: 0,
            cache_write_per_min: 0,
            total_per_min: 400,
          },
        ],
        last_request_at_ms: 1,
        cache: { last_cache_read_tokens: 0 },
      },
    ],
  } as unknown as SessionsResponse
}

describe("liveFlowSnapshot", () => {
  test("arranges models and sessions with directional and cache traffic", () => {
    const result = liveFlowSnapshot(view(), null, palette, false, false)

    expect(result.totalRate).toBe(1_000)
    expect(result.nodes.filter((node) => node.kind === "model")).toHaveLength(2)
    expect(result.nodes.filter((node) => node.kind === "session")).toHaveLength(
      2,
    )
    expect(new Set(result.edges.map((edge) => edge.kind))).toEqual(
      new Set(["input", "output", "cache-read", "cache-write"]),
    )
    expect(result.nodes.some((node) => node.kind === "tool")).toBe(false)
  })

  test("adds distinct illustrative WebFetch and WebSearch endpoints on request", () => {
    const result = liveFlowSnapshot(view(), null, palette, false, true)
    const tools = result.nodes
      .filter((node) => node.kind === "tool")
      .map((node) => node.label)

    expect(tools).toEqual(["Web fetch", "Web search"])
    expect(result.edges.some((edge) => edge.from === "tool:web-fetch")).toBe(
      true,
    )
    expect(result.edges.some((edge) => edge.to === "tool:web-search")).toBe(
      true,
    )
  })

  test("carries visible selection and reduced-motion state to the worker", () => {
    const result = liveFlowSnapshot(view(), "session-a", palette, true, false)

    expect(result.selectedSessionId).toBe("session-a")
    expect(result.reducedMotion).toBe(true)
  })

  test("drops a selection that has no visible graph node", () => {
    const result = liveFlowSnapshot(
      view(),
      "cold-session",
      palette,
      false,
      false,
    )

    expect(result.selectedSessionId).toBeNull()
  })
})
