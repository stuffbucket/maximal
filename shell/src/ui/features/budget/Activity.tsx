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
  ACTIVITY_PERIODS,
  type ActivityGroup,
  type ActivityPeriod,
  activityQuery,
  csvFileName,
  formatPeriodStart,
  topSegments,
} from "./format";
import type { BudgetFormat } from "./hooks";
import { segmentName } from "./labels";
import { useBudgetActivity } from "./useBudgetActivity";

interface ActivityProps {
  format: BudgetFormat | null;
  /** Moves whenever the budget changes, so the figures refetch with it. */
  version: number;
}

/** Rows shown before "Show all": enough to read at a glance, not a wall. */
const VISIBLE_ROWS = 10;

/**
 * Activity: where spending went in this period, by model, plugin, client key,
 * provider or day, as a chart and a table of the same rows, with a CSV
 * export. Groups that spent nothing are left out by the server, so a model
 * that was never used never appears.
 */
export function Activity({ format, version }: ActivityProps): JSX.Element {
  const [period, setPeriod] = useState<ActivityPeriod>("week");
  const [group, setGroup] = useState<ActivityGroup>("model");
  const [showAll, setShowAll] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [exportProblem, setExportProblem] = useState<Problem | null>(null);
  const { activity, isLoading, problem } = useBudgetActivity(period, group, version);

  const exportCsv = async (): Promise<void> => {
    setExporting(true);
    setExportProblem(null);
    const result = await fetchBudgetCsv(activityQuery(period, group));
    if (result.ok) {
      const outcome = await saveTextFile(csvFileName(period, group), result.data);
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

  const rows = activity?.rows ?? [];
  const sorted = group === "day" ? rows : [...rows].sort((a, b) => b.nano_aiu - a.nano_aiu);
  const shown = showAll ? sorted : sorted.slice(0, VISIBLE_ROWS);
  const totalNano = rows.reduce((sum, row) => sum + row.nano_aiu, 0);
  const totalRequests = rows.reduce((sum, row) => sum + row.requests, 0);
  // The same parts the share bar draws, so each row's swatch matches its segment.
  const segments = group === "day" ? [] : topSegments(rows, MAX_SEGMENTS);
  const colorOf = (key: string | null): string | undefined => {
    if (group === "day") return undefined;
    const index = segments.findIndex((segment) => !segment.other && segment.key === key);
    return index === -1 ? segmentColor(true, 0) : segmentColor(false, index);
  };

  return (
    <section className="budget-block" aria-labelledby="budget-activity-title">
      <header className="budget-block__head">
        <div className="section__head">
          <h2 className="budget-block__title" id="budget-activity-title">
            {t("budget-activity-title")}
          </h2>
          <p className="section__sub">
            {activity && format ?
              t("budget-activity-sub", { date: formatPeriodStart(activity.period_start, format.locale) })
            : t("budget-activity-sub-plain")}
          </p>
        </div>
        <Button
          variant="secondary"
          onClick={() => void exportCsv()}
          disabled={exporting || rows.length === 0}
          title={t("budget-export-tip", {
            file: csvFileName(period, group),
            period: t(`budget-period-${period}`),
            group: t(`budget-group-${group}`),
          })}
        >
          <DownloadGlyph />
          {exporting ? t("common-working") : t("budget-export")}
        </Button>
      </header>

      <div className="budget-controls">
        <div className="budget-field budget-field--inline">
          <label htmlFor="budget-period">{t("budget-period-label")}</label>
          <select
            id="budget-period"
            className="select"
            value={period}
            onChange={(event) => {
              setPeriod(event.target.value as ActivityPeriod);
              setShowAll(false);
            }}
          >
            {ACTIVITY_PERIODS.map((value) => (
              <option key={value} value={value}>
                {t(`budget-period-${value}`)}
              </option>
            ))}
          </select>
        </div>
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

      {problem && <ProblemCallout problem={problem} />}
      {exportProblem && <ProblemCallout problem={exportProblem} />}
      {activity && activity.rows.length === 0 && !problem && (
        <EmptyState title={t("budget-activity-empty-title")}>
          <p>{t("budget-activity-empty-body")}</p>
        </EmptyState>
      )}
      {!activity && isLoading && <p className="panel-status">{t("budget-loading")}</p>}

      {activity && format && rows.length > 0 && (
        <div className="budget-activity">
          <p className="budget-activity__total">
            <span className="budget-activity__amount">{format.nanoMoney(totalNano)}</span>
            <span className="muted">{t("budget-activity-requests", { n: totalRequests })}</span>
          </p>
          <ActivityChart activity={activity} format={format} />
          <table className="table budget-table">
            <caption className="sr-only">{t("budget-table-caption", { group: t(`budget-group-${group}`) })}</caption>
            <thead>
              <tr>
                <th scope="col">{t(`budget-group-${group}`)}</th>
                <th scope="col" className="budget-table__number">
                  {t("budget-col-requests")}
                </th>
                <th scope="col" className="budget-table__number">
                  {t("budget-col-spend")}
                </th>
              </tr>
            </thead>
            <tbody>
              {shown.map((row, index) => {
                const color = colorOf(row.key);
                return (
                  <tr key={row.key ?? `none-${index}`}>
                    <th scope="row" className="budget-table__row">
                      <span className="budget-table__name">
                        {color && (
                          <span className="budget-swatch" style={{ backgroundColor: color }} aria-hidden="true" />
                        )}
                        {segmentName(group, row.key, false, format.locale)}
                      </span>
                    </th>
                    <td className="budget-table__number">{row.requests.toLocaleString(format.locale)}</td>
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
        </div>
      )}
    </section>
  );
}
