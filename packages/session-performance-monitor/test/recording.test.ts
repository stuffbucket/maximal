import { describe, expect, test } from "bun:test"
import { DEFAULT_POLICY } from "../src/analyze"
import { parsePolicy, parseRecording } from "../src/recording"
import type { SessionSample } from "../src/types"

const sample = (index: number): SessionSample => ({
  sampledAt: new Date(Date.UTC(2026, 10, 3, 12, index)).toISOString(),
  sessionId: "session-1",
  client: "claude-code",
  model: "claude-opus-5-5",
  serviceStatus: "ok",
  copilotReady: true,
  mcpBrokerState: "ready",
  contextTokens: 500_000,
  contextLimit: 1_000_000,
  compactedAtMs: null,
  requestCount: 10 + index,
  totalTokens: 100_000 + index * 10_000,
  cacheReadTokens: 90_000 + index * 9_000,
})

const recordedPolicy = {
  ...DEFAULT_POLICY,
  contextWatchRatio: 0.3,
  contextActionRatio: 0.4,
}

const recording = {
  schemaVersion: 1,
  source: "http://127.0.0.1:4141",
  policy: recordedPolicy,
  samples: [sample(0), sample(1), sample(2)],
  report: {},
}

describe("recording replay", () => {
  test("uses the recorded policy unless an override is supplied", () => {
    const replay = parseRecording(recording, "file://recording.json")
    const overridden = parseRecording(
      recording,
      "file://recording.json",
      DEFAULT_POLICY,
    )

    expect(replay.policy).toEqual(recordedPolicy)
    expect(replay.report.verdict).toBe("action")
    expect(overridden.report.verdict).toBe("no-change")
  })

  test("rejects samples with missing required health fields", () => {
    const malformed = structuredClone(recording) as Record<string, unknown>
    const samples = malformed.samples as Array<Record<string, unknown>>
    delete samples[0]?.serviceStatus

    expect(() => parseRecording(malformed, "file://recording.json")).toThrow(
      "samples[0].serviceStatus must be ok, degraded, or unreachable",
    )
  })

  test("rejects recordings from an unknown schema version", () => {
    expect(() =>
      parseRecording(
        { ...recording, schemaVersion: 2 },
        "file://recording.json",
      ),
    ).toThrow("recording schemaVersion must be 1")
  })

  test("rejects non-object policies and unknown fields", () => {
    expect(() => parsePolicy([])).toThrow("policy must be an object")
    expect(() => parsePolicy({ minimumSampels: 3 })).toThrow(
      "unknown policy field: minimumSampels",
    )
  })
})
