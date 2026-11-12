import { useState } from "react";

import { t } from "../../../i18n";
import { Button } from "../../components/Button";
import { EmptyState } from "../../components/EmptyState";
import { ProblemCallout } from "../../components/ProblemCallout";

import { formatInstant } from "./format";
import type { BudgetFormat } from "./hooks";
import { amountIn } from "./labels";
import { RangePicker } from "./RangePicker";
import { type RangeChoice, isRangeReady, rangeChoice } from "./range";
import { MarkerGlyph, TimelineChart } from "./TimelineChart";
import { type Timeline, markerCounts, periodRows, timelineHasActivity } from "./timeline";
import { useLimitTimeline } from "./useLimitTimeline";

interface RuleTimelineProps {
  /** The rule's id and the name its region is labelled with. */
  id: string;
  name: string;
  /** What the rule counts in: cost (money) or tokens. */
  unit: "cost" | "tokens";
  format: BudgetFormat;
  /** Moves whenever the budget changes, so the history refetches with it. */
  version: number;
}

/** Periods shown before "Show all". */
const VISIBLE_PERIODS = 5;

function Totals({
  timeline,
  format,
  unit,
}: {
  timeline: Timeline;
  format: BudgetFormat;
  unit: "cost" | "tokens";
}): JSX.Element {
  const { totals } = timeline;
  const amount = amountIn(unit, format);
  const count = (value: number): string => value.toLocaleString(format.locale);
  return (
    <dl className="budget-totals__parts rule-detail__totals">
      <div>
        <dt className="budget-totals__label">{t("budget-timeline-spent")}</dt>
        <dd>{amount(totals.nano_aiu)}</dd>
      </div>
      <div>
        <dt className="budget-totals__label">{t("dashboard-col-requests")}</dt>
        <dd>{count(totals.requests)}</dd>
      </div>
      <div>
        <dt className="budget-totals__label">{t("budget-timeline-periods-crossed")}</dt>
        <dd>{count(totals.periods_crossed)}</dd>
      </div>
      <div>
        <dt className="budget-totals__label">{t("budget-timeline-refused")}</dt>
        <dd>
          {count(totals.refused)}
          {totals.refused_estimate_nano_aiu > 0 && (
            <span className="rule-detail__worth">
              {t("budget-timeline-refused-worth", { amount: amount(totals.refused_estimate_nano_aiu) })}
            </span>
          )}
        </dd>
      </div>
    </dl>
  );
}

function Legend({ timeline }: { timeline: Timeline }): JSX.Element {
  const counts = markerCounts(timeline);
  return (
    <ul className="timeline__legend">
      {(["warned", "crossed", "refused"] as const).map((kind) => (
        <li key={kind}>
          <MarkerGlyph kind={kind} />
          <span>{t(`budget-legend-${kind}`)}</span>
          <strong>{counts[kind].toLocaleString()}</strong>
        </li>
      ))}
    </ul>
  );
}

function Periods({
  timeline,
  format,
  unit,
}: {
  timeline: Timeline;
  format: BudgetFormat;
  unit: "cost" | "tokens";
}): JSX.Element | null {
  const [showAll, setShowAll] = useState(false);
  const amount = amountIn(unit, format);
  const rows = periodRows(timeline);
  if (rows.length === 0) return null;
  const shown = showAll ? rows : rows.slice(0, VISIBLE_PERIODS);
  const when = (iso: string | null): string => (iso === null ? "—" : formatInstant(iso, format.locale, true));
  return (
    <div className="rule-detail__periods">
      <table className="table budget-table">
        <caption className="sr-only">{t("budget-periods-caption")}</caption>
        <thead>
          <tr>
            <th scope="col">{t("budget-periods-col-period")}</th>
            <th scope="col" className="budget-table__number">
              {t("budget-periods-col-spent")}
            </th>
            <th scope="col" className="budget-table__number">
              {t("budget-periods-col-warned")}
            </th>
            <th scope="col" className="budget-table__number">
              {t("budget-periods-col-crossed")}
            </th>
            <th scope="col" className="budget-table__number">
              {t("budget-periods-col-refused")}
            </th>
          </tr>
        </thead>
        <tbody>
          {shown.map((period) => (
            <tr key={period.start}>
              <th scope="row" className="budget-table__row">
                {formatInstant(period.start, format.locale)}
                {period.estimated && (
                  <span className="chip rule-detail__estimated" title={t("budget-periods-estimated-tip")}>
                    {t("budget-periods-estimated")}
                  </span>
                )}
              </th>
              <td className="budget-table__number">{amount(period.spendNanoAiu)}</td>
              <td className="budget-table__number">{when(period.warnedAt)}</td>
              <td className="budget-table__number">{when(period.crossedAt)}</td>
              <td className="budget-table__number">{period.refused.toLocaleString(format.locale)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {rows.length > VISIBLE_PERIODS && (
        <div>
          <Button variant="ghost" size="sm" onClick={() => setShowAll((open) => !open)} aria-expanded={showAll}>
            {showAll ? t("budget-show-fewer") : t("budget-show-all", { n: rows.length })}
          </Button>
        </div>
      )}
    </div>
  );
}

/**
 * How one rule has performed: a range picker, the totals (spent, requests,
 * periods crossed, requests refused), the timeline, and the periods behind
 * it. Opens under the rule's row, so the rule and its history are read
 * together. Loads only while it is mounted (the row mounts it when opened).
 */
export function RuleTimeline({ id, name, unit, format, version }: RuleTimelineProps): JSX.Element {
  const [choice, setChoice] = useState<RangeChoice>(() => rangeChoice("30d", Date.now()));
  const { timeline, isLoading, problem, refresh } = useLimitTimeline(id, choice, version);
  const ready = isRangeReady(choice);

  return (
    <div className="rule-detail" role="region" aria-label={t("budget-timeline-region", { name })} aria-busy={isLoading}>
      <RangePicker id={`rule-${id}-range`} value={choice} onChange={setChoice} />
      {problem && ready && <ProblemCallout problem={problem} onRetry={refresh} onRestarted={refresh} />}
      {!ready && <p className="panel-status">{t("budget-range-incomplete")}</p>}
      {ready && !timeline && isLoading && <p className="panel-status">{t("budget-loading-timeline")}</p>}
      {ready && timeline && !timelineHasActivity(timeline) && (
        <EmptyState title={t("budget-timeline-empty-title")} compact>
          <p>{t("budget-timeline-empty-body")}</p>
        </EmptyState>
      )}
      {ready && timeline && timelineHasActivity(timeline) && (
        <>
          <Totals timeline={timeline} format={format} unit={unit} />
          <TimelineChart timeline={timeline} format={format} unit={unit} />
          <Legend timeline={timeline} />
          {timeline.periods.some((period) => period.estimated) && (
            <p className="section__sub">{t("budget-timeline-estimated")}</p>
          )}
          <Periods timeline={timeline} format={format} unit={unit} />
        </>
      )}
    </div>
  );
}
