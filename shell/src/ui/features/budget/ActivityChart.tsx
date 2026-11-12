import type { BudgetActivityResponse } from "../../../../../src/lib/config/settings-types";

import {
  type ActivityGroup,
  type ActivitySegment,
  columnHeights,
  formatDayKey,
  formatHourKey,
  isTimeGroup,
  timeSeries,
  topSegments,
} from "./format";
import type { BudgetFormat } from "./hooks";
import { segmentName } from "./labels";
import { t } from "../../../i18n";

/** How many parts the bar shows before the rest fold into "Other": five series colors and a neutral. */
export const MAX_SEGMENTS = 6;

/** Up to this many columns each gets its own gap and every figure in the chart's label; past it they pack. */
const SPARSE_COLUMNS = 40;
const PACKED_COLUMNS = 120;

/** The mark color for the nth part: the design system's series ramp, a neutral for "Other". */
export function segmentColor(other: boolean, index: number): string {
  return other ? "var(--border-strong)" : `var(--series-${index + 1})`;
}

interface ChartProps {
  activity: BudgetActivityResponse;
  format: BudgetFormat;
}

/** One line a tooltip and a screen reader can share: "gpt-6: $1.20, 14 requests, 32%". */
function describeSegment(group: ActivityGroup, segment: ActivitySegment, format: BudgetFormat): string {
  return t("budget-chart-tip", {
    name: segmentName(group, segment.key, segment.other, format.locale),
    amount: format.money(segment.amount),
    requests: segment.requests,
    share: segment.share,
  });
}

/**
 * Spend by model, plugin, client key or provider as one thin segmented bar:
 * widths are shares of the range's spend, the table beside it names each part
 * (a swatch on every row stands in for a legend). Five parts get their own
 * series color; the rest fold into one neutral "Other".
 */
function ShareBar({ activity, format }: ChartProps): JSX.Element {
  const segments = topSegments(activity.rows, MAX_SEGMENTS);
  const summary = segments.map((segment) => describeSegment(activity.group, segment, format)).join("; ");
  return (
    <div className="budget-share" role="img" aria-label={t("budget-chart-share-label", { summary })}>
      {segments.map((segment, index) => (
        <span
          key={segment.other ? "other" : (segment.key ?? "none")}
          className="budget-share__part"
          style={{ flexGrow: segment.nanoAiu, backgroundColor: segmentColor(segment.other, index) }}
          title={describeSegment(activity.group, segment, format)}
        />
      ))}
    </div>
  );
}

/**
 * Spend per day or hour as columns on one baseline, each as tall as its share
 * of the busiest one, with the quiet ones drawn at their place on the time
 * axis. The first and last buckets name the span and the busiest is named
 * under it; every figure is in the table and in each column's tooltip. A long
 * span packs its columns closer, and the chart's label then names only the
 * busiest instead of reading out hundreds of figures.
 */
function TimeColumns({ activity, format }: ChartProps): JSX.Element {
  const group = activity.group === "hour" ? "hour" : "day";
  const rows = timeSeries(activity.rows, group, activity.range);
  const heights = columnHeights(rows);
  const tallest = Math.max(...heights);
  const peak = tallest > 0 ? heights.indexOf(tallest) : -1;
  const nameOf = (key: string | null): string =>
    group === "hour" ? formatHourKey(key ?? "", format.locale) : formatDayKey(key ?? "", format.locale);
  const first = rows[0];
  const last = rows[rows.length - 1];
  const busiest = peak === -1 ? "" : t("budget-chart-busiest", { when: nameOf(rows[peak]?.key ?? null), amount: format.money(rows[peak]?.amount ?? 0) });
  const summary =
    rows.length <= SPARSE_COLUMNS ?
      rows.map((row) => `${nameOf(row.key)}: ${format.money(row.amount)}`).join("; ")
    : busiest;
  const labelKey = group === "hour" ? "budget-chart-hours-label" : "budget-chart-days-label";
  const density =
    rows.length <= SPARSE_COLUMNS ? ""
    : rows.length <= PACKED_COLUMNS ? " budget-columns--dense"
    : " budget-columns--packed";
  return (
    <div className="budget-timeline">
      <div className={`budget-columns${density}`} role="img" aria-label={t(labelKey, { summary })}>
        {rows.map((row, index) => (
          <div className="budget-column" key={row.key ?? index} title={`${nameOf(row.key)}: ${format.money(row.amount)}`}>
            <span className="budget-column__track">
              <span
                className={`budget-column__bar${heights[index] === 0 ? " budget-column__bar--empty" : ""}`}
                style={{ height: `${heights[index] * 100}%` }}
              />
            </span>
          </div>
        ))}
      </div>
      <p className="budget-columns__axis" aria-hidden="true">
        <span>{first ? nameOf(first.key) : ""}</span>
        <span>{busiest}</span>
        <span>{last && last !== first ? nameOf(last.key) : ""}</span>
      </p>
    </div>
  );
}

/** The chart that fits the grouping: columns for days and hours, a share bar for everything else. */
export function ActivityChart({ activity, format }: ChartProps): JSX.Element | null {
  if (activity.rows.length === 0) return null;
  if (isTimeGroup(activity.group)) return <TimeColumns activity={activity} format={format} />;
  // Nothing was spent (every row is free), so there are no shares to draw.
  if (!activity.rows.some((row) => row.nano_aiu > 0)) return null;
  return <ShareBar activity={activity} format={format} />;
}
