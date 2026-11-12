import { t } from "../../../i18n";
import type { BudgetLimitStatus, BudgetStatusResponse } from "../../../../../src/lib/config/settings-types";
import { Callout } from "../../components/Callout";
import { ProblemCallout } from "../../components/ProblemCallout";
import type { Problem } from "../../problems";

import { blockingLimit, describeReset, formatRelative, formatWhen, limitFigures } from "./format";
import type { BudgetFormat } from "./hooks";
import { scopeName } from "./labels";

interface SummaryProps {
  status: BudgetStatusResponse | null;
  /** The status failed to load. */
  problem: Problem | null;
  format: BudgetFormat | null;
  onRetry: () => void;
}

/** The sentence under a spent limit's callout: when it opens up again. */
function blockedBody(limit: BudgetLimitStatus, status: BudgetStatusResponse, format: BudgetFormat): string {
  const reset = describeReset(limit, status.provider_windows);
  if (reset.kind === "never") return t("budget-blocked-never");
  return t("budget-blocked-until", {
    date: formatWhen(reset.resetsAtMs, format.now, format.locale),
    relative: formatRelative(reset.resetsAtMs, format.now, format.locale),
  });
}

/**
 * The limit the one-line status reports: the one a request would hit first,
 * else the widest one (the server lists the widest scope first), if any exist.
 */
function headlineLimit(status: BudgetStatusResponse): BudgetLimitStatus | undefined {
  return status.budgets.find((limit) => limit.id === status.effective_budget) ?? status.budgets[0];
}

/** How a limit's period reads in the status line: today, this week, in total or "this period". */
function periodKind(limit: BudgetLimitStatus): "daily" | "weekly" | "never" | "cycle" {
  return typeof limit.limit_reset === "object" ? "cycle" : limit.limit_reset;
}

/**
 * The top of the Budget surface: one line saying whether limits are enforced,
 * how many exist and how far the headline one is, so the state is in view
 * without scrolling to the settings, then whatever needs attention (a spent
 * blocking limit, no usage database, a status that failed to load).
 */
export function Summary({ status, problem, format, onRetry }: SummaryProps): JSX.Element | null {
  const blocked = status && format ? blockingLimit(status) : undefined;
  const headline = status && format ? headlineLimit(status) : undefined;
  const figures = headline && format ? limitFigures(headline, format.display) : undefined;
  const parts =
    status ?
      [
        status.enabled ? t("budget-status-enforcing") : t("budget-status-paused"),
        t("budget-status-limits", { n: status.budgets.length }),
        ...(headline && figures && format ?
          [
            t("budget-status-spent", {
              usage: format.money(figures.usage),
              limit: format.money(figures.limit),
              period: periodKind(headline),
            }),
          ]
        : []),
      ]
    : [];

  if (!status && !problem) return <p className="panel-status">{t("budget-loading")}</p>;
  return (
    <div className="budget-summary">
      {status && (
        <p className={`budget-status${status.enabled ? "" : " budget-status--paused"}`} id="budget-status">
          {parts.join(" · ")}
        </p>
      )}
      {problem && <ProblemCallout problem={problem} onRetry={onRetry} onRestarted={onRetry} />}
      {status && format && blocked && (
        <Callout tone="notice" title={t("budget-blocked-title", { name: blocked.label ?? scopeName(blocked.scope) })}>
          {blockedBody(blocked, status, format)}
        </Callout>
      )}
      {status && !status.storage_enabled && (
        <Callout tone="notice" title={t("budget-storage-off-title")}>
          {t("budget-storage-off-body")}
        </Callout>
      )}
    </div>
  );
}
