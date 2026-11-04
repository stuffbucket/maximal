import { describe, expect, test } from "bun:test"
import { collectMaximalSample, type FetchLike } from "../src/maximal"
import { monitorMaximal } from "../src/monitor"

const statusPayload = {
  service: "maximal",
  status: "ok",
  subsystems: {
    copilot: { ready: true },
    mcp_broker: { state: "ready" },
  },
}

const session = (
  id: string,
  lastRequestAtMs: number,
  usedTokens = 100_000,
) => ({
  id,
  client: "claude-code",
  model: "claude-opus-5-5",
  last_request_at_ms: lastRequestAtMs,
  request_count: 12,
  context: {
    used_tokens: usedTokens,
    window_tokens: 1_000_000,
    ceiling_tokens: 922_000,
    compacted_at_ms: 123,
  },
  token_totals: {
    total_tokens: 400_000,
    cache_read_tokens: 360_000,
  },
})

const jsonResponse = (value: unknown): Response => Response.json(value)

describe("read-only Maximal collection", () => {
  test("selects the latest matching session and maps the effective limit", async () => {
    const requests: Array<{ method: string | undefined; url: string }> = []
    const fetcher: FetchLike = async (input, init) => {
      const url = input.toString()
      requests.push({ method: init?.method, url })
      if (url.endsWith("/status")) return jsonResponse(statusPayload)
      return jsonResponse({
        sessions: [session("older", 100), session("newer", 200)],
      })
    }

    const result = await collectMaximalSample({
      baseUrl: "http://127.0.0.1:4141",
      sampledAtMs: Date.UTC(2026, 10, 3),
      fetcher,
    })

    expect(result.sessionId).toBe("newer")
    expect(result.contextLimit).toBe(922_000)
    expect(result.compactedAtMs).toBe(123)
    expect(requests).toHaveLength(2)
    expect(requests.every(({ method }) => method === "GET")).toBe(true)
  })

  test("uses a locale-independent session ID activity tie breaker", async () => {
    const fetcher: FetchLike = async (input) =>
      input.toString().endsWith("/status") ?
        jsonResponse(statusPayload)
      : jsonResponse({ sessions: [session("a-session", 200), session("Z-session", 200)] })

    const result = await collectMaximalSample({
      baseUrl: "http://127.0.0.1:4141",
      sampledAtMs: 0,
      fetcher,
    })

    expect(result.sessionId).toBe("Z-session")
  })

  test("pins the selected session across monitor samples", async () => {
    const selectedResponses = [
      [session("target", 100)],
      [session("other", 300), session("target", 100, 120_000)],
      [session("other", 400), session("target", 100, 140_000)],
    ]
    let sessionsRequest = 0
    const fetcher: FetchLike = async (input) => {
      if (input.toString().endsWith("/status")) {
        return jsonResponse(statusPayload)
      }
      const sessions = selectedResponses[sessionsRequest]
      sessionsRequest += 1
      return jsonResponse({ sessions })
    }
    const nowValues = [0, 60_000, 120_000]
    const sleeps: number[] = []

    const recording = await monitorMaximal({
      baseUrl: "http://127.0.0.1:4141",
      sampleCount: 3,
      intervalMs: 60_000,
      fetcher,
      now: () => nowValues.shift() ?? 120_000,
      sleep: async (durationMs) => {
        sleeps.push(durationMs)
      },
    })

    expect(recording.samples.map(({ sessionId }) => sessionId)).toEqual([
      "target",
      "target",
      "target",
    ])
    expect(recording.samples.map(({ contextTokens }) => contextTokens)).toEqual([
      100_000,
      120_000,
      140_000,
    ])
    expect(sleeps).toEqual([60_000, 60_000])
  })

  test("keeps pinned identity when session metrics are temporarily unavailable", async () => {
    const fetcher: FetchLike = async (input) => {
      if (input.toString().endsWith("/status")) {
        return jsonResponse(statusPayload)
      }
      throw new Error("sessions unavailable")
    }

    const result = await collectMaximalSample({
      baseUrl: "http://127.0.0.1:4141",
      sampledAtMs: 60_000,
      sessionId: "target",
      fetcher,
    })

    expect(result.sessionId).toBe("target")
    expect(result.serviceStatus).toBe("ok")
    expect(result.contextTokens).toBeNull()
    expect(result.totalTokens).toBeNull()
  })

  test("reports unreachable health while preserving available session metrics", async () => {
    const fetcher: FetchLike = async (input) => {
      if (input.toString().endsWith("/status")) {
        throw new Error("status unavailable")
      }
      return jsonResponse({ sessions: [session("target", 100)] })
    }

    const result = await collectMaximalSample({
      baseUrl: "http://127.0.0.1:4141",
      sampledAtMs: 60_000,
      fetcher,
    })

    expect(result.sessionId).toBe("target")
    expect(result.serviceStatus).toBe("unreachable")
    expect(result.contextTokens).toBe(100_000)
  })

  test("records broker state without treating it as session health", async () => {
    const fetcher: FetchLike = async (input) =>
      input.toString().endsWith("/status") ?
        jsonResponse({
          ...statusPayload,
          subsystems: {
            ...statusPayload.subsystems,
            mcp_broker: { state: "starting" },
          },
        })
      : jsonResponse({ sessions: [session("target", 100)] })

    const result = await collectMaximalSample({
      baseUrl: "http://127.0.0.1:4141",
      sampledAtMs: 60_000,
      fetcher,
    })

    expect(result.serviceStatus).toBe("ok")
    expect(result.mcpBrokerState).toBe("starting")
  })
})
