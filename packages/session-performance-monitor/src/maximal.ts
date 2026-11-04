import type { ServiceStatus, SessionSample } from "./types"

export type FetchLike = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>

export interface CollectMaximalSampleOptions {
  baseUrl: string
  sampledAtMs: number
  sessionId?: string
  client?: string
  apiKey?: string
  timeoutMs?: number
  fetcher?: FetchLike
}

const asRecord = (value: unknown): Record<string, unknown> | null =>
  typeof value === "object" && value !== null && !Array.isArray(value) ?
    (value as Record<string, unknown>)
  : null

const asFiniteNumber = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) ? value : null

const asNonNegativeNumber = (value: unknown): number | null => {
  const number = asFiniteNumber(value)
  return number !== null && number >= 0 ? number : null
}

const asString = (value: unknown): string | null =>
  typeof value === "string" && value.length > 0 ? value : null

const compareStrings = (left: string, right: string): number =>
  left < right ? -1
  : left > right ? 1
  : 0

const fetchJson = async (
  fetcher: FetchLike,
  baseUrl: string,
  path: string,
  apiKey: string | undefined,
  timeoutMs: number,
): Promise<unknown> => {
  const headers = new Headers({ accept: "application/json" })
  if (apiKey) headers.set("authorization", `Bearer ${apiKey}`)
  const response = await fetcher(new URL(path, baseUrl), {
    method: "GET",
    headers,
    signal: AbortSignal.timeout(timeoutMs),
  })
  if (!response.ok) throw new Error(`${path} returned HTTP ${response.status}`)
  return response.json()
}

const serviceHealth = (
  statusValue: unknown,
): {
  status: ServiceStatus
  copilotReady: boolean | null
  brokerState: string | null
} => {
  const status = asRecord(statusValue)
  const subsystems = asRecord(status?.subsystems)
  const copilot = asRecord(subsystems?.copilot)
  const broker = asRecord(subsystems?.mcp_broker)
  const copilotReady =
    typeof copilot?.ready === "boolean" ? copilot.ready : null
  const brokerState = asString(broker?.state)
  const serviceHealthy = status?.service === "maximal" && status.status === "ok"
  return {
    status: serviceHealthy ? "ok" : "degraded",
    copilotReady,
    brokerState,
  }
}

const contextLimit = (context: Record<string, unknown> | null): number | null => {
  const limits = [context?.window_tokens, context?.ceiling_tokens]
    .map(asNonNegativeNumber)
    .filter((value): value is number => value !== null && value > 0)
  return limits.length > 0 ? Math.min(...limits) : null
}

const selectSession = (
  payload: unknown,
  sessionId: string | undefined,
  client: string,
): Record<string, unknown> | null => {
  const root = asRecord(payload)
  if (!Array.isArray(root?.sessions)) throw new Error("Invalid sessions response")
  const sessions = root.sessions.flatMap((value) => {
    const session = asRecord(value)
    return session ? [session] : []
  })
  if (sessionId) {
    return sessions.find((session) => session.id === sessionId) ?? null
  }
  return (
    sessions
      .filter((session) => session.client === client)
      .sort((left, right) => {
        const activity =
          (asFiniteNumber(right.last_request_at_ms) ?? 0)
          - (asFiniteNumber(left.last_request_at_ms) ?? 0)
        if (activity !== 0) return activity
        return compareStrings(asString(left.id) ?? "", asString(right.id) ?? "")
      })[0] ?? null
  )
}

const emptySample = (
  sampledAtMs: number,
  sessionId: string,
  client: string,
  serviceStatus: ServiceStatus,
  copilotReady: boolean | null,
  brokerState: string | null,
): SessionSample => ({
  sampledAt: new Date(sampledAtMs).toISOString(),
  sessionId,
  client,
  model: "unknown",
  serviceStatus,
  copilotReady,
  mcpBrokerState: brokerState,
  contextTokens: null,
  contextLimit: null,
  compactedAtMs: null,
  requestCount: null,
  totalTokens: null,
  cacheReadTokens: null,
})

export const collectMaximalSample = async (
  options: CollectMaximalSampleOptions,
): Promise<SessionSample> => {
  const fetcher = options.fetcher ?? globalThis.fetch
  const timeoutMs = options.timeoutMs ?? 10_000
  const client = options.client ?? "claude-code"
  const [statusResult, sessionsResult] = await Promise.allSettled([
    fetchJson(
      fetcher,
      options.baseUrl,
      "/status",
      options.apiKey,
      timeoutMs,
    ),
    fetchJson(
      fetcher,
      options.baseUrl,
      "/token-usage/sessions",
      options.apiKey,
      timeoutMs,
    ),
  ])
  const health =
    statusResult.status === "fulfilled" ?
      serviceHealth(statusResult.value)
    : { status: "unreachable" as const, copilotReady: null, brokerState: null }
  if (sessionsResult.status === "rejected") {
    if (!options.sessionId) throw sessionsResult.reason
    return emptySample(
      options.sampledAtMs,
      options.sessionId,
      client,
      health.status,
      health.copilotReady,
      health.brokerState,
    )
  }

  const session = selectSession(
    sessionsResult.value,
    options.sessionId,
    client,
  )
  if (!session) {
    const target = options.sessionId ?? `latest ${client}`
    throw new Error(`Session not found: ${target}`)
  }
  const id = asString(session.id)
  if (!id) throw new Error("Selected session has no ID")
  const context = asRecord(session.context)
  const totals = asRecord(session.token_totals)

  return {
    sampledAt: new Date(options.sampledAtMs).toISOString(),
    sessionId: id,
    client: asString(session.client) ?? client,
    model: asString(session.model) ?? "unknown",
    serviceStatus: health.status,
    copilotReady: health.copilotReady,
    mcpBrokerState: health.brokerState,
    contextTokens: asNonNegativeNumber(context?.used_tokens),
    contextLimit: contextLimit(context),
    compactedAtMs: asNonNegativeNumber(context?.compacted_at_ms),
    requestCount: asNonNegativeNumber(session.request_count),
    totalTokens:
      asNonNegativeNumber(totals?.total_tokens)
      ?? asNonNegativeNumber(session.total_tokens),
    cacheReadTokens: asNonNegativeNumber(totals?.cache_read_tokens),
  }
}
