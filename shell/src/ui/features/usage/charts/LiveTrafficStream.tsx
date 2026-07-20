import { useEffect, useMemo, useState } from "react"

import type { LiveEvent, UsageLive } from "../useUsage"
import type { TrafficPoint } from "./traffic-bands"

import { AreaTrend } from "./AreaTrend"

/**
 * The near-term (last hour) live view of token traffic (§4). The per-type
 * numbers and the color key both live in the tracker strip above; this chart
 * just shows the SHAPE of recent activity over a rolling 60-minute window,
 * stacked into the shared 4 token-type bands (input / output / cached input /
 * cached output). It updates every second so the window rolls forward and old
 * minutes scroll off even when idle. The period-reactive trend (week/month/all)
 * is a separate component. No legend or model chips here — the tracker strip is
 * the single legend, and the moving area is its own liveness signal.
 */

const WINDOW_MINUTES = 60
const MINUTE_MS = 60_000

/**
 * Bin the live ring into per-minute token-type bins across the last hour,
 * aligned to minute boundaries and ending at the current minute. Cache bands
 * come straight from each event's read/creation counts (not a total residual).
 */
function binEvents(
  events: ReadonlyArray<LiveEvent>,
  now: number,
): Array<TrafficPoint> {
  const curMinute = Math.floor(now / MINUTE_MS) * MINUTE_MS
  const startMinute = curMinute - (WINDOW_MINUTES - 1) * MINUTE_MS
  const bins: Array<TrafficPoint> = Array.from(
    { length: WINDOW_MINUTES },
    (_unused, i) => ({
      t: startMinute + i * MINUTE_MS,
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheCreation: 0,
    }),
  )
  for (const e of events) {
    const idx = Math.floor((e.ms - startMinute) / MINUTE_MS)
    if (idx < 0 || idx >= WINDOW_MINUTES) continue
    const bin = bins[idx]
    bin.input += e.inputTokens
    bin.output += e.outputTokens
    bin.cacheRead += e.cacheReadTokens
    bin.cacheCreation += e.cacheCreationTokens
  }
  return bins
}

export function LiveTrafficStream({
  live,
}: {
  live: UsageLive
}): React.ReactElement {
  // Tick every second so the rolling hour advances (and old minutes scroll off)
  // even when no new events arrive.
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(id)
  }, [])

  const bins = useMemo(() => binEvents(live.events, now), [live.events, now])

  return (
    <section className="usage-hero" aria-label="Token traffic — last hour">
      <p className="usage-hero__caption">Live · last hour</p>
      <div className="usage-hero__stream">
        <AreaTrend
          data={bins}
          height={200}
          showAxes
          ariaLabel="Live token traffic — last hour"
        />
      </div>
    </section>
  )
}
