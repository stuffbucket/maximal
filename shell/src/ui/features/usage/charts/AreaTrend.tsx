import { LinearGradient } from "@visx/gradient"
import { scaleLinear } from "@visx/scale"
import { AreaStack } from "@visx/shape"
import { useId } from "react"

import { useMeasure } from "./useMeasure"

/**
 * A stacked-area trend of token traffic over time, banded by token type
 * (input / output / cache). Headless visx primitives styled entirely from the
 * viz design tokens — the design system owns every pixel. Purely a function of
 * its data: it re-renders as new points arrive (the live "motion" is real data,
 * not a decorative tween), so there is nothing to gate on reduced-motion here.
 */

export interface TrendPoint {
  /** Bucket start (ms) — used only for ordering/labels, not spacing. */
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

function stackTotal(p: TrendPoint): number {
  return p.input + p.output + p.cache
}

export function AreaTrend({
  data,
  height = 140,
  ariaLabel,
}: {
  data: ReadonlyArray<TrendPoint>
  height?: number
  ariaLabel?: string
}): React.ReactElement {
  const [ref, width] = useMeasure()
  const gradientId = useId()

  const points =
    data.length > 0 ? data : [{ t: 0, input: 0, output: 0, cache: 0 }]
  const maxTotal = Math.max(1, ...points.map((p) => stackTotal(p)))
  const firstT = points[0].t
  const lastT = points.at(-1)?.t ?? firstT
  // Both data sources are uniformly time-stepped, so a time-domain scale spaces
  // buckets evenly. Guard the degenerate single-point domain.
  const xScale = scaleLinear<number>({
    domain: firstT === lastT ? [firstT, firstT + 1] : [firstT, lastT],
    range: [0, width],
  })
  const yScale = scaleLinear<number>({
    domain: [0, maxTotal],
    range: [height, 0],
    nice: false,
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
      </svg>
    </div>
  )
}
