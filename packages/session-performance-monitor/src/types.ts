export type ServiceStatus = "ok" | "degraded" | "unreachable"

export interface SessionSample {
  sampledAt: string
  sessionId: string
  client: string
  model: string
  serviceStatus: ServiceStatus
  copilotReady: boolean | null
  mcpBrokerState: string | null
  contextTokens: number | null
  contextLimit: number | null
  compactedAtMs: number | null
  requestCount: number | null
  totalTokens: number | null
  cacheReadTokens: number | null
}

export interface MonitorPolicy {
  minimumSamples: number
  minimumTrendDurationMs: number
  contextWatchRatio: number
  contextActionRatio: number
  repeatedCompactions: number
  consecutiveHealthFailures: number
}

export type RecommendationCode =
  | "compact-now"
  | "investigate-service-health"
  | "start-fresh-session"

export interface Recommendation {
  code: RecommendationCode
  severity: "warning" | "critical"
  message: string
  evidence: string[]
}

export interface AnalysisMetrics {
  contextRatio: number | null
  contextHeadroomTokens: number | null
  contextGrowthTokensPerMinute: number | null
  contextLimitEtaMinutes: number | null
  compactionCount: number
  requestDelta: number | null
  tokenThroughputPerMinute: number | null
  cacheReadShare: number | null
  trailingHealthFailures: number
}

export interface AnalysisReport {
  schemaVersion: 1
  verdict: "action" | "watch" | "no-change" | "insufficient-data"
  sessionId: string
  client: string
  model: string
  sampleCount: number
  observedFrom: string
  observedTo: string
  metrics: AnalysisMetrics
  observations: string[]
  recommendations: Recommendation[]
}

export interface MonitorRecording {
  schemaVersion: 1
  source: string
  policy: MonitorPolicy
  samples: SessionSample[]
  report: AnalysisReport
}
