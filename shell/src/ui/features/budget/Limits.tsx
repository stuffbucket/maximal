import { useState } from "react";

import { t } from "../../../i18n";
import type {
  BudgetLimitPutRequest,
  BudgetLimitStatus,
  BudgetStatusResponse,
} from "../../../../../src/lib/config/settings-types";
import { Button } from "../../components/Button";
import { ConfirmDialog } from "../../components/ConfirmDialog";
import { EmptyState } from "../../components/EmptyState";
import { ProblemCallout } from "../../components/ProblemCallout";
import type { Problem } from "../../problems";

import { LimitEditor } from "./LimitEditor";
import { Meter } from "./Meter";
import { PencilGlyph, PlusGlyph, TrashGlyph, WarningGlyph } from "./glyphs";
import { describeReset, formatWhen, limitFigures, usedFraction } from "./format";
import type { BudgetFormat } from "./hooks";
import { resetText, scopeName } from "./labels";

interface LimitsProps {
  status: BudgetStatusResponse | null;
  format: BudgetFormat | null;
  onSave: (id: string, body: BudgetLimitPutRequest) => Promise<Problem | null>;
  onDelete: (id: string) => Promise<Problem | null>;
}

function limitName(limit: BudgetLimitStatus): string {
  return limit.label ?? scopeName(limit.scope);
}

interface LimitRowProps {
  limit: BudgetLimitStatus;
  status: BudgetStatusResponse;
  format: BudgetFormat;
  onEdit: () => void;
  onDelete: () => void;
}

/**
 * One limit: its name, a meter of what's spent against it, the figures, and
 * when it resets. The scope shows as a chip only when the limit has a name of
 * its own; otherwise the scope is the name.
 */
function LimitRow({ limit, status, format, onEdit, onDelete }: LimitRowProps): JSX.Element {
  const figures = limitFigures(limit, format.display);
  const name = limitName(limit);
  const amounts = t("budget-limit-amounts", { usage: format.money(figures.usage), limit: format.money(figures.limit) });
  const reset = describeReset(limit, status.provider_windows);
  const when = reset.kind === "never" ? undefined : formatWhen(reset.resetsAtMs, format.now, format.locale);
  return (
    <li className="limit">
      <div className="limit__head">
        <div className="limit__title">
          <span className="limit__name">{name}</span>
          {limit.label && <span className="chip">{scopeName(limit.scope)}</span>}
          {limit.action === "warn" && <span className="chip">{t("budget-tag-warn-only")}</span>}
        </div>
        <div className="limit__actions">
          <Button
            variant="ghost"
            className="btn--icon"
            onClick={onEdit}
            aria-label={t("budget-edit", { name })}
            title={t("budget-edit", { name })}
          >
            <PencilGlyph />
          </Button>
          <Button
            variant="ghost"
            className="btn--icon btn--ghost-destructive"
            onClick={onDelete}
            aria-label={t("budget-delete", { name })}
            title={t("budget-delete", { name })}
          >
            <TrashGlyph />
          </Button>
        </div>
      </div>
      <Meter
        fraction={usedFraction(figures.usage, figures.limit)}
        tone={limit.state}
        label={name}
        valueText={amounts}
      />
      <p className="limit__figures">
        <span className="limit__amounts">{amounts}</span>
        {limit.state !== "ok" && (
          <span className={`limit__state limit__state--${limit.state}`}>
            <WarningGlyph />
            {limit.state === "exhausted" ? t("budget-state-exhausted") : t("budget-state-warning")}
          </span>
        )}
        {limit.state !== "exhausted" && <span>{t("budget-limit-left", { amount: format.money(figures.remaining) })}</span>}
        {limit.held > 0 && <span>{t("budget-limit-held", { amount: format.nanoMoney(limit.held) })}</span>}
        <span className="limit__reset" title={when}>
          {resetText(reset, format)}
        </span>
      </p>
    </li>
  );
}

/**
 * Limits: one row per limit that exists, widest scope first (the server's
 * order, so a row doesn't jump as spend changes). Nothing is listed until
 * someone adds a limit; there are no per-model rows. Adding and editing happen
 * in a dialog, deleting asks first.
 */
export function Limits({ status, format, onSave, onDelete }: LimitsProps): JSX.Element {
  // `limit: null` is the add form; a limit is the edit form for it.
  const [editing, setEditing] = useState<{ limit: BudgetLimitStatus | null } | null>(null);
  const [deleting, setDeleting] = useState<BudgetLimitStatus | null>(null);
  const [deleteBusy, setDeleteBusy] = useState(false);
  const [deleteProblem, setDeleteProblem] = useState<Problem | null>(null);

  const confirmDelete = async (): Promise<void> => {
    if (!deleting) return;
    setDeleteBusy(true);
    const problem = await onDelete(deleting.id);
    setDeleteBusy(false);
    if (problem) setDeleteProblem(problem);
    setDeleting(null);
  };

  const add = (
    <Button variant="secondary" onClick={() => setEditing({ limit: null })} disabled={!status}>
      <PlusGlyph />
      {t("budget-add-limit")}
    </Button>
  );

  return (
    <section className="budget-block" aria-labelledby="budget-limits-title">
      <header className="budget-block__head">
        <div className="section__head">
          <h2 className="section__title" id="budget-limits-title">
            {t("budget-limits-title")}
          </h2>
          <p className="section__sub">{t("budget-limits-sub")}</p>
        </div>
        {status && status.budgets.length > 0 && add}
      </header>

      {deleteProblem && <ProblemCallout problem={deleteProblem} />}

      {status && format && status.budgets.length === 0 && (
        <EmptyState title={t("budget-empty-title")} action={add}>
          <p>{t("budget-empty-body")}</p>
        </EmptyState>
      )}
      {status && format && status.budgets.length > 0 && (
        <ul className="limits">
          {status.budgets.map((limit) => (
            <LimitRow
              key={limit.id}
              limit={limit}
              status={status}
              format={format}
              onEdit={() => setEditing({ limit })}
              onDelete={() => {
                setDeleteProblem(null);
                setDeleting(limit);
              }}
            />
          ))}
        </ul>
      )}

      {status && (
        <LimitEditor
          open={editing !== null}
          editing={editing?.limit ?? null}
          status={status}
          onSave={onSave}
          onClose={() => setEditing(null)}
        />
      )}
      <ConfirmDialog
        open={deleting !== null}
        tone="danger"
        title={t("budget-delete-title")}
        body={<p>{t("budget-delete-body", { name: deleting ? limitName(deleting) : "" })}</p>}
        confirmLabel={t("budget-delete-confirm")}
        cancelLabel={t("common-cancel")}
        busy={deleteBusy}
        onConfirm={confirmDelete}
        onCancel={() => setDeleting(null)}
      />
    </section>
  );
}
