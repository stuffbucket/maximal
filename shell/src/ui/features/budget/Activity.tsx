import { useState } from "react";

import { t } from "../../../i18n";
import { fetchBudgetCsv } from "../../../proxy/client";
import { saveTextFile } from "../../../tauri/shell";
import { Button } from "../../components/Button";
import { EmptyState } from "../../components/EmptyState";
import { ProblemCallout } from "../../components/ProblemCallout";
import { type Problem, describeProblem } from "../../problems";

import { ActivityChart, MAX_SEGMENTS, segmentColor } from "./ActivityChart";
import { DownloadGlyph } from "./glyphs";
import {
  ACTIVITY_GROUPS,
  type ActivityGroup,
  activityQuery,
  activityTotals,
  csvFileName,
  formatCompact,
  formatSpan,
  isTimeGroup,
  rowFigures,
  topSegments,
} from "./format";
import type { BudgetFormat } from "./hooks";
import { segmentName } from "./labels";
import { RangePicker } from "./RangePicker";
import { type RangeChoice, isRangeReady, rangeChoice } from "./range";
import { UsageTotals } from "./UsageTotals";
import { useBudgetActivity } from "./useBudgetActivity";

interface ActivityProps {
  format: BudgetFormat | null;
  /** Moves whenever the budget changes, so the figures refetch with it. */
  version: number;
}

/** Rows shown before "Show all": enough to read at a glance, not a wall. */
const VISIBLE_ROWS = 10;
/** The most rows the table draws when expanded; the statement has every one. */
const MAX_ROWS = 500;

/**
 * Activity: what was used over any range (24 hours to all time, or two days
 * you pick), by model, plugin, client key, provider, day or hour. It reads like
 * the Dashboard: a totals strip of the same measures (tokens in and out, cache,
 * requests, cost), then a chart and a table with those measures per row, and a
 * CSV statement of the same rows. A group that used nothing is still listed, as
 * on the Dashboard, so the rows add up to the totals.
 */
export function Activity({ format, version }: ActivityProps): JSX.Element {
  const [choice, setChoice] = useState<RangeChoice>(() => rangeChoice("7d", Date.now()));
  const [group, setGroup] = useState<ActivityGroup>("model");
  const [showAll, setShowAll] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [exportProblem, setExportProblem] = useState<Problem | null>(null);
  const { activity, isLoading, problem, refresh } = useBudgetActivity(choice, group, version);
  const ready = isRangeReady(choice);
  const fileName = csvFileName(choice, group);

  const exportCsv = async (): Promise<void> => {
    const query = activityQuery(choice, group);
    if (query === null) return;
    setExporting(true);
    setExportProblem(null);
    const result = await fetchBudgetCsv(query);
    if (result.ok) {
      const outcome = await saveTextFile(fileName, result.data);
      if (outcome === "failed") {
        setExportProblem({
          title: t("budget-export-failed-title"),
          detail: t("budget-export-failed-detail"),
          remedy: "none",
          technical: "save_text_file failed",
        });
      }
    } else {
      setExportProblem(describeProblem(result, { subject: "your spending" }));
    }
    setExporting(false);
  };

  // The rows belong to the grouping they were fetched for, which can trail the picker by a beat.
  const shownGroup = activity?.group ?? group;
  const timeGroup = isTimeGroup(shownGroup);
  const rows = activity?.rows ?? [];
  // Things biggest spender first; a span of time newest first, the chart reads it the other way.
  const sorted = timeGroup ? [...rows].reverse() : [...rows].sort((a, b) => b.nano_aiu - a.nano_aiu);
  const shown = showAll ? sorted.slice(0, MAX_ROWS) : sorted.slice(0, VISIBLE_ROWS);
  // The same parts the share bar draws, so each row's swatch matches its segment.
  const charted = !timeGroup && rows.some((row) => row.nano_aiu > 0);
  const segments = charted ? topSegments(rows, MAX_SEGMENTS) : [];
  const colorOf = (key: string | null): string | undefined => {
    if (!charted) return undefined;
    const index = segments.findIndex((segment) => !segment.other && segment.key === key);
    return index === -1 ? segmentColor(true, 0) : segmentColor(false, index);
  };
  const span =
    ready && activity?.range && format ?
      activity.range.label === "all" ?
        t("budget-activity-sub-all")
      : t("budget-activity-sub", { span: formatSpan(activity.range.from, activity.range.to, format.locale) })
    : t("budget-activity-sub-plain");

  return (
    <section className="budget-block" aria-labelledby="budget-activity-title">
      <header className="budget-block__head">
        <div className="section__head">
          <h2 className="budget-block__title" id="budget-activity-title">
            {t("budget-activity-title")}
          </h2>
          <p className="section__sub">{span}</p>
        </div>
        <Button
          variant="secondary"
          onClick={() => void exportCsv()}
          disabled={exporting || !ready || rows.length === 0}
          title={t("budget-export-tip", {
            file: fileName,
            group: t(`budget-group-${group}`),
          })}
        >
          <DownloadGlyph />
          {exporting ? t("common-working") : t("budget-export")}
        </Button>
      </header>

      <div className="budget-controls">
        <RangePicker
          id="budget-activity-range"
          value={choice}
          onChange={(next) => {
            setChoice(next);
            setShowAll(false);
          }}
        />
        <div className="budget-field budget-field--inline">
          <label htmlFor="budget-group">{t("budget-group-label")}</label>
          <select
            id="budget-group"
            className="select"
            value={group}
            onChange={(event) => {
              setGroup(event.target.value as ActivityGroup);
              setShowAll(false);
            }}
          >
            {ACTIVITY_GROUPS.map((value) => (
              <option key={value} value={value}>
                {t(`budget-group-${value}`)}
              </option>
            ))}
          </select>
        </div>
      </div>

      {problem && ready && <ProblemCallout problem={problem} onRetry={refresh} onRestarted={refresh} />}
      {exportProblem && <ProblemCallout problem={exportProblem} />}
      {!ready && <p className="panel-status">{t("budget-range-incomplete")}</p>}
      {ready && activity && activity.rows.length === 0 && !problem && (
        <EmptyState title={t("budget-activity-empty-title")}>
          <p>{t("budget-activity-empty-body")}</p>
        </EmptyState>
      )}
      {ready && !activity && isLoading && <p className="panel-status">{t("budget-loading-activity")}</p>}

      {ready && activity && format && rows.length > 0 && (
        <div className="budget-activity" aria-busy={isLoading}>
          <UsageTotals figures={activityTotals(activity)} format={format} />
          <ActivityChart activity={activity} format={format} />
          <table className="table budget-table">
            <caption className="sr-only">{t("budget-table-caption", { group: t(`budget-group-${shownGroup}`) })}</caption>
            <thead>
              <tr>
                <th scope="col">{t(`budget-group-${shownGroup}`)}</th>
                <th scope="col" className="budget-table__number">
                  {t("dashboard-col-requests")}
                </th>
                <th scope="col" className="budget-table__number">
                  {t("dashboard-col-input")}
                </th>
                <th scope="col" className="budget-table__number">
                  {t("dashboard-col-output")}
                </th>
                <th scope="col" className="budget-table__number budget-table__long">
                  {t("dashboard-col-cache-read")}
                </th>
                <th scope="col" className="budget-table__number budget-table__long">
                  {t("dashboard-col-cache-write")}
                </th>
                <th scope="col" className="budget-table__number">
                  {t("dashboard-col-cost")}
                </th>
              </tr>
            </thead>
            <tbody>
              {shown.map((row, index) => {
                const color = colorOf(row.key);
                const figures = rowFigures(row);
                const cell = (value: number): JSX.Element => (
                  <td className="budget-table__number" title={value.toLocaleString(format.locale)}>
                    {formatCompact(value, format.locale)}
                  </td>
                );
                return (
                  <tr key={row.key ?? `none-${index}`}>
                    <th scope="row" className="budget-table__row">
                      <span className="budget-table__name">
                        {color && (
                          <span className="budget-swatch" style={{ backgroundColor: color }} aria-hidden="true" />
                        )}
                        {segmentName(shownGroup, row.key, false, format.locale)}
                      </span>
                    </th>
                    {cell(figures.requests)}
                    {cell(figures.input)}
                    {cell(figures.output)}
                    {cell(figures.cacheRead)}
                    {cell(figures.cacheWrite)}
                    <td className="budget-table__number">{format.money(row.amount)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {sorted.length > VISIBLE_ROWS && (
            <div>
              <Button variant="ghost" size="sm" onClick={() => setShowAll((open) => !open)} aria-expanded={showAll}>
                {showAll ? t("budget-show-fewer") : t("budget-show-all", { n: sorted.length })}
              </Button>
            </div>
          )}
          {showAll && sorted.length > MAX_ROWS && (
            <p className="section__sub">{t("budget-table-capped", { shown: MAX_ROWS, n: sorted.length })}</p>
          )}
        </div>
      )}
    </section>
  );
}
