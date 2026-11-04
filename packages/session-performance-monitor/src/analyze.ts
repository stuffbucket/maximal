import type {
  AnalysisReport,
  MonitorPolicy,
  Recommendation,
  SessionSample,
} from "./types"

export const DEFAULT_POLICY: Readonly<MonitorPolicy> = Object.freeze({
  minimumSamples: 3,
  minimumTrendDurationMs: 2 * 60_000,
  contextWatchRatio: 0.75,
  contextActionRatio: 0.9,
  repeatedCompactions: 2,
  consecutiveHealthFailures: 2,
})

const finiteNonNegative = (value: number | null): value is number =>
  value !== null && Number.isFinite(value) && value >= 0

const parseTimestamp = (value: string): number => {
  const timestamp = Date.parse(value)
  if (!Number.isFinite(timestamp)) throw new Error(`Invalid sample time: ${value}`)
  return timestamp
}

const validateRatio = (name: string, value: number): void => {
  if (!Number.isFinite(value) || value <= 0 || value >= 1) {
    throw new Error(`${name} must be greater than 0 and less than 1`)
  }
}

export const resolvePolicy = (
  overrides: Partial<MonitorPolicy> = {},
): MonitorPolicy => {
  const policy = { ...DEFAULT_POLICY, ...overrides }
  if (
    !Number.isFinite(policy.minimumTrendDurationMs)
    || policy.minimumTrendDurationMs <= 0
  ) {
    throw new Error("minimumTrendDurationMs must be greater than 0")
  }
  for (const key of [
    "minimumSamples",
    "repeatedCompactions",
    "consecutiveHealthFailures",
  ] as const) {
    if (!Number.isInteger(policy[key]) || policy[key] <= 0) {
      throw new Error(`${key} must be a positive integer`)
    }
  }
  validateRatio("contextWatchRatio", policy.contextWatchRatio)
  validateRatio("contextActionRatio", policy.contextActionRatio)
  if (policy.contextWatchRatio >= policy.contextActionRatio) {
    throw new Error("contextWatchRatio must be lower than contextActionRatio")
  }
  return policy
}

const sampleCounterDelta = (
  first: number | null,
  last: number | null,
): number | null =>
  finiteNonNegative(first) && finiteNonNegative(last) && last >= first ?
    last - first
  : null

const contextGrowth = (
  samples: readonly SessionSample[],
  minimumDurationMs: number,
): number | null => {
  const points = samples.flatMap((sample) => {
    if (!finiteNonNegative(sample.contextTokens)) return []
    return [{ x: parseTimestamp(sample.sampledAt), y: sample.contextTokens }]
  })
  if (points.length < 2) return null

  const first = points[0]
  const last = points.at(-1)
  if (!first || !last || last.x - first.x < minimumDurationMs) return null

  const origin = first.x
  const normalized = points.map((point) => ({
    x: (point.x - origin) / 60_000,
    y: point.y,
  }))
  const meanX = normalized.reduce((sum, point) => sum + point.x, 0) / normalized.length
  const meanY = normalized.reduce((sum, point) => sum + point.y, 0) / normalized.length
  const numerator = normalized.reduce(
    (sum, point) => sum + (point.x - meanX) * (point.y - meanY),
    0,
  )
  const denominator = normalized.reduce(
    (sum, point) => sum + (point.x - meanX) ** 2,
    0,
  )
  return denominator === 0 ? null : numerator / denominator
}

const trailingHealthFailures = (samples: readonly SessionSample[]): number => {
  let failures = 0
  for (let index = samples.length - 1; index >= 0; index -= 1) {
    const sample = samples[index]
    if (
      sample?.serviceStatus === "ok"
      && sample.copilotReady !== false
    ) {
      break
    }
    failures += 1
  }
  return failures
}

const compareNullableNumbers = (
  left: number | null,
  right: number | null,
): number => (left ?? -1) - (right ?? -1)

const compareStrings = (left: string, right: string): number =>
  left < right ? -1
  : left > right ? 1
  : 0

const compareSamples = (left: SessionSample, right: SessionSample): number => {
  const time = parseTimestamp(left.sampledAt) - parseTimestamp(right.sampledAt)
  if (time !== 0) return time
  for (const comparison of [
    compareNullableNumbers(left.requestCount, right.requestCount),
    compareNullableNumbers(left.totalTokens, right.totalTokens),
    compareNullableNumbers(left.contextTokens, right.contextTokens),
    compareNullableNumbers(left.cacheReadTokens, right.cacheReadTokens),
    compareNullableNumbers(left.compactedAtMs, right.compactedAtMs),
  ]) {
    if (comparison !== 0) return comparison
  }
  return compareStrings(
    JSON.stringify([
      left.client,
      left.model,
      left.serviceStatus,
      left.copilotReady,
      left.mcpBrokerState,
      left.contextLimit,
    ]),
    JSON.stringify([
      right.client,
      right.model,
      right.serviceStatus,
      right.copilotReady,
      right.mcpBrokerState,
      right.contextLimit,
    ]),
  )
}

const validateSamples = (samples: readonly SessionSample[]): SessionSample[] => {
  if (samples.length === 0) throw new Error("At least one sample is required")
  const sessionId = samples[0]?.sessionId
  if (!sessionId) throw new Error("Every sample needs a session ID")
  for (const sample of samples) {
    parseTimestamp(sample.sampledAt)
    if (sample.sessionId !== sessionId) {
      throw new Error("All samples must belong to the same session")
    }
  }
  return [...samples].sort(compareSamples)
}

const hasSessionMetrics = (sample: SessionSample): boolean =>
  [
    sample.contextTokens,
    sample.compactedAtMs,
    sample.requestCount,
    sample.totalTokens,
    sample.cacheReadTokens,
  ].some(finiteNonNegative)

export const analyzeSession = (
  input: readonly SessionSample[],
  overrides: Partial<MonitorPolicy> = {},
): AnalysisReport => {
  const policy = resolvePolicy(overrides)
  const samples = validateSamples(input)
  const first = samples[0]!
  const latest = samples.at(-1)!
  const metricSamples = samples.filter(hasSessionMetrics)
  const metricsCurrent = hasSessionMetrics(latest)
  const firstMetric = metricSamples[0] ?? first
  const latestMetric = metricSamples.at(-1) ?? latest
  const durationMinutes = Math.max(
    0,
    (parseTimestamp(latestMetric.sampledAt)
      - parseTimestamp(firstMetric.sampledAt))
      / 60_000,
  )
  const compactionTimes = [
    ...new Set(
      samples.flatMap((sample) =>
        finiteNonNegative(sample.compactedAtMs) ? [sample.compactedAtMs] : [],
      ),
    ),
  ].sort((left, right) => left - right)
  const latestCompaction = compactionTimes.at(-1)
  const latestSegment =
    latestCompaction === undefined ?
      metricSamples
    : metricSamples.filter(
        (sample) => parseTimestamp(sample.sampledAt) >= latestCompaction,
      )
  const growth =
    metricsCurrent ?
      contextGrowth(latestSegment, policy.minimumTrendDurationMs)
    : null
  const contextRatio =
    metricsCurrent
    && finiteNonNegative(latestMetric.contextTokens)
    && finiteNonNegative(latestMetric.contextLimit)
    && latestMetric.contextLimit > 0 ?
      latestMetric.contextTokens / latestMetric.contextLimit
    : null
  const contextHeadroom =
    metricsCurrent
    && finiteNonNegative(latestMetric.contextTokens)
    && finiteNonNegative(latestMetric.contextLimit) ?
      Math.max(0, latestMetric.contextLimit - latestMetric.contextTokens)
    : null
  const contextEta =
    contextHeadroom !== null && growth !== null && growth > 0 ?
      contextHeadroom / growth
    : null
  const requestDelta =
    metricsCurrent ?
      sampleCounterDelta(firstMetric.requestCount, latestMetric.requestCount)
    : null
  const tokenDelta =
    metricsCurrent ?
      sampleCounterDelta(firstMetric.totalTokens, latestMetric.totalTokens)
    : null
  const cacheReadDelta =
    metricsCurrent ?
      sampleCounterDelta(
        firstMetric.cacheReadTokens,
        latestMetric.cacheReadTokens,
      )
    : null
  const throughput =
    tokenDelta !== null && durationMinutes > 0 ? tokenDelta / durationMinutes : null
  const cacheReadShare =
    cacheReadDelta !== null && tokenDelta !== null && tokenDelta > 0 ?
      cacheReadDelta / tokenDelta
    : null
  const healthFailures = trailingHealthFailures(samples)
  const recommendations: Recommendation[] = []

  if (healthFailures >= policy.consecutiveHealthFailures) {
    recommendations.push({
      code: "investigate-service-health",
      severity: "critical",
      message:
        "Pause workflow changes and investigate Maximal health before attributing performance to the session.",
      evidence: [
        `${healthFailures} consecutive samples reported an unhealthy service or Copilot state`,
      ],
    })
  }

  if (compactionTimes.length >= policy.repeatedCompactions) {
    recommendations.push({
      code: "start-fresh-session",
      severity: "warning",
      message:
        "Start a fresh session before the next major work phase instead of repeatedly compacting this one.",
      evidence: [
        `${compactionTimes.length} distinct compactions were reported by Maximal`,
      ],
    })
  } else if (contextRatio !== null && contextRatio >= policy.contextActionRatio) {
    recommendations.push({
      code: "compact-now",
      severity: "warning",
      message: "Compact or start a fresh session before adding another major task.",
      evidence: [
        `context utilization is ${(contextRatio * 100).toFixed(1)}%`,
        `critical threshold is ${(policy.contextActionRatio * 100).toFixed(1)}%`,
      ],
    })
  }

  const observations = [
    "Token throughput, cache share, and linear context ETA are informational only; aggregate session metrics may include subagents.",
  ]
  if (!metricsCurrent) {
    observations.push(
      "The latest sample has no session metrics; performance conclusions are not current.",
    )
  }
  if (metricSamples.length < policy.minimumSamples) {
    observations.push(
      `${metricSamples.length} samples include session metrics; ${policy.minimumSamples} are required for a stable no-change verdict.`,
    )
  }
  if (compactionTimes.length > 0) {
    observations.push(
      `${compactionTimes.length} distinct compaction(s) were reported during the observations.`,
    )
  }
  if (contextRatio !== null && contextRatio >= policy.contextWatchRatio) {
    observations.push(
      `Context utilization is above the ${(policy.contextWatchRatio * 100).toFixed(0)}% watch threshold.`,
    )
  }

  let verdict: AnalysisReport["verdict"]
  if (recommendations.length > 0) verdict = "action"
  else if (!metricsCurrent || metricSamples.length < policy.minimumSamples) {
    verdict = "insufficient-data"
  }
  else if (
    healthFailures > 0
    || (contextRatio !== null && contextRatio >= policy.contextWatchRatio)
  ) {
    verdict = "watch"
  } else verdict = "no-change"

  return {
    schemaVersion: 1,
    verdict,
    sessionId: latest.sessionId,
    client: latestMetric.client,
    model: latestMetric.model,
    sampleCount: samples.length,
    observedFrom: first.sampledAt,
    observedTo: latest.sampledAt,
    metrics: {
      contextRatio,
      contextHeadroomTokens: contextHeadroom,
      contextGrowthTokensPerMinute: growth,
      contextLimitEtaMinutes: contextEta,
      compactionCount: compactionTimes.length,
      requestDelta,
      tokenThroughputPerMinute: throughput,
      cacheReadShare,
      trailingHealthFailures: healthFailures,
    },
    observations,
    recommendations,
  }
}
