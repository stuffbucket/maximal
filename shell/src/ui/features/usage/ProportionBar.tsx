import { formatNumber } from "./format"

/**
 * Token-styled proportion visualizations for the Usage view (§4). Deliberately
 * NOT cards — these are single content blocks separated by typography. Colors
 * come from the viz tokens; widths are the only inline style (a proportion can't
 * be a token). `ProportionBar` is one stacked bar (the input/output/cache
 * split); `RankedBars` is a labeled list of bars (per-model / per-provider).
 */

export interface Segment {
  key: string
  label: string
  value: number
  /** A CSS color (viz token var). */
  color: string
}

export function ProportionBar({
  segments,
  ariaLabel,
}: {
  segments: ReadonlyArray<Segment>
  ariaLabel: string
}): React.ReactElement | null {
  const total = segments.reduce((acc, s) => acc + Math.max(0, s.value), 0)
  if (total <= 0) return null
  return (
    <div className="usage-proportion">
      <div className="usage-proportion__bar" role="img" aria-label={ariaLabel}>
        {segments.map((s) =>
          s.value > 0 ?
            <span
              key={s.key}
              className="usage-proportion__seg"
              style={{
                width: `${(s.value / total) * 100}%`,
                background: s.color,
              }}
            />
          : null,
        )}
      </div>
      <ul className="usage-proportion__legend">
        {segments.map((s) => (
          <li key={s.key} className="usage-proportion__legend-item">
            <span
              className="usage-proportion__swatch"
              style={{ background: s.color }}
              aria-hidden="true"
            />
            <span className="usage-proportion__legend-label">{s.label}</span>
            <span className="usage-proportion__legend-value">
              {formatNumber(s.value)}
            </span>
          </li>
        ))}
      </ul>
    </div>
  )
}

export interface RankedRow {
  key: string
  label: string
  value: number
  color: string
  /** Optional trailing meta (e.g. request count, cost). */
  meta?: string
  /** Optional badge (e.g. "premium"). */
  badge?: string
}

export function RankedBars({
  rows,
  ariaLabel,
}: {
  rows: ReadonlyArray<RankedRow>
  ariaLabel: string
}): React.ReactElement | null {
  if (rows.length === 0) return null
  const max = Math.max(1, ...rows.map((r) => r.value))
  return (
    <ul className="usage-ranked" aria-label={ariaLabel}>
      {rows.map((r) => (
        <li key={r.key} className="usage-ranked__row">
          <div className="usage-ranked__head">
            <span className="usage-ranked__label">
              {r.label}
              {r.badge ?
                <span className="usage-ranked__badge">{r.badge}</span>
              : null}
            </span>
            <span className="usage-ranked__value">
              {formatNumber(r.value)}
              {r.meta ?
                <span className="usage-ranked__meta"> · {r.meta}</span>
              : null}
            </span>
          </div>
          <div className="usage-ranked__track">
            <span
              className="usage-ranked__fill"
              style={{
                width: `${(r.value / max) * 100}%`,
                background: r.color,
              }}
            />
          </div>
        </li>
      ))}
    </ul>
  )
}
