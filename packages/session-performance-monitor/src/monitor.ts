import { analyzeSession, resolvePolicy } from "./analyze"
import { collectMaximalSample, type FetchLike } from "./maximal"
import type {
  MonitorPolicy,
  MonitorRecording,
  SessionSample,
} from "./types"

export interface MonitorMaximalOptions {
  baseUrl: string
  sampleCount: number
  intervalMs: number
  sessionId?: string
  client?: string
  apiKey?: string
  timeoutMs?: number
  policy?: Partial<MonitorPolicy>
  fetcher?: FetchLike
  now?: () => number
  sleep?: (durationMs: number) => Promise<void>
  onSample?: (sample: SessionSample, index: number, total: number) => void
}

const defaultSleep = (durationMs: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, durationMs))

export const monitorMaximal = async (
  options: MonitorMaximalOptions,
): Promise<MonitorRecording> => {
  if (!Number.isInteger(options.sampleCount) || options.sampleCount <= 0) {
    throw new Error("sampleCount must be a positive integer")
  }
  if (!Number.isFinite(options.intervalMs) || options.intervalMs < 0) {
    throw new Error("intervalMs must be zero or greater")
  }
  const now = options.now ?? Date.now
  const sleep = options.sleep ?? defaultSleep
  const policy = resolvePolicy(options.policy)
  const samples: SessionSample[] = []
  let sessionId = options.sessionId

  for (let index = 0; index < options.sampleCount; index += 1) {
    const sample = await collectMaximalSample({
      baseUrl: options.baseUrl,
      sampledAtMs: now(),
      sessionId,
      client: options.client,
      apiKey: options.apiKey,
      timeoutMs: options.timeoutMs,
      fetcher: options.fetcher,
    })
    sessionId = sample.sessionId
    samples.push(sample)
    options.onSample?.(sample, index + 1, options.sampleCount)
    if (index + 1 < options.sampleCount) await sleep(options.intervalMs)
  }

  return {
    schemaVersion: 1,
    source: new URL(options.baseUrl).origin,
    policy,
    samples,
    report: analyzeSession(samples, policy),
  }
}
