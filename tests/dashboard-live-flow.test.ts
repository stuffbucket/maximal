import { describe, expect, test } from "bun:test"

import type {
  FlowEdge,
  FlowPalette,
} from "../shell/src/dashboard/live/flow-types"
import type { SessionsResponse } from "../src/lib/token-usage/sessions-schema"

import {
  liveFlowSnapshot,
  observeFlowDeltas,
} from "../shell/src/dashboard/live/flow-plan"

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
  locale: "en",
}

const observedEdges = (a: number, b: number): Array<FlowEdge> => [
  {
    id: "a",
    from: "session:a",
    to: "model:a",
    kind: "input",
    rate: 10,
    observedTokens: a,
  },
  {
    id: "b",
    from: "model:b",
    to: "session:b",
    kind: "output",
    rate: 20,
    observedTokens: b,
  },
]

const observedEdge = (observedTokens?: number): Array<FlowEdge> => [
  {
    id: "edge",
    from: "session:a",
    to: "model:a",
    kind: "input",
    rate: 10,
    observedTokens,
  },
]

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
        token_totals: {
          input_tokens: 1_000,
          output_tokens: 800,
          cache_read_tokens: 500,
          cache_write_tokens: 200,
          total_tokens: 2_500,
        },
        model_token_totals: [
          {
            model: "claude-sonnet-4-5",
            input_tokens: 1_000,
            output_tokens: 800,
            cache_read_tokens: 500,
            cache_write_tokens: 200,
            total_tokens: 2_500,
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
        token_totals: {
          input_tokens: 400,
          output_tokens: 200,
          cache_read_tokens: 0,
          cache_write_tokens: 0,
          total_tokens: 600,
        },
        model_token_totals: [
          {
            model: "gpt-5-codex",
            input_tokens: 400,
            output_tokens: 200,
            cache_read_tokens: 0,
            cache_write_tokens: 0,
            total_tokens: 600,
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

  test("carries cumulative observations onto their matching directional edges", () => {
    const result = liveFlowSnapshot(view(), null, palette, false, false)
    const session = "session:session-a"
    const observed = Object.fromEntries(
      result.edges
        .filter((edge) => edge.from === session || edge.to === session)
        .map((edge) => [
          edge.kind,
          (edge as FlowEdge & { observedTokens?: number }).observedTokens,
        ]),
    )

    expect(observed).toEqual({
      input: 1_000,
      output: 800,
      "cache-read": 500,
      "cache-write": 200,
    })
  })

  test("keeps cumulative observations when hidden sessions are aggregated", () => {
    const source = view().sessions[0]
    const sessions = Array.from({ length: 7 }, (_, index) => {
      const output = (index + 1) * 10
      const rate = 700 - index
      return {
        ...source,
        id: `session-${index}`,
        rate_per_min: rate,
        rates: {
          input_per_min: 0,
          output_per_min: rate,
          cache_read_per_min: 0,
          cache_write_per_min: 0,
          total_per_min: rate,
        },
        model_rates: [
          {
            model: source.model,
            input_per_min: 0,
            output_per_min: rate,
            cache_read_per_min: 0,
            cache_write_per_min: 0,
            total_per_min: rate,
          },
        ],
        token_totals: {
          input_tokens: 0,
          output_tokens: output,
          cache_read_tokens: 0,
          cache_write_tokens: 0,
          total_tokens: output,
        },
        model_token_totals: [
          {
            model: source.model,
            input_tokens: 0,
            output_tokens: output,
            cache_read_tokens: 0,
            cache_write_tokens: 0,
            total_tokens: output,
          },
        ],
        last_request_at_ms: 100 - index,
      }
    })
    const result = liveFlowSnapshot(
      { flow_per_min: 0, sessions },
      null,
      palette,
      false,
      false,
    )
    const aggregate = result.edges.find(
      (edge) => edge.to === "aggregate:sessions" && edge.kind === "output",
    )

    expect(aggregate?.observedTokens).toBe(70)
  })

  test("baselines observations, then emits only positive deltas", () => {
    const baseline = observeFlowDeltas(null, observedEdges(10, 20), 4)
    expect(baseline.emissions).toEqual([])

    const changed = observeFlowDeltas(
      baseline.observations,
      observedEdges(14, 28),
      4,
    )
    expect(changed.emissions).toEqual([
      { edgeId: "a", count: 1 },
      { edgeId: "b", count: 3 },
    ])
    expect(changed.tokensPerParticle).toBe(3)

    const unchanged = observeFlowDeltas(
      changed.observations,
      observedEdges(14, 28),
      4,
    )
    expect(unchanged.emissions).toEqual([])
    expect(unchanged.tokensPerParticle).toBeNull()
  })

  test("leaves older payloads static and treats a counter decrease as a new baseline", () => {
    const oldPayload = observeFlowDeltas(null, observedEdge())
    expect(
      observeFlowDeltas(oldPayload.observations, observedEdge()).emissions,
    ).toEqual([])

    const baseline = observeFlowDeltas(null, observedEdge(100))
    const reset = observeFlowDeltas(baseline.observations, observedEdge(10))
    expect(reset.emissions).toEqual([])
    expect(
      observeFlowDeltas(reset.observations, observedEdge(15)).emissions,
    ).toEqual([{ edgeId: "edge", count: 5 }])
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
