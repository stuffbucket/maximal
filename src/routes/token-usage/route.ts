import { Hono } from "hono"

import { forwardError } from "~/lib/errors/error"
import {
  getTokenUsageEventsPage,
  getTokenUsageSummary,
  type TokenUsagePeriod,
} from "~/lib/token-usage"
import { listInFlight } from "~/lib/token-usage/in-flight"
import {
  buildSessionsView,
  CacheObservations,
} from "~/lib/token-usage/sessions"
import { SessionsResponse } from "~/lib/token-usage/sessions-schema"
import { getSessionRows } from "~/lib/token-usage/store"

export const tokenUsageRoute = new Hono()

const periods = new Set<TokenUsagePeriod>(["day", "week", "month"])
const DEFAULT_EVENTS_PAGE_SIZE = 20
/** The session view always covers the last 24 h, whatever the period. */
const SESSIONS_WINDOW_MS = 24 * 60 * 60 * 1000

/** What this process has seen of each model's prompt cache, fed on every
 *  poll; repeated polls over the same rows record each resume once. */
const cacheObservations = new CacheObservations()

function parsePeriod(value: string | undefined): TokenUsagePeriod {
  return periods.has(value as TokenUsagePeriod) ?
      (value as TokenUsagePeriod)
    : "day"
}

function parsePositiveInt(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value ?? "", 10)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
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

tokenUsageRoute.get("/sessions", async (c) => {
  try {
    const nowMs = Date.now()
    const rows = await getSessionRows(nowMs - SESSIONS_WINDOW_MS)
    const view = buildSessionsView({
      rows,
      inFlight: listInFlight(nowMs),
      nowMs,
      observations: cacheObservations,
    })
    return c.json(SessionsResponse.parse(view))
  } catch (error) {
    return forwardError(c, error)
  }
})
