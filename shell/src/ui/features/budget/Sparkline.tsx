import { sparkPoints } from "./timeline";

interface SparklineProps {
  /** Spend per bucket, 0 to 1 of the busiest, oldest first. */
  values: ReadonlyArray<number>;
  /** What it shows, as the tooltip. The button around it carries the same words for screen readers. */
  label: string;
}

/**
 * A rule's recent spend as a line: one point per bucket, the busiest at the
 * top. It is a glance, not a chart, so it carries no axes or numbers; the
 * label gives the figures and the timeline under it the rest. A rule that
 * counted nothing is a flat line on the baseline.
 */
export function Sparkline({ values, label }: SparklineProps): JSX.Element | null {
  if (values.length === 0) return null;
  return (
    <svg className="spark" viewBox="0 0 100 24" preserveAspectRatio="none" aria-hidden="true">
      <title>{label}</title>
      <line className="spark__base" x1="0" y1="22" x2="100" y2="22" />
      <polyline className="spark__line" points={sparkPoints(values)} />
    </svg>
  );
}
