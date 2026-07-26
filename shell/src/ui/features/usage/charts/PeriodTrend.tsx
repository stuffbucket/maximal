import { AxisBottom, AxisLeft, type AxisScale } from "@visx/axis"
import { Group } from "@visx/group"
import { scaleLinear, scaleLog } from "@visx/scale"
import { LinePath } from "@visx/shape"

import type { TrafficPoint } from "./traffic-bands"

import { formatCompact } from "../format"
import { TRAFFIC_BANDS, trafficTotal } from "./traffic-bands"
import { useMeasure } from "./useMeasure"

/**
 * "Where it went" — the period-reactive analytical trend (Today/Week/Month/All).
 * Constructed for bursty, wide-dynamic-range token data:
 *   - a TRUE log y-axis (decade ticks, no fake 0 baseline) so a hundreds-of-
 *     millions cached series and a few-thousand input series are both legible —
 *     log is only defined for positive values, so we never plot a zero;
 *   - lines BROKEN at empty buckets (`defined`), never interpolated across
 *     no-data gaps — this kills the false "cliff to zero" and dead flat tail;
 *   - a point marker at every real sample, so an isolated bucket still shows;
 *   - the x-domain trimmed to the ACTIVE span (first→last bucket with traffic),
 *     so the plot spends its width on data, not on empty hours.
 * A small-range period falls back to a plain linear axis. Static chart — nothing
 * to gate on reduced-motion.
 */

const MARGIN = { top: 16, right: 20, bottom: 24, left: 46 }
/** Two days — above this span x-ticks read as dates, not clock times. */
const AXIS_DATE_THRESHOLD_MS = 2 * 86_400_000
/** Max/min band ratio above which the axis goes logarithmic. */
const LOG_RATIO = 30

/** X-axis tick label chosen by span: HH:MM inside two days, else a short date. */
function axisTickLabel(ms: number, spanMs: number): string {
  const d = new Date(ms)
  if (spanMs > AXIS_DATE_THRESHOLD_MS) {
    return d.toLocaleDateString(undefined, { month: "short", day: "numeric" })
  }
  const h = d.getHours()
  const m = d.getMinutes().toString().padStart(2, "0")
  return `${h}:${m}`
}

/** Largest power of ten ≤ v (the log-axis floor). */
function decadeFloor(v: number): number {
  return 10 ** Math.floor(Math.log10(Math.max(1, v)))
}
/** Smallest power of ten ≥ v (the log-axis ceiling). */
function decadeCeil(v: number): number {
  return 10 ** Math.ceil(Math.log10(Math.max(1, v)))
}
/** Decade tick values across [floor, ceil], inclusive. */
function decadeTicks(floor: number, ceil: number): Array<number> {
  const ticks: Array<number> = []
  for (let v = floor; v <= ceil; v *= 10) ticks.push(v)
  return ticks
}

/** Distinct bucket times for x ticks — avoids duplicate labels when the active
 *  span is tiny (a degenerate domain would otherwise repeat one time N times). */
function sampleTimeTicks(
  points: Array<TrafficPoint>,
  maxTicks: number,
): Array<number> {
  if (points.length <= maxTicks) return points.map((p) => p.t)
  const step = Math.ceil(points.length / maxTicks)
  const out: Array<number> = []
  for (let i = 0; i < points.length; i += step) out.push(points[i].t)
  const lastT = points.at(-1)?.t
  if (lastT !== undefined && out.at(-1) !== lastT) out.push(lastT)
  return out
}

interface Range {
  maxBand: number
  minNonzero: number
  firstActive: number
  lastActive: number
}

/** Dynamic range across every point × band, and the first/last bucket indexes
 *  that carry any traffic (the active span the plot is trimmed to). */
function describeRange(data: ReadonlyArray<TrafficPoint>): Range {
  let maxBand = 0
  let minNonzero = Number.POSITIVE_INFINITY
  let firstActive = -1
  let lastActive = -1
  for (const [i, p] of data.entries()) {
    if (trafficTotal(p) > 0) {
      if (firstActive < 0) firstActive = i
      lastActive = i
    }
    for (const band of TRAFFIC_BANDS) {
      const v = p[band.key]
      if (v > maxBand) maxBand = v
      if (v > 0 && v < minNonzero) minNonzero = v
    }
  }
  return { maxBand, minNonzero, firstActive, lastActive }
}

/** Time (x) + token-magnitude (y) axes, matching AreaTrend's muted styling. */
function TrendAxes({
  xScale,
  yScale,
  innerH,
  spanMs,
  yTicks,
  xTicks,
}: {
  xScale: AxisScale<number>
  yScale: AxisScale<number>
  innerH: number
  spanMs: number
  yTicks: Array<number> | undefined
  xTicks: Array<number>
}): React.ReactElement {
  const labelColor = "var(--text-muted)"
  return (
    <>
      <AxisLeft
        scale={yScale}
        numTicks={4}
        tickValues={yTicks}
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
        tickValues={xTicks}
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

/** Per-band lines (broken at empty buckets) plus a dot at every real sample. */
function TrendSeries({
  points,
  xOf,
  yOf,
}: {
  points: Array<TrafficPoint>
  xOf: (p: TrafficPoint) => number
  yOf: (v: number) => number
}): React.ReactElement {
  return (
    <>
      {TRAFFIC_BANDS.map((band) => (
        <Group key={band.key}>
          <LinePath<TrafficPoint>
            data={points}
            x={xOf}
            y={(p) => yOf(p[band.key])}
            defined={(p) => p[band.key] > 0}
            stroke={band.color}
            strokeWidth={1.5}
            strokeLinecap="round"
            strokeLinejoin="round"
          />
          {points
            .filter((p) => p[band.key] > 0)
            .map((p) => (
              <circle
                key={`${band.key}-${p.t}`}
                cx={xOf(p)}
                cy={yOf(p[band.key])}
                r={2}
                fill={band.color}
              />
            ))}
        </Group>
      ))}
    </>
  )
}

export function PeriodTrend({
  data,
  periodLabel,
  height = 200,
}: {
  data: ReadonlyArray<TrafficPoint>
  periodLabel: string
  height?: number
}): React.ReactElement {
  const [ref, width] = useMeasure()

  const { maxBand, minNonzero, firstActive, lastActive } = describeRange(data)
  if (firstActive < 0) {
    return (
      <div className="usage-chart" ref={ref}>
        <p className="usage-chart__empty">No traffic {periodLabel}</p>
      </div>
    )
  }

  // Trim to the active span so the plot spends its width on real data.
  const points = data.slice(firstActive, lastActive + 1)
  const first = points[0]
  const last = points.at(-1) ?? first
  const spanMs = last.t - first.t

  const innerW = Math.max(1, width - MARGIN.left - MARGIN.right)
  const innerH = Math.max(1, height - MARGIN.top - MARGIN.bottom)

  const xScale = scaleLinear<number>({
    domain: first.t === last.t ? [first.t, first.t + 1] : [first.t, last.t],
    range: [0, innerW],
  })

  // Wide range → a TRUE log axis on [decade floor, decade ceil]; zeros are never
  // plotted (lines break at gaps), so log stays well-defined. Else plain linear.
  const useLog = maxBand / minNonzero > LOG_RATIO
  const floor = decadeFloor(minNonzero)
  const ceil = decadeCeil(maxBand)
  const yScale =
    useLog ?
      scaleLog<number>({ domain: [floor, ceil], range: [innerH, 0] })
    : scaleLinear<number>({
        domain: [0, maxBand],
        range: [innerH, 0],
        nice: true,
      })

  const xOf = (p: TrafficPoint): number => xScale(p.t)
  const xTickCount = Math.min(6, Math.max(2, Math.floor(innerW / 90)))
  const xTicks = sampleTimeTicks(points, xTickCount)

  return (
    <div className="usage-chart" ref={ref}>
      <svg
        width={width}
        height={height}
        role="img"
        aria-label={`Token usage by type — ${periodLabel}`}
        className="usage-chart__svg"
      >
        <Group left={MARGIN.left} top={MARGIN.top}>
          <TrendAxes
            xScale={xScale}
            yScale={yScale}
            innerH={innerH}
            spanMs={spanMs}
            yTicks={useLog ? decadeTicks(floor, ceil) : undefined}
            xTicks={xTicks}
          />
          <TrendSeries points={points} xOf={xOf} yOf={(v) => yScale(v)} />
          {useLog && (
            <text
              x={innerW}
              y={-4}
              fontSize={10}
              fill="var(--text-muted)"
              textAnchor="end"
            >
              log scale
            </text>
          )}
        </Group>
      </svg>
    </div>
  )
}
