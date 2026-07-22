import { AxisBottom, AxisLeft, type AxisScale } from "@visx/axis"
import { Group } from "@visx/group"
import { scaleLinear, scaleSymlog } from "@visx/scale"
import { LinePath } from "@visx/shape"

import type { TrafficBand, TrafficPoint } from "./traffic-bands"

import { formatCompact } from "../format"
import { TRAFFIC_BANDS, trafficTotal } from "./traffic-bands"
import { useMeasure } from "./useMeasure"

/**
 * "Where it went" — the period-reactive analytical trend that answers to the
 * Today/Week/Month/All pills (unlike the near-term live hero). A single period
 * mixes token types whose magnitudes span orders of magnitude — cached input can
 * be hundreds of millions while plain input is tens of thousands — so a linear
 * stacked area would flatten the small series into the axis. Instead each of the
 * four token bands is its OWN non-stacked line, drawn on a `scaleSymlog` y-axis
 * when the max/min range is wide (symlog is defined at 0, so empty buckets don't
 * puncture the line). Both axes are labeled; each line carries its value at the
 * last ACTIVE bucket as an end label (not the zero-filled tail). There is no
 * legend — the tracker strip above names the colors once. Static chart, so
 * nothing to gate on reduced-motion.
 */

const MARGIN = { top: 16, right: 60, bottom: 24, left: 46 }
/** Two days — above this span x-ticks read as dates, not clock times. */
const AXIS_DATE_THRESHOLD_MS = 2 * 86_400_000
/** Min vertical pixels between two end labels. */
const LABEL_MIN_GAP = 14
/** Max/min band ratio above which the axis switches to symlog. */
const SYMLOG_RATIO = 30
const AXIS_LABEL_COLOR = "var(--text-muted)"

/** X-axis tick label chosen by span: HH:MM within two days, else a short date. */
function axisTickLabel(ms: number, spanMs: number): string {
  const d = new Date(ms)
  if (spanMs > AXIS_DATE_THRESHOLD_MS) {
    return d.toLocaleDateString(undefined, { month: "short", day: "numeric" })
  }
  const h = d.getHours()
  const m = d.getMinutes().toString().padStart(2, "0")
  return `${h}:${m}`
}

/** Round decade tick values (0, 10K, 100K, …) up to the domain max, so a symlog
 *  axis spreads its labels instead of crowding them all near the top. */
function symlogTickValues(maxBand: number): Array<number> {
  const ticks: Array<number> = [0]
  for (let v = 10_000; v <= maxBand; v *= 10) ticks.push(v)
  return ticks
}

interface EndLabel {
  band: TrafficBand
  y: number
  text: string
}

/** The dynamic range across every point × band, plus the index of the last
 *  bucket with any traffic (where the value labels anchor). */
function describeRange(data: ReadonlyArray<TrafficPoint>): {
  maxBand: number
  minNonzero: number
  activeIdx: number
} {
  let maxBand = 0
  let minNonzero = Number.POSITIVE_INFINITY
  let activeIdx = -1
  for (const [i, p] of data.entries()) {
    if (trafficTotal(p) > 0) activeIdx = i
    for (const band of TRAFFIC_BANDS) {
      const v = p[band.key]
      if (v > maxBand) maxBand = v
      if (v > 0 && v < minNonzero) minNonzero = v
    }
  }
  return { maxBand, minNonzero, activeIdx }
}

/**
 * Each band's value at the last bucket with any traffic (so labels read real
 * numbers, not the zero-filled tail), sorted top→bottom and pushed apart by at
 * least LABEL_MIN_GAP so near-equal values don't collide. Zero values skipped.
 */
function endLabels(
  point: TrafficPoint,
  yOf: (v: number) => number,
  innerH: number,
): Array<EndLabel> {
  const ordered = TRAFFIC_BANDS.filter((band) => point[band.key] > 0)
    .map((band) => ({
      band,
      y: yOf(point[band.key]),
      text: formatCompact(point[band.key]),
    }))
    .sort((a, b) => a.y - b.y)
  let cursor = Number.NEGATIVE_INFINITY
  return ordered.map((item) => {
    const y = Math.min(Math.max(item.y, cursor + LABEL_MIN_GAP), innerH)
    cursor = y
    return { ...item, y }
  })
}

/** Time (x) + token-magnitude (y) axes, matching AreaTrend's muted styling. */
function TrendAxes({
  xScale,
  yScale,
  innerH,
  innerW,
  spanMs,
  yTicks,
}: {
  xScale: AxisScale<number>
  yScale: AxisScale<number>
  innerH: number
  innerW: number
  spanMs: number
  yTicks: Array<number> | undefined
}): React.ReactElement {
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
          fill: AXIS_LABEL_COLOR,
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
          fill: AXIS_LABEL_COLOR,
          fontSize: 11,
          textAnchor: "middle",
          dy: 2,
        })}
      />
    </>
  )
}

/** The per-band value labels at the last active bucket, stacked at one x. */
function EndValueLabels({
  labels,
  x,
}: {
  labels: Array<EndLabel>
  x: number
}): React.ReactElement {
  return (
    <>
      {labels.map((item) => (
        <text
          key={item.band.key}
          x={x}
          y={item.y}
          fontSize={11}
          fill={item.band.color}
          textAnchor="start"
          dominantBaseline="middle"
        >
          {item.text}
        </text>
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

  const { maxBand, minNonzero, activeIdx } = describeRange(data)

  if (maxBand === 0 || activeIdx < 0) {
    return (
      <div className="usage-chart" ref={ref}>
        <p className="usage-chart__empty">No traffic {periodLabel}</p>
      </div>
    )
  }

  const points = data as Array<TrafficPoint>
  const first = points[0]
  const last = points.at(-1) ?? first
  const spanMs = last.t - first.t

  const innerW = Math.max(1, width - MARGIN.left - MARGIN.right)
  const innerH = Math.max(1, height - MARGIN.top - MARGIN.bottom)

  const xScale = scaleLinear<number>({
    domain: first.t === last.t ? [first.t, first.t + 1] : [first.t, last.t],
    range: [0, innerW],
  })

  // Wide range → symlog (defined at 0, compresses the huge series so the tiny one
  // stays visible); otherwise plain linear. Both domains start at 0.
  const useSymlog = maxBand / minNonzero > SYMLOG_RATIO
  const domain: [number, number] = [0, maxBand * 1.1]
  const yScale =
    useSymlog ?
      scaleSymlog<number>({ domain, range: [innerH, 0] })
    : scaleLinear<number>({ domain, range: [innerH, 0], nice: true })

  const activePoint = points[activeIdx]
  const labelX = Math.min(xScale(activePoint.t) + 6, innerW)
  const labels = endLabels(activePoint, (v) => yScale(v), innerH)

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
            innerW={innerW}
            spanMs={spanMs}
            yTicks={useSymlog ? symlogTickValues(maxBand) : undefined}
          />

          {TRAFFIC_BANDS.map((band) => (
            <LinePath<TrafficPoint>
              key={band.key}
              data={points}
              x={(p) => xScale(p.t)}
              y={(p) => yScale(p[band.key])}
              stroke={band.color}
              strokeWidth={1.5}
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          ))}

          {useSymlog && (
            <text
              x={innerW}
              y={-4}
              fontSize={10}
              fill={AXIS_LABEL_COLOR}
              textAnchor="end"
            >
              log scale
            </text>
          )}

          <EndValueLabels labels={labels} x={labelX} />
        </Group>
      </svg>
    </div>
  )
}
