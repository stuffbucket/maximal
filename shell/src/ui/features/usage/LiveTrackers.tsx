import { useEffect, useRef, useState } from "react"

import type { LiveTotals } from "./useUsage"

import { useReducedMotion } from "./charts/useReducedMotion"
import { formatNumber } from "./format"

/**
 * The live tracker strip (§4) — five counters across the top of the Usage view
 * driven directly from the WS stream, so they tick within ~1s of real traffic
 * (unlike the throttled summary refetch). Deliberately NOT a KPI-tile grid: one
 * typographic stat ROW (no card chrome) that blurs to a single band. Each
 * counter is a sentence-case label in its token-TYPE viz color + a 2px top
 * accent rule + a big mono tabular number; the Total is neutral (it's the sum)
 * and the largest. The moving numbers are themselves the liveness signal — no
 * status dot.
 */

/** Count-up interpolation duration. Kept ≤150ms per the motion contract; snaps
 *  instantly under reduced motion (below). */
const COUNTUP_MS = 150

/**
 * Interpolate a displayed integer toward `target` over `COUNTUP_MS` via rAF so
 * the digits glide rather than jump. Reduced motion is a literal contract: snap
 * to the target with no animation. Also snaps where rAF is unavailable.
 */
function useCountUp(target: number, reduced: boolean): number {
  const [shown, setShown] = useState(target)
  const fromRef = useRef(target)
  const frameRef = useRef<number | null>(null)

  useEffect(() => {
    if (reduced || typeof requestAnimationFrame !== "function") {
      fromRef.current = target
      setShown(target)
      return
    }
    const from = fromRef.current
    if (from === target) return
    const start = performance.now()
    const step = (): void => {
      const p = Math.min(1, (performance.now() - start) / COUNTUP_MS)
      const value = Math.round(from + (target - from) * p)
      fromRef.current = value
      setShown(value)
      if (p < 1) frameRef.current = requestAnimationFrame(step)
    }
    frameRef.current = requestAnimationFrame(step)
    return () => {
      if (frameRef.current !== null) cancelAnimationFrame(frameRef.current)
    }
  }, [target, reduced])

  return shown
}

interface Tracker {
  key: keyof LiveTotals
  label: string
  /** Label + top-rule color (a viz token var); neutral for the Total. */
  labelColor: string
  ruleColor: string
  /** The Total is the sum — emphasized largest, no viz color. */
  total?: boolean
}

/** Fixed order: Input, Output, Cached input, Cached output, Total. */
const TRACKERS: ReadonlyArray<Tracker> = [
  {
    key: "input",
    label: "Input",
    labelColor: "var(--viz-input)",
    ruleColor: "var(--viz-input)",
  },
  {
    key: "output",
    label: "Output",
    labelColor: "var(--viz-output)",
    ruleColor: "var(--viz-output)",
  },
  {
    key: "cacheRead",
    label: "Cached input",
    labelColor: "var(--viz-cache-read)",
    ruleColor: "var(--viz-cache-read)",
  },
  {
    key: "cacheCreation",
    label: "Cached output",
    labelColor: "var(--viz-cache-creation)",
    ruleColor: "var(--viz-cache-creation)",
  },
  {
    key: "total",
    label: "Total",
    labelColor: "var(--text-strong)",
    ruleColor: "var(--border-strong)",
    total: true,
  },
]

function Counter({
  tracker,
  value,
  reduced,
}: {
  tracker: Tracker
  value: number
  reduced: boolean
}): React.ReactElement {
  const shown = useCountUp(value, reduced)
  return (
    <div
      className={
        tracker.total ?
          "usage-trackers__item usage-trackers__item--total"
        : "usage-trackers__item"
      }
      style={{ borderTopColor: tracker.ruleColor }}
    >
      <span
        className="usage-trackers__label"
        style={{ color: tracker.labelColor }}
      >
        {tracker.label}
      </span>
      <span className="usage-trackers__value">{formatNumber(shown)}</span>
    </div>
  )
}

export function LiveTrackers({
  totals,
}: {
  totals: LiveTotals
}): React.ReactElement {
  const reduced = useReducedMotion()

  return (
    <div
      className="usage-trackers"
      role="group"
      aria-label="Live token counters"
    >
      {TRACKERS.map((t) => (
        <Counter
          key={t.key}
          tracker={t}
          value={totals[t.key]}
          reduced={reduced}
        />
      ))}
    </div>
  )
}
