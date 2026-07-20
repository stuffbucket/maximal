/**
 * The four token-type bands shared by every Usage chart and the tracker strip,
 * so counters, the near-term hero, and the period trend all read as ONE color
 * language. Stack order is bottom→top: input, output, cached input, cached
 * output. Colors are the viz tokens (never inline hex) — the same vars the
 * tracker labels use.
 */

/** One time sample split by token type (the shape both charts consume). */
export interface TrafficPoint {
  t: number
  input: number
  output: number
  cacheRead: number
  cacheCreation: number
}

export type TrafficBandKey = "input" | "output" | "cacheRead" | "cacheCreation"

export interface TrafficBand {
  key: TrafficBandKey
  label: string
  /** A viz design-token var, matching the tracker strip's per-counter color. */
  color: string
}

export const TRAFFIC_BANDS: ReadonlyArray<TrafficBand> = [
  { key: "input", label: "Input", color: "var(--viz-input)" },
  { key: "output", label: "Output", color: "var(--viz-output)" },
  { key: "cacheRead", label: "Cached input", color: "var(--viz-cache-read)" },
  {
    key: "cacheCreation",
    label: "Cached output",
    color: "var(--viz-cache-creation)",
  },
]

/** Sum of the four band values at a point (the stack height / total tokens). */
export function trafficTotal(p: TrafficPoint): number {
  return p.input + p.output + p.cacheRead + p.cacheCreation
}
