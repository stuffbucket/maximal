import { useEffect, useState } from "react"

import type { LiveEvent, UsageLive } from "../useUsage"

import { formatCompact, formatNumber, providerLabel } from "../format"
import { AreaTrend, type TrendPoint } from "./AreaTrend"
import { useReducedMotion } from "./useReducedMotion"

/**
 * The live-traffic hero (§4) — the mesmerizing centerpiece. Its spectacle is
 * REAL proxy traffic: a rolling per-minute stacked area of the last hour that
 * redraws as requests land, a live "last minute" rate, and the models currently
 * in flight. The only decorative motion is the pulse on the newest model chip,
 * which is turned OFF (not softened) under `prefers-reduced-motion`.
 */

const MINUTE_MS = 60_000
const WINDOW_MINUTES = 60

/** Bucket the live ring into `WINDOW_MINUTES` per-minute bins ending at `now`. */
function toBins(
  events: ReadonlyArray<LiveEvent>,
  now: number,
): Array<TrendPoint> {
  const endMinute = Math.floor(now / MINUTE_MS)
  const startMinute = endMinute - (WINDOW_MINUTES - 1)
  const bins: Array<TrendPoint> = []
  for (let m = startMinute; m <= endMinute; m += 1) {
    bins.push({ t: m * MINUTE_MS, input: 0, output: 0, cache: 0 })
  }
  for (const e of events) {
    const m = Math.floor(e.ms / MINUTE_MS)
    const idx = m - startMinute
    if (idx < 0 || idx >= bins.length) continue
    const bin = bins[idx]
    bin.input += e.inputTokens
    bin.output += e.outputTokens
    bin.cache += Math.max(0, e.totalTokens - e.inputTokens - e.outputTokens)
  }
  return bins
}

/** Tokens recorded in the trailing minute — the "now" rate. */
function lastMinuteTokens(
  events: ReadonlyArray<LiveEvent>,
  now: number,
): number {
  const cutoff = now - MINUTE_MS
  let sum = 0
  for (const e of events) if (e.ms >= cutoff) sum += e.totalTokens
  return sum
}

/** Distinct models seen most recently, newest first (max `limit`). */
function recentModels(
  events: ReadonlyArray<LiveEvent>,
  limit: number,
): Array<{ model: string; provider: string }> {
  const seen = new Set<string>()
  const out: Array<{ model: string; provider: string }> = []
  for (let i = events.length - 1; i >= 0 && out.length < limit; i -= 1) {
    const e = events[i]
    if (seen.has(e.model)) continue
    seen.add(e.model)
    out.push({ model: e.model, provider: e.provider })
  }
  return out
}

export function LiveTrafficStream({
  live,
  totalTokensToday,
  requestsToday,
}: {
  live: UsageLive
  totalTokensToday: number
  requestsToday: number
}): React.ReactElement {
  const reduced = useReducedMotion()

  // A 1s tick keeps the rolling window + "last minute" rate current even when no
  // new events arrive (so old traffic scrolls off the left edge honestly).
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(id)
  }, [])

  const bins = toBins(live.events, now)
  const rate = lastMinuteTokens(live.events, now)
  const models = recentModels(live.events, 6)
  const isLive = live.lastAt !== null && now - live.lastAt < 90_000

  return (
    <section className="usage-hero" aria-label="Live traffic">
      <header className="usage-hero__head">
        <div className="usage-hero__now">
          <span className="usage-hero__now-value">
            {formatCompact(totalTokensToday)}
          </span>
          <span className="usage-hero__now-label">
            tokens today · {formatNumber(requestsToday)} requests
          </span>
        </div>
        <div className="usage-hero__rate">
          <span
            className={
              isLive ?
                "usage-hero__dot usage-hero__dot--live"
              : "usage-hero__dot"
            }
            aria-hidden="true"
          />
          <span className="usage-hero__rate-value" aria-live="polite">
            {formatCompact(rate)}/min
          </span>
        </div>
      </header>

      <div className="usage-hero__stream">
        <AreaTrend
          data={bins}
          height={168}
          ariaLabel="Live token traffic over the last hour"
        />
      </div>

      {models.length > 0 && (
        <ul className="usage-hero__models" aria-label="Recently active models">
          {models.map((m, i) => (
            <li
              // The newest chip flashes as it enters (reduced-motion neutralizes
              // the flash globally). Keyed by model so a re-used model stays put.
              key={m.model}
              className={
                i === 0 && !reduced ?
                  "usage-hero__model usage-hero__model--flash"
                : "usage-hero__model"
              }
              title={`${m.model} · ${providerLabel(m.provider)}`}
            >
              {m.model}
            </li>
          ))}
        </ul>
      )}

      <ul className="usage-hero__legend" aria-hidden="true">
        <li className="usage-hero__legend-item usage-hero__legend-item--input">
          Input
        </li>
        <li className="usage-hero__legend-item usage-hero__legend-item--output">
          Output
        </li>
        <li className="usage-hero__legend-item usage-hero__legend-item--cache">
          Cache
        </li>
      </ul>
    </section>
  )
}
