import type { BudgetActivityResponse } from "../../../../../src/lib/config/settings-types";

import {
  type ActivityGroup,
  type ActivitySegment,
  columnHeights,
  formatDayKey,
  topSegments,
} from "./format";
import type { BudgetFormat } from "./hooks";
import { segmentName } from "./labels";
import { t } from "../../../i18n";

/** How many parts the bar shows before the rest fold into "Other": five series colors and a neutral. */
export const MAX_SEGMENTS = 6;

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
 * widths are shares of the period's spend, the table beside it names each part
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
 * Spend per day as columns on one baseline, each as tall as its share of the
 * busiest day. The busiest day is labelled with its figure; the first and last
 * days name the span; every day's figure is in the table and the tooltip.
 */
function DayColumns({ activity, format }: ChartProps): JSX.Element {
  const heights = columnHeights(activity.rows);
  const peak = heights.indexOf(Math.max(...heights));
  const last = activity.rows.length - 1;
  const summary = activity.rows
    .map((row) => `${formatDayKey(row.key ?? "", format.locale)}: ${format.money(row.amount)}`)
    .join("; ");
  return (
    <div className="budget-columns" role="img" aria-label={t("budget-chart-days-label", { summary })}>
      {activity.rows.map((row, index) => {
        const day = formatDayKey(row.key ?? "", format.locale);
        return (
          <div
            className="budget-column"
            key={row.key ?? index}
            title={`${day}: ${format.money(row.amount)}`}
          >
            <span className="budget-column__value">{index === peak ? format.money(row.amount) : ""}</span>
            <span className="budget-column__track">
              <span className="budget-column__bar" style={{ height: `${heights[index] * 100}%` }} />
            </span>
            <span className="budget-column__label">{index === 0 || index === last ? day : ""}</span>
          </div>
        );
      })}
    </div>
  );
}

/** The chart that fits the grouping: columns for days, a share bar for everything else. */
export function ActivityChart({ activity, format }: ChartProps): JSX.Element | null {
  if (activity.rows.length === 0) return null;
  return activity.group === "day" ?
      <DayColumns activity={activity} format={format} />
    : <ShareBar activity={activity} format={format} />;
}
