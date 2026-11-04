import { analyzeSession, resolvePolicy } from "./analyze"
import type {
  MonitorPolicy,
  MonitorRecording,
  ServiceStatus,
  SessionSample,
} from "./types"

const asRecord = (value: unknown): Record<string, unknown> | null =>
  typeof value === "object" && value !== null && !Array.isArray(value) ?
    (value as Record<string, unknown>)
  : null

const requiredString = (name: string, value: unknown): string => {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${name} must be a non-empty string`)
  }
  return value
}

const nullableString = (name: string, value: unknown): string | null => {
  if (value === null) return null
  return requiredString(name, value)
}

const nullableBoolean = (name: string, value: unknown): boolean | null => {
  if (value === null || typeof value === "boolean") return value
  throw new Error(`${name} must be a boolean or null`)
}

const nullableCounter = (
  name: string,
  value: unknown,
  positive = false,
): number | null => {
  if (value === null) return null
  if (
    typeof value !== "number"
    || !Number.isSafeInteger(value)
    || (positive ? value <= 0 : value < 0)
  ) {
    const range = positive ? "a positive" : "a non-negative"
    throw new Error(`${name} must be ${range} safe integer or null`)
  }
  return value
}

const parseServiceStatus = (name: string, value: unknown): ServiceStatus => {
  if (value === "ok" || value === "degraded" || value === "unreachable") {
    return value
  }
  throw new Error(`${name} must be ok, degraded, or unreachable`)
}

const parseSample = (value: unknown, index: number): SessionSample => {
  const sample = asRecord(value)
  if (!sample) throw new Error(`samples[${index}] must be an object`)
  const prefix = `samples[${index}]`
  const sampledAt = requiredString(`${prefix}.sampledAt`, sample.sampledAt)
  if (!Number.isFinite(Date.parse(sampledAt))) {
    throw new Error(`${prefix}.sampledAt must be a valid timestamp`)
  }

  return {
    sampledAt,
    sessionId: requiredString(`${prefix}.sessionId`, sample.sessionId),
    client: requiredString(`${prefix}.client`, sample.client),
    model: requiredString(`${prefix}.model`, sample.model),
    serviceStatus: parseServiceStatus(
      `${prefix}.serviceStatus`,
      sample.serviceStatus,
    ),
    copilotReady: nullableBoolean(
      `${prefix}.copilotReady`,
      sample.copilotReady,
    ),
    mcpBrokerState: nullableString(
      `${prefix}.mcpBrokerState`,
      sample.mcpBrokerState,
    ),
    contextTokens: nullableCounter(
      `${prefix}.contextTokens`,
      sample.contextTokens,
    ),
    contextLimit: nullableCounter(
      `${prefix}.contextLimit`,
      sample.contextLimit,
      true,
    ),
    compactedAtMs: nullableCounter(
      `${prefix}.compactedAtMs`,
      sample.compactedAtMs,
    ),
    requestCount: nullableCounter(
      `${prefix}.requestCount`,
      sample.requestCount,
    ),
    totalTokens: nullableCounter(`${prefix}.totalTokens`, sample.totalTokens),
    cacheReadTokens: nullableCounter(
      `${prefix}.cacheReadTokens`,
      sample.cacheReadTokens,
    ),
  }
}

const parseSamples = (value: unknown): SessionSample[] => {
  if (!Array.isArray(value)) throw new Error("recording samples must be an array")
  return value.map(parseSample)
}

const POLICY_KEYS = [
  "minimumSamples",
  "minimumTrendDurationMs",
  "contextWatchRatio",
  "contextActionRatio",
  "repeatedCompactions",
  "consecutiveHealthFailures",
] as const

export const parsePolicy = (value: unknown): MonitorPolicy => {
  const policy = asRecord(value)
  if (!policy) throw new Error("policy must be an object")
  for (const key of Object.keys(policy)) {
    if (!POLICY_KEYS.includes(key as (typeof POLICY_KEYS)[number])) {
      throw new Error(`unknown policy field: ${key}`)
    }
  }
  return resolvePolicy(policy as unknown as Partial<MonitorPolicy>)
}

const parseRecordedPolicy = (value: unknown): MonitorPolicy => {
  const policy = asRecord(value)
  if (!policy) throw new Error("recording policy must be an object")
  for (const key of POLICY_KEYS) {
    if (!(key in policy)) throw new Error(`recording policy is missing ${key}`)
  }
  return parsePolicy(policy)
}

export const parseRecording = (
  value: unknown,
  fallbackSource: string,
  policyOverride?: Partial<MonitorPolicy>,
): MonitorRecording => {
  const recording = asRecord(value)
  if (!Array.isArray(value) && !recording) {
    throw new Error("recording must be an object or sample array")
  }
  if (recording && recording.schemaVersion !== 1) {
    throw new Error("recording schemaVersion must be 1")
  }

  const samples = parseSamples(Array.isArray(value) ? value : recording?.samples)
  const recordedPolicy = recording ? parseRecordedPolicy(recording.policy) : undefined
  const policy = resolvePolicy(policyOverride ?? recordedPolicy)
  const source = recording ?
    requiredString("recording source", recording.source)
  : fallbackSource

  return {
    schemaVersion: 1,
    source,
    policy,
    samples,
    report: analyzeSession(samples, policy),
  }
}
