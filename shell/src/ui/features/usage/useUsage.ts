import { useCallback, useEffect, useRef, useState } from "react"

import type {
  QuotaDetails,
  TokenUsageEventsPage,
  TokenUsageSeries,
  TokenUsageSummary,
  UsageLiveSnapshot,
  UsagePeriod,
} from "./usage-types"

/**
 * Data hook for the Usage view (§4). Pulls the authoritative summary, quota
 * snapshots, time-series, and a page of recent events over the loopback-exempt
 * proxy endpoints, and layers a LIVE stream on top: the `maximal:usage-refresh`
 * event (dispatched by main.ts on each WS `usage` frame) carries the just-
 * recorded request in its `detail`, which we fold into a bounded ring buffer to
 * animate traffic without waiting on a refetch. The authoritative pull is
 * throttled so a burst of requests can't hammer the endpoints.
 */
export type { UsagePeriod } from "./usage-types"

const EVENTS_PAGE_SIZE = 20
/** How many recent live events to retain for the stream/pulse (bounded memory). */
const LIVE_RING_CAPACITY = 400
/** Rolling window the live hero visualizes. */
export const LIVE_WINDOW_MS = 60 * 60 * 1000
/** Minimum gap between authoritative refetches triggered by live frames. */
const REFETCH_THROTTLE_MS = 4000

/** One entry in the live ring buffer — a distilled recorded request. */
export interface LiveEvent {
  ms: number
  model: string
  provider: string
  inputTokens: number
  outputTokens: number
  totalTokens: number
}

export interface UsageLive {
  /** Recent events, oldest → newest, capped to the rolling window + capacity. */
  events: ReadonlyArray<LiveEvent>
  /** Monotonic counter bumped on each new live event (drives the pulse). */
  pulse: number
  /** The most recent live event, or null before any arrives. */
  last: LiveEvent | null
  /** Timestamp of the last live frame (for the "live" indicator freshness). */
  lastAt: number | null
}

interface UseUsage {
  summary: TokenUsageSummary | null
  quotas: Record<string, QuotaDetails> | null
  series: TokenUsageSeries | null
  events: TokenUsageEventsPage | null
  live: UsageLive
  period: UsagePeriod
  setPeriod: (p: UsagePeriod) => void
  page: number
  setPage: (p: number) => void
  isLoading: boolean
  error: string | null
  refresh: () => Promise<void>
}

async function fetchSummary(
  period: UsagePeriod,
): Promise<
  { ok: true; data: TokenUsageSummary } | { ok: false; error: string }
> {
  try {
    const res = await fetch(`/token-usage?period=${encodeURIComponent(period)}`)
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}` }
    return { ok: true, data: (await res.json()) as TokenUsageSummary }
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    }
  }
}

/** Quota snapshots from `/usage`. Best-effort: a failure just hides the cards. */
async function fetchQuotas(): Promise<Record<string, QuotaDetails> | null> {
  try {
    const res = await fetch("/usage")
    if (!res.ok) return null
    const data = (await res.json()) as {
      quota_snapshots?: Record<string, QuotaDetails> | null
    }
    return data.quota_snapshots ?? null
  } catch {
    return null
  }
}

/** Time-series for the trend chart. Best-effort: a failure just hides it. */
async function fetchSeries(
  period: UsagePeriod,
): Promise<TokenUsageSeries | null> {
  try {
    const res = await fetch(
      `/token-usage/series?period=${encodeURIComponent(period)}`,
    )
    if (!res.ok) return null
    return (await res.json()) as TokenUsageSeries
  } catch {
    return null
  }
}

/** A page of recent events. Best-effort: a failure just hides the table. */
async function fetchEvents(
  period: UsagePeriod,
  page: number,
): Promise<TokenUsageEventsPage | null> {
  try {
    const res = await fetch(
      `/token-usage/events?period=${encodeURIComponent(period)}&page=${page}&page_size=${EVENTS_PAGE_SIZE}`,
    )
    if (!res.ok) return null
    return (await res.json()) as TokenUsageEventsPage
  } catch {
    return null
  }
}

/** Provider display key for a source/provider_name pair (mirrors the store). */
function providerKeyOf(source: string, providerName: string | null): string {
  if (source === "copilot") return "copilot"
  return providerName && providerName.trim() ? providerName : "provider"
}

/** Drop entries older than the rolling window and cap the ring length. */
function trimRing(events: Array<LiveEvent>, now: number): Array<LiveEvent> {
  const cutoff = now - LIVE_WINDOW_MS
  const fresh = events.filter((e) => e.ms >= cutoff)
  return fresh.length > LIVE_RING_CAPACITY ?
      fresh.slice(fresh.length - LIVE_RING_CAPACITY)
    : fresh
}

/**
 * The live-stream half of the Usage hook, factored out to keep each hook small.
 * Seeds a ring buffer from recent events, then folds each WS `usage` frame's
 * `lastEvent` into it and nudges an authoritative refetch (throttled).
 */
function useLiveStream(
  load: () => Promise<void>,
  lastFetchAt: React.MutableRefObject<number>,
): UsageLive {
  const [live, setLive] = useState<UsageLive>({
    events: [],
    pulse: 0,
    last: null,
    lastAt: null,
  })

  // Seed from the most recent events so the stream isn't empty on first paint.
  useEffect(() => {
    // Object guard (not a bare `let`): a property read isn't narrowed across the
    // await, so the cancellation check stays meaningful to the type-checker.
    const guard = { cancelled: false }
    void (async () => {
      const recent = await fetchEvents("day", 1)
      if (guard.cancelled || !recent) return
      const now = Date.now()
      const seeded: Array<LiveEvent> = recent.items
        .map((e) => ({
          ms: e.created_at_ms,
          model: e.model,
          provider: providerKeyOf(e.source, e.provider_name),
          inputTokens: e.input_tokens,
          outputTokens: e.output_tokens,
          totalTokens: e.total_tokens,
        }))
        .sort((a, b) => a.ms - b.ms)
      setLive((prev) =>
        prev.events.length > 0 ?
          prev
        : { events: trimRing(seeded, now), pulse: 0, last: null, lastAt: null },
      )
    })()
    return () => {
      guard.cancelled = true
    }
  }, [])

  // Fold each WS `usage` frame's lastEvent into the ring; nudge a refetch.
  useEffect(() => {
    const onRefresh = (evt: Event): void => {
      const detail = (evt as CustomEvent<UsageLiveSnapshot | undefined>).detail
      const last = detail?.lastEvent ?? null
      if (last) {
        const now = Date.now()
        const entry: LiveEvent = {
          ms: last.createdAtMs,
          model: last.model,
          provider: providerKeyOf(last.source, last.providerName),
          inputTokens: last.inputTokens,
          outputTokens: last.outputTokens,
          totalTokens: last.totalTokens,
        }
        setLive((prev) => ({
          events: trimRing([...prev.events, entry], now),
          pulse: prev.pulse + 1,
          last: entry,
          lastAt: now,
        }))
      }
      if (Date.now() - lastFetchAt.current >= REFETCH_THROTTLE_MS) {
        void load()
      }
    }
    globalThis.addEventListener("maximal:usage-refresh", onRefresh)
    return () =>
      globalThis.removeEventListener("maximal:usage-refresh", onRefresh)
  }, [load, lastFetchAt])

  return live
}

export function useUsage(): UseUsage {
  const [summary, setSummary] = useState<TokenUsageSummary | null>(null)
  const [quotas, setQuotas] = useState<Record<string, QuotaDetails> | null>(
    null,
  )
  const [series, setSeries] = useState<TokenUsageSeries | null>(null)
  const [events, setEvents] = useState<TokenUsageEventsPage | null>(null)
  const [period, setPeriodState] = useState<UsagePeriod>("day")
  const [page, setPage] = useState(1)
  const [isLoading, setIsLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  // Last authoritative refetch time, so live bursts don't hammer the endpoints.
  const lastFetchAt = useRef(0)

  // Changing the period resets to the first page — the old page number is
  // meaningless against a different period's event set.
  const setPeriod = useCallback((p: UsagePeriod) => {
    setPeriodState(p)
    setPage(1)
  }, [])

  const load = useCallback(async () => {
    lastFetchAt.current = Date.now()
    const [result, quotaSnapshots, seriesData, eventsPage] = await Promise.all([
      fetchSummary(period),
      fetchQuotas(),
      fetchSeries(period),
      fetchEvents(period, page),
    ])
    if (result.ok) {
      // Normalize the array fields so a sparse/legacy body can't crash a
      // consumer that maps over them (the server always sends both).
      const data = result.data
      setSummary({
        ...data,
        byModel: Array.isArray(data.byModel) ? data.byModel : [],
        byProvider: Array.isArray(data.byProvider) ? data.byProvider : [],
      })
      setError(null)
    } else {
      setError(result.error)
    }
    setQuotas(quotaSnapshots)
    setSeries(seriesData)
    setEvents(eventsPage)
    setIsLoading(false)
  }, [period, page])

  useEffect(() => {
    void load()
  }, [load])

  const live = useLiveStream(load, lastFetchAt)

  return {
    summary,
    quotas,
    series,
    events,
    live,
    period,
    setPeriod,
    page,
    setPage,
    isLoading,
    error,
    refresh: load,
  }
}
