import { t } from "../../../i18n";
import type { BudgetStatusResponse } from "../../../../../src/lib/config/settings-types";
import { Button } from "../../components/Button";
import { Callout } from "../../components/Callout";
import { ProblemCallout } from "../../components/ProblemCallout";
import type { Problem } from "../../problems";

import type { BudgetFormat } from "./hooks";
import { draftResetName, scopeName } from "./labels";
import { type SuggestedRule, editorSupportsReset } from "./sessions";

interface SuggestedRulesProps {
  rules: ReadonlyArray<SuggestedRule>;
  status: BudgetStatusResponse;
  format: BudgetFormat;
  /** Ids already added, from here or from the editor. */
  added: ReadonlySet<string>;
  /** What stopped a rule being added, by rule id. */
  problems: ReadonlyMap<string, Problem>;
  busy: string | null;
  onAdd: (rule: SuggestedRule) => void;
  onOpen: (rule: SuggestedRule) => void;
}

/** What the rule would have done to the usage it was sized from. */
function projectionText(rule: SuggestedRule, format: BudgetFormat): string {
  const { projection } = rule;
  const refused = {
    refused: projection.refused_requests,
    amount: format.nanoMoney(projection.refused_nano_aiu),
  };
  if (projection.periods_total === null) {
    return projection.refused_requests === 0 ?
        t("budget-draft-projection-rolling-clean")
      : t("budget-draft-projection-rolling", refused);
  }
  if (projection.periods_tripped === 0 && projection.refused_requests === 0) {
    return t("budget-draft-projection-clean", { total: projection.periods_total });
  }
  return t("budget-draft-projection", {
    total: projection.periods_total,
    tripped: projection.periods_tripped ?? 0,
    ...refused,
  });
}

/** How the amount was sized, and how much of what was picked the rule covers. */
function basisText(rule: SuggestedRule): string {
  const { basis } = rule;
  const rolling = basis.periods_observed === null;
  const how =
    basis.percentile >= 1 ?
      t("budget-draft-basis-busiest", { unit: rolling ? "window" : "period" })
    : t("budget-draft-basis-fit", { unit: rolling ? "window" : "period" });
  return `${how} ${t("budget-draft-basis-share", { share: basis.share })}`;
}

/**
 * The rules a suggestion drafted, each with what it would have done to the
 * usage it was sized from (the projection), how its amount was reached, and
 * two ways forward: add it as drafted, or open it in the editor to change it
 * first. Adding never leaves the list: the row says "Added" and stays, so the
 * rest can still be read and added.
 */
export function SuggestedRules({ rules, status, format, added, problems, busy, onAdd, onOpen }: SuggestedRulesProps): JSX.Element {
  const windowLabel = (ref: string): string =>
    status.provider_windows.find((window) => `${window.provider}:${window.id}` === ref)?.label ?? ref;
  return (
    <ul className="draft-list">
      {rules.map((rule) => {
        const isAdded = added.has(rule.id);
        const problem = problems.get(rule.id);
        const canOpen = editorSupportsReset(rule.limit_reset);
        return (
          <li key={rule.id} className="draft">
            <div className="draft__head">
              <div className="limit__title">
                <span className="limit__name">{rule.label}</span>
                <span className="chip">{scopeName(rule.scope)}</span>
                {rule.action === "warn" && <span className="chip">{t("budget-tag-warn-only")}</span>}
              </div>
              <p className="draft__amount">
                <strong>{format.nanoMoney(rule.limit)}</strong>
                <span>{draftResetName(rule.limit_reset, windowLabel)}</span>
              </p>
            </div>
            <p className="draft__line">{projectionText(rule, format)}</p>
            <p className="draft__line draft__line--muted">{basisText(rule)}</p>
            {problem && <ProblemCallout problem={problem} />}
            <div className="draft__actions">
              <Button
                variant="ghost"
                size="sm"
                onClick={() => onOpen(rule)}
                disabled={isAdded || !canOpen || busy !== null}
                title={canOpen ? undefined : t("budget-draft-edit-unsupported")}
              >
                {t("budget-draft-edit")}
              </Button>
              <Button
                variant="secondary"
                size="sm"
                onClick={() => onAdd(rule)}
                disabled={isAdded || busy !== null}
                aria-label={t(isAdded ? "budget-draft-added-name" : "budget-draft-add-name", { name: rule.label })}
              >
                {busy === rule.id ? t("common-working") : isAdded ? t("budget-draft-added") : t("budget-draft-add")}
              </Button>
            </div>
          </li>
        );
      })}
    </ul>
  );
}

/** The notes a suggestion carries, as notices. */
export function SuggestNotes({ notes }: { notes: ReadonlyArray<"no_spend" | "short_history"> }): JSX.Element | null {
  if (notes.length === 0) return null;
  return (
    <>
      {notes.map((note) => (
        <Callout key={note} tone="notice">
          {t(note === "short_history" ? "budget-suggest-note-short-history" : "budget-suggest-note-no-spend")}
        </Callout>
      ))}
    </>
  );
}
