import { t } from "../../../i18n";

import { formatSpan } from "./format";
import type { BudgetFormat } from "./hooks";
import { amountIn } from "./labels";
import {
  type ChartMarker,
  type MarkerKind,
  type Timeline,
  chartModel,
  markerCounts,
} from "./timeline";

interface TimelineChartProps {
  timeline: Timeline;
  format: BudgetFormat;
  /** What the rule counts in, so its figures read as money or as tokens. */
  unit: "cost" | "tokens";
}

/** A marker's shape, so the three kinds differ without color: a triangle warns, a dot is the limit reached, a cross is a refusal. */
export function MarkerGlyph({ kind }: { kind: MarkerKind }): JSX.Element {
  return (
    <svg className={`marker marker--${kind}`} viewBox="0 0 12 12" aria-hidden="true">
      {kind === "warned" && <path d="M6 1.2 11 10.6H1Z" />}
      {kind === "crossed" && <circle cx="6" cy="6" r="4.6" />}
      {kind === "refused" && <path d="M2.2 2.2 9.8 9.8M9.8 2.2 2.2 9.8" />}
    </svg>
  );
}

function markerTitle(marker: ChartMarker, format: BudgetFormat, amount: (value: number) => string): string {
  const when = new Intl.DateTimeFormat(format.locale, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZone: "UTC",
  }).format(Date.parse(marker.at));
  if (marker.kind === "refused") {
    return t("budget-marker-refused-tip", { when, n: marker.count, amount: amount(marker.estimateNanoAiu) });
  }
  return t(marker.kind === "warned" ? "budget-marker-warned-tip" : "budget-marker-crossed-tip", { when });
}

/** The area under a run, closed along the baseline, in the plot's 0 to 100 box. */
function areaPath(points: ReadonlyArray<[number, number]>): string {
  const first = points[0];
  const last = points[points.length - 1];
  if (!first || !last) return "";
  const line = points.map(([x, y]) => `${(x * 100).toFixed(2)},${((1 - y) * 100).toFixed(2)}`);
  return `M${(first[0] * 100).toFixed(2)},100 L${line.join(" L")} L${(last[0] * 100).toFixed(2)},100 Z`;
}

/**
 * A rule's history: spend counted in each period climbing toward the limit
 * (and starting over where the period resets), the limit and warning lines,
 * where it warned, reached the limit and refused requests, and under it the
 * spend per bucket on its own scale. Everything is placed by time on one
 * axis. The plot is an image to a screen reader, which gets the figures in the
 * label, the legend and the periods table; sighted people get each marker's
 * time and count in its tooltip.
 */
export function TimelineChart({ timeline, format, unit }: TimelineChartProps): JSX.Element {
  const amount = amountIn(unit, format);
  const model = chartModel(timeline);
  const counts = markerCounts(timeline);
  const label = t("budget-timeline-chart-label", {
    limit: amount(timeline.limit.limit),
    peak: amount(model.peakNanoAiu),
    warned: counts.warned,
    crossed: counts.crossed,
    refused: counts.refused,
  });
  const bucket = timeline.range.bucket;
  return (
    <div className="timeline">
      <div className="timeline__plot" role="img" aria-label={label}>
        <svg className="timeline__svg" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
          {model.boundaries.map((x) => (
            <line key={x} className="timeline__boundary" x1={x * 100} y1="0" x2={x * 100} y2="100" />
          ))}
          <line className="timeline__warn" x1="0" y1={(1 - model.warnY) * 100} x2="100" y2={(1 - model.warnY) * 100} />
          <line className="timeline__limit" x1="0" y1={(1 - model.limitY) * 100} x2="100" y2={(1 - model.limitY) * 100} />
          {model.runs.map((run) => (
            <g key={run.periodStart}>
              <path className="timeline__area" d={areaPath(run.points)} />
              <polyline
                className="timeline__line"
                points={run.points.map(([x, y]) => `${(x * 100).toFixed(2)},${((1 - y) * 100).toFixed(2)}`).join(" ")}
              />
            </g>
          ))}
        </svg>
        <span className="timeline__tag timeline__tag--limit" style={{ top: `${(1 - model.limitY) * 100}%` }}>
          {t("budget-timeline-limit-label", { amount: amount(timeline.limit.limit) })}
        </span>
        <span className="timeline__tag timeline__tag--warn" style={{ top: `${(1 - model.warnY) * 100}%` }}>
          {t("budget-timeline-warn-label", { amount: amount(timeline.limit.warn_line) })}
        </span>
        {model.markers.map((marker) => (
          <span
            key={`${marker.kind}-${marker.at}`}
            className="timeline__marker"
            style={{ left: `${marker.x * 100}%`, top: `${(1 - marker.y) * 100}%` }}
            title={markerTitle(marker, format, amount)}
          >
            <MarkerGlyph kind={marker.kind} />
          </span>
        ))}
      </div>

      <div className="timeline__columns" aria-hidden="true">
        {model.columns.map((column) => (
          <span
            key={column.start}
            className="timeline__column"
            style={{ left: `${column.x0 * 100}%`, width: `${(column.x1 - column.x0) * 100}%` }}
          >
            <span
              className={`budget-column__bar${column.height === 0 ? " budget-column__bar--empty" : ""}`}
              style={{ height: `${column.height * 100}%` }}
              title={amount(column.nanoAiu)}
            />
          </span>
        ))}
      </div>
      <p className="budget-columns__axis">
        <span>{formatSpan(timeline.range.from, timeline.range.to, format.locale)}</span>
        <span>{t("budget-timeline-columns", { bucket })}</span>
      </p>
    </div>
  );
}
