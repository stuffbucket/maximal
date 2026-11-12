import { t } from "../../../i18n";

import type { UsageFigures } from "./format";
import type { BudgetFormat } from "./hooks";

interface UsageTotalsProps {
  figures: UsageFigures & { nanoAiu: number };
  format: BudgetFormat;
}

/**
 * What the range recorded, in the Dashboard's measures and order: the total
 * tokens as the headline, then input, output, cache read, cache write,
 * requests and cost in a quiet row. Every figure is text ink; hierarchy comes
 * from size, not hue. The labels are the Dashboard's own catalog strings, so
 * the two windows name each measure alike.
 */
export function UsageTotals({ figures, format }: UsageTotalsProps): JSX.Element {
  const count = (value: number): string => value.toLocaleString(format.locale);
  const parts: Array<[string, string]> = [
    [t("dashboard-col-input"), count(figures.input)],
    [t("dashboard-col-output"), count(figures.output)],
    [t("dashboard-col-cache-read"), count(figures.cacheRead)],
    [t("dashboard-col-cache-write"), count(figures.cacheWrite)],
    [t("dashboard-col-requests"), count(figures.requests)],
    [t("dashboard-col-cost"), format.nanoMoney(figures.nanoAiu)],
  ];
  return (
    <div className="budget-totals" role="group" aria-label={t("budget-totals-label")}>
      <p className="budget-totals__hero">
        <span className="budget-totals__label">{t("budget-totals-tokens")}</span>
        <span className="budget-totals__hero-value">{count(figures.total)}</span>
      </p>
      <dl className="budget-totals__parts">
        {parts.map(([label, value]) => (
          <div key={label}>
            <dt className="budget-totals__label">{label}</dt>
            <dd>{value}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}
