import { Hono } from "hono"

import { forwardError } from "~/lib/errors/error"
import {
  getTokenUsageEventsPage,
  getTokenUsageSeries,
  getTokenUsageSummary,
  type TokenUsagePeriod,
} from "~/lib/token-usage"

export const tokenUsageRoute = new Hono()

const periods = new Set<TokenUsagePeriod>(["day", "week", "month", "all"])
const DEFAULT_EVENTS_PAGE_SIZE = 20

function parsePeriod(value: string | undefined): TokenUsagePeriod {
  return periods.has(value as TokenUsagePeriod) ?
      (value as TokenUsagePeriod)
    : "day"
}

function parsePositiveInt(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value ?? "", 10)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
}

/** Bucket-width unit → milliseconds. */
const BUCKET_UNIT_MS: Record<string, number> = {
  ms: 1,
  s: 1_000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
}

/** Parse a bucket width: a bare integer (ms) or a `<n><unit>` shorthand
 *  (`30s` / `5m` / `1h` / `1d`). Returns undefined for anything unparseable so
 *  the store picks a period-appropriate default. */
function parseBucketMs(value: string | undefined): number | undefined {
  if (!value) return undefined
  const match = /^(\d+)(ms|[smhd])?$/.exec(value.trim())
  if (!match) return undefined
  const amount = Number.parseInt(match[1], 10)
  if (!Number.isFinite(amount) || amount <= 0) return undefined
  const unit = match[2]
  const scale = unit ? BUCKET_UNIT_MS[unit] : 1
  return amount * scale
}

tokenUsageRoute.get("/", async (c) => {
  try {
    const period = parsePeriod(c.req.query("period"))
    const summary = await getTokenUsageSummary(period)
    return c.json(summary)
  } catch (error) {
    return forwardError(c, error)
  }
})

tokenUsageRoute.get("/series", async (c) => {
  try {
    const period = parsePeriod(c.req.query("period"))
    const bucketMs = parseBucketMs(c.req.query("bucket"))
    const series = await getTokenUsageSeries({ period, bucketMs })
    return c.json(series)
  } catch (error) {
    return forwardError(c, error)
  }
})

tokenUsageRoute.get("/events", async (c) => {
  try {
    const period = parsePeriod(c.req.query("period"))
    const page = parsePositiveInt(c.req.query("page"), 1)
    const pageSize = parsePositiveInt(
      c.req.query("page_size"),
      DEFAULT_EVENTS_PAGE_SIZE,
    )
    const eventsPage = await getTokenUsageEventsPage({ page, pageSize, period })
    return c.json(eventsPage)
  } catch (error) {
    return forwardError(c, error)
  }
})
