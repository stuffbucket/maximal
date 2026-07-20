import { AxisBottom, AxisLeft, type AxisScale } from "@visx/axis"
import { LinearGradient } from "@visx/gradient"
import { Group } from "@visx/group"
import { scaleLinear } from "@visx/scale"
import { AreaStack } from "@visx/shape"
import { useId } from "react"

import { formatCompact } from "../format"
import { useMeasure } from "./useMeasure"

/**
 * A stacked-area trend of token traffic over time, banded by token type
 * (input / output / cache). Headless visx primitives styled entirely from the
 * viz design tokens — the design system owns every pixel. Purely a function of
 * its data: it re-renders as new points arrive (the live "motion" is real data,
 * not a decorative tween), so there is nothing to gate on reduced-motion here.
 * With `showAxes`, a time x-axis and a token-magnitude y-axis are drawn so the
 * timeframe is legible.
 */

export interface TrendPoint {
  /** Bucket start (ms) — the x position, and the axis label source. */
  t: number
  input: number
  output: number
  cache: number
}

type BandKey = "input" | "output" | "cache"
const BANDS: ReadonlyArray<BandKey> = ["input", "output", "cache"]
const BAND_COLOR: Record<BandKey, string> = {
  input: "var(--viz-input)",
  output: "var(--viz-output)",
  cache: "var(--viz-cache)",
}

const AXIS_MARGIN = { top: 8, right: 14, bottom: 22, left: 48 }
const BARE_MARGIN = { top: 4, right: 0, bottom: 2, left: 0 }

function stackTotal(p: TrendPoint): number {
  return p.input + p.output + p.cache
}

/** Local HH:MM clock label for an x-axis tick (unpinned locale is fine here). */
function clockLabel(ms: number): string {
  const d = new Date(ms)
  const h = d.getHours()
  const m = d.getMinutes().toString().padStart(2, "0")
  return `${h}:${m}`
}

/** Local HH:MM clock label for an x-axis tick (unpinned locale is fine here). */
function clockLabel(ms: number): string {
  const d = new Date(ms)
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
}: {
  xScale: AxisScale<number>
  yScale: AxisScale<number>
  innerH: number
  innerW: number
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
        tickFormat={(v) => clockLabel(Number(v))}
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
  data: ReadonlyArray<TrendPoint>
  height?: number
  ariaLabel?: string
  showAxes?: boolean
}): React.ReactElement {
  const [ref, width] = useMeasure()
  const gradientId = useId()

  const points =
    data.length > 0 ? data : [{ t: 0, input: 0, output: 0, cache: 0 }]
  const maxTotal = Math.max(1, ...points.map((p) => stackTotal(p)))
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
        {BANDS.map((band) => (
          <LinearGradient
            key={band}
            id={`${gradientId}-${band}`}
            from={BAND_COLOR[band]}
            to={BAND_COLOR[band]}
            fromOpacity={0.55}
            toOpacity={0.12}
          />
        ))}
        <Group left={margin.left} top={margin.top}>
          <AreaStack<TrendPoint>
            keys={BANDS as Array<BandKey>}
            data={points as Array<TrendPoint>}
            x={(d) => xScale(d.data.t)}
            y0={(d) => yScale(d[0])}
            y1={(d) => yScale(d[1])}
            value={(d, key) => d[key as BandKey]}
          >
            {({ stacks, path }) =>
              stacks.map((stack) => {
                const band = stack.key as BandKey
                return (
                  <path
                    key={`stack-${band}`}
                    d={path(stack) ?? ""}
                    fill={`url(#${gradientId}-${band})`}
                    stroke={BAND_COLOR[band]}
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
            />
          )}
        </Group>
      </svg>
    </div>
  )
}
