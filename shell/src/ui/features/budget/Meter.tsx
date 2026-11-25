import { cx } from "../../components/cx";

import type { MeterTone } from "./format";

interface MeterProps {
  /** How full, 0 to 1. */
  fraction: number;
  tone: MeterTone;
  /** What the meter measures, for screen readers. */
  label: string;
  /** The figures behind it ("$2.40 of $3.00"), for screen readers. */
  valueText: string;
}

/**
 * The Dashboard's quota meter: the fill is the state (accent while fine,
 * warning, error), the track a pale step of the same color. The row beside it
 * carries the words and icon, so state never rests on color alone.
 */
export function Meter({ fraction, tone, label, valueText }: MeterProps): JSX.Element {
  return (
    <div
      className={cx("budget-meter", `budget-meter--${tone}`)}
      role="meter"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(fraction * 100)}
      aria-valuetext={valueText}
    >
      <div className="budget-meter__fill" style={{ width: `${fraction * 100}%` }} />
    </div>
  );
}
