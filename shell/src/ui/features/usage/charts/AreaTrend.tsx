import { AxisBottom, AxisLeft, type AxisScale } from "@visx/axis"
import { LinearGradient } from "@visx/gradient"
import { Group } from "@visx/group"
import { scaleLinear } from "@visx/scale"
import { AreaStack } from "@visx/shape"
import { useId } from "react"

import type { TrafficBandKey, TrafficPoint } from "./traffic-bands"

import { formatCompact } from "../format"
import { TRAFFIC_BANDS, trafficTotal } from "./traffic-bands"
import { useMeasure } from "./useMeasure"

/**
 * A stacked-area trend of token traffic over time, banded by token type
 * (input / output / cached input / cached output) using the shared 4-band
 * language, so it reads as one color system with the tracker strip. Headless
 * visx primitives styled entirely from the viz design tokens — the design
 * system owns every pixel. Purely a function of its data: it re-renders as new
 * points arrive (the live "motion" is real data, not a decorative tween), so
 * there is nothing to gate on reduced-motion here. With `showAxes`, a time
 * x-axis and a token-magnitude y-axis are drawn so the timeframe is legible.
 */

const BAND_KEYS: ReadonlyArray<TrafficBandKey> = TRAFFIC_BANDS.map((b) => b.key)

/** The band color for a key, from the shared 4-band source of truth. */
function bandColor(key: TrafficBandKey): string {
  return TRAFFIC_BANDS.find((b) => b.key === key)?.color ?? ""
}

const AXIS_MARGIN = { top: 8, right: 14, bottom: 22, left: 48 }
const BARE_MARGIN = { top: 4, right: 0, bottom: 2, left: 0 }

/** Two days — above this span, ticks read as dates, not clock times. */
const AXIS_DATE_THRESHOLD_MS = 2 * 86_400_000

/**
 * X-axis tick label, chosen by the visible span so the timescale is legible at
 * every period: HH:MM for a sub-two-day window (today/live), a short month/day
 * date for wider spans (week/month/all) — the day-sized buckets would otherwise
 * all collapse to "0:00". Unpinned locale is fine here (matches the rest).
 */
function axisTickLabel(ms: number, spanMs: number): string {
  const d = new Date(ms)
  if (spanMs > AXIS_DATE_THRESHOLD_MS) {
    return d.toLocaleDateString(undefined, { month: "short", day: "numeric" })
  }
  const h = d.getHours()
  const m = d.getMinutes().toString().padStart(2, "0")
  return `${h}:${m}`
}

/** Time (x) + token-magnitude (y) axes for the trend, drawn inside the plot group. */
function TrendAxes({
  xScale,
  yScale,
  innerH,
  innerW,
  spanMs,
}: {
  xScale: AxisScale<number>
  yScale: AxisScale<number>
  innerH: number
  innerW: number
  spanMs: number
}): React.ReactElement {
  const labelColor = "var(--text-muted)"
  return (
    <>
      <AxisLeft
        scale={yScale}
        numTicks={3}
        hideAxisLine
        hideTicks
        tickFormat={(v) => formatCompact(Number(v))}
        tickLabelProps={() => ({
          fill: labelColor,
          fontSize: 11,
          textAnchor: "end",
          dx: -4,
          dy: 3,
        })}
      />
      <AxisBottom
        scale={xScale}
        top={innerH}
        numTicks={Math.min(6, Math.max(2, Math.floor(innerW / 90)))}
        stroke="var(--border-subtle)"
        hideTicks
        tickFormat={(v) => axisTickLabel(Number(v), spanMs)}
        tickLabelProps={() => ({
          fill: labelColor,
          fontSize: 11,
          textAnchor: "middle",
          dy: 2,
        })}
      />
    </>
  )
}

export function AreaTrend({
  data,
  height = 140,
  ariaLabel,
  showAxes = false,
}: {
  data: ReadonlyArray<TrafficPoint>
  height?: number
  ariaLabel?: string
  showAxes?: boolean
}): React.ReactElement {
  const [ref, width] = useMeasure()
  const gradientId = useId()

  const points =
    data.length > 0 ?
      data
    : [{ t: 0, input: 0, output: 0, cacheRead: 0, cacheCreation: 0 }]
  const maxTotal = Math.max(1, ...points.map((p) => trafficTotal(p)))
  const firstT = points[0].t
  const lastT = points.at(-1)?.t ?? firstT

  const margin = showAxes ? AXIS_MARGIN : BARE_MARGIN
  const innerW = Math.max(1, width - margin.left - margin.right)
  const innerH = Math.max(1, height - margin.top - margin.bottom)

  // Both data sources are uniformly time-stepped, so a time-domain scale spaces
  // buckets evenly. Guard the degenerate single-point domain.
  const xScale = scaleLinear<number>({
    domain: firstT === lastT ? [firstT, firstT + 1] : [firstT, lastT],
    range: [0, innerW],
  })
  const yScale = scaleLinear<number>({
    domain: [0, maxTotal],
    range: [innerH, 0],
    nice: true,
  })

  return (
    <div className="usage-chart" ref={ref}>
      <svg
        width={width}
        height={height}
        role="img"
        aria-label={ariaLabel ?? "Token traffic over time"}
        className="usage-chart__svg"
      >
        {TRAFFIC_BANDS.map((band) => (
          <LinearGradient
            key={band.key}
            id={`${gradientId}-${band.key}`}
            from={band.color}
            to={band.color}
            fromOpacity={0.55}
            toOpacity={0.12}
          />
        ))}
        <Group left={margin.left} top={margin.top}>
          <AreaStack<TrafficPoint>
            keys={BAND_KEYS as Array<TrafficBandKey>}
            data={points as Array<TrafficPoint>}
            x={(d) => xScale(d.data.t)}
            y0={(d) => yScale(d[0])}
            y1={(d) => yScale(d[1])}
            value={(d, key) => d[key as TrafficBandKey]}
          >
            {({ stacks, path }) =>
              stacks.map((stack) => {
                const key = stack.key as TrafficBandKey
                return (
                  <path
                    key={`stack-${key}`}
                    d={path(stack) ?? ""}
                    fill={`url(#${gradientId}-${key})`}
                    stroke={bandColor(key)}
                    strokeWidth={1}
                    strokeOpacity={0.9}
                  />
                )
              })
            }
          </AreaStack>
          {showAxes && (
            <TrendAxes
              xScale={xScale}
              yScale={yScale}
              innerH={innerH}
              innerW={innerW}
              spanMs={lastT - firstT}
            />
          )}
        </Group>
      </svg>
    </div>
  )
}
