import { type FormEvent, type MouseEvent, useEffect, useRef, useState } from "react";

import { t } from "../../../i18n";
import type { BudgetLimitPutRequest, BudgetLimitStatus, BudgetStatusResponse } from "../../../../../src/lib/config/settings-types";
import { Button } from "../../components/Button";
import { Callout } from "../../components/Callout";
import type { Problem } from "../../problems";

import {
  type BudgetScope,
  type LimitForm,
  type LimitFormIssue,
  amountText,
  buildPutRequest,
  currencyAffix,
  followedWindow,
  newLimitId,
  providerChoices,
  resetChoice,
  warnPercentText,
} from "./format";
import { useLocale } from "./hooks";
import { targetName } from "./labels";
import { useScopeChoices } from "./useScopeChoices";

interface LimitEditorProps {
  open: boolean;
  /** The limit being edited, or null to add one. */
  editing: BudgetLimitStatus | null;
  status: BudgetStatusResponse;
  /** Saves the limit; resolves to why it didn't, or null when it did. */
  onSave: (id: string, body: BudgetLimitPutRequest) => Promise<Problem | null>;
  onClose: () => void;
}

type TargetKind = Exclude<BudgetScope["kind"], "global">;

const DEFAULT_WARN_PERCENT = "80";

/** The reset a new limit starts with: follow the provider's first reported window, else daily. */
function defaultReset(status: BudgetStatusResponse): string {
  const first = status.provider_windows[0];
  return first ? `follow:${first.provider}:${first.id}` : "daily";
}

function initialForm(editing: BudgetLimitStatus | null, status: BudgetStatusResponse, locale: string): LimitForm {
  if (!editing) {
    return {
      label: "",
      scopeKind: "global",
      scopeId: "",
      amount: "",
      reset: defaultReset(status),
      warnPercent: DEFAULT_WARN_PERCENT,
      action: "block",
    };
  }
  return {
    label: editing.label ?? "",
    scopeKind: editing.scope.kind,
    scopeId: editing.scope.kind === "global" ? "" : editing.scope.id,
    amount: amountText(editing.display.limit, locale),
    reset: resetChoice(editing.limit_reset),
    warnPercent: warnPercentText(editing.warn_at),
    action: editing.action,
  };
}

const ISSUE_TEXT: Record<LimitFormIssue, string> = {
  amount: "budget-error-amount-format",
  "amount-zero": "budget-error-amount",
  warn: "budget-error-warn",
  target: "budget-error-target",
};

const FORM_FIELDS: ReadonlyArray<keyof LimitForm> = ["label", "scopeKind", "scopeId", "amount", "reset", "warnPercent", "action"];

function sameForm(a: LimitForm, b: LimitForm): boolean {
  return FORM_FIELDS.every((field) => a[field] === b[field]);
}

/** Whether a point is outside the dialog's box: on the backdrop, not in its padding. */
function isOutside(rect: DOMRect, x: number, y: number): boolean {
  return x < rect.left || x > rect.right || y < rect.top || y > rect.bottom;
}

/**
 * Add or edit one limit, in a native dialog (top layer and focus trap for
 * free, like ConfirmDialog). The amount is typed in the unit the window shows
 * (a dollar or credit amount typed with its unit is converted); the server
 * converts and stores it. A change saves when the form is sent, and the new
 * status comes back through the same path as every other change.
 *
 * Typed edits are never thrown away by accident: while the form differs from
 * what it opened with, a click on the backdrop and Escape do nothing, and the
 * Cancel button is the one way out (it says what it does). An untouched form
 * closes on either. A validation problem only marks the field and keeps the
 * dialog, and every value, open.
 */
export function LimitEditor(props: LimitEditorProps): JSX.Element | null {
  // Mounted only while open, so every opening starts from a fresh form for its
  // limit (never a frame of the last one), and a status update mid-edit can't
  // reset what is typed.
  return props.open ? <LimitEditorDialog {...props} /> : null;
}

function LimitEditorDialog({ editing, status, onSave, onClose }: LimitEditorProps): JSX.Element {
  const dialogRef = useRef<HTMLDialogElement | null>(null);
  const amountRef = useRef<HTMLInputElement | null>(null);
  const locale = useLocale();
  const [initial] = useState<LimitForm>(() => initialForm(editing, status, locale));
  const [form, setForm] = useState<LimitForm>(initial);
  const [issue, setIssue] = useState<LimitFormIssue | null>(null);
  const [problem, setProblem] = useState<Problem | null>(null);
  const [saving, setSaving] = useState(false);
  const choices = useScopeChoices();
  const dirty = !sameForm(form, initial);
  // Where a press began, so a drag that starts in a field and ends on the
  // backdrop (a text selection) isn't taken for a click on the backdrop.
  const pressedOutside = useRef(false);

  useEffect(() => {
    const el = dialogRef.current;
    if (!el || el.open) return;
    try {
      el.showModal();
    } catch {
      /* already open */
    }
    amountRef.current?.focus();
  }, []);

  // A problem moves focus to the field it names, so the fix is one keystroke away.
  useEffect(() => {
    if (issue) dialogRef.current?.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus();
  }, [issue]);

  const update = (patch: Partial<LimitForm>): void => {
    setForm((current) => ({ ...current, ...patch }));
    setIssue(null);
  };

  const targets: Record<TargetKind, Array<string>> = {
    key: choices.keys,
    plugin: choices.plugins,
    provider: providerChoices(status.provider_windows),
    // The editor doesn't offer filters yet.
    filter: [],
  };
  const kind = form.scopeKind;
  const amountIssue = issue === "amount" || issue === "amount-zero";
  // The limit's own target stays listed even if nothing reports it any more.
  const options =
    kind === "global" ? [] : targets[kind].includes(form.scopeId) || form.scopeId === "" ? targets[kind] : [form.scopeId, ...targets[kind]];

  const changeKind = (next: BudgetScope["kind"]): void => {
    const first = next === "global" ? "" : (targets[next][0] ?? "");
    update({ scopeKind: next, scopeId: first });
  };

  // Reset choices: every window the providers reported, the fixed fallbacks,
  // and the limit's own window when it has stopped being reported.
  const windowRefs = status.provider_windows.map((window) => `${window.provider}:${window.id}`);
  const ownRef = editing ? followedWindow(editing.limit_reset) : null;
  const followRefs = ownRef && !windowRefs.includes(ownRef) ? [ownRef, ...windowRefs] : windowRefs;
  const windowLabel = (ref: string): string =>
    status.provider_windows.find((window) => `${window.provider}:${window.id}` === ref)?.label ?? ref;

  const submit = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    const built = buildPutRequest(form, status.display, locale);
    if (!built.ok) {
      setIssue(built.issue);
      return;
    }
    const taken = status.budgets.map((limit) => limit.id);
    const id = editing?.id ?? newLimitId(built.body.scope, built.body.limit_reset, taken);
    setSaving(true);
    const failed = await onSave(id, built.body);
    setSaving(false);
    if (failed) setProblem(failed);
    else onClose();
  };

  const unitName = status.display.unit === "usd" ? t("budget-unit-usd") : t("budget-unit-credits");
  const affix =
    status.display.unit === "usd" ?
      currencyAffix(locale)
    : { symbol: t("budget-amount-unit-credits"), position: "suffix" as const };

  const closeIfUntouched = (): void => {
    if (!saving && !dirty) onClose();
  };
  const onBackdropPress = (event: MouseEvent<HTMLDialogElement>): void => {
    const el = dialogRef.current;
    pressedOutside.current = !!el && isOutside(el.getBoundingClientRect(), event.clientX, event.clientY);
  };
  const onBackdropClick = (event: MouseEvent<HTMLDialogElement>): void => {
    const el = dialogRef.current;
    const outside = !!el && isOutside(el.getBoundingClientRect(), event.clientX, event.clientY);
    if (outside && pressedOutside.current) closeIfUntouched();
    pressedOutside.current = false;
  };

  return (
    <dialog
      ref={dialogRef}
      className="confirm-dialog budget-editor"
      aria-labelledby="budget-editor-title"
      onCancel={(event) => {
        // Escape. Handled here so a form with edits in it stays open.
        event.preventDefault();
        closeIfUntouched();
      }}
      onClose={() => {
        // Closed without a cancel event (a second Escape in some browsers): put
        // back a form with edits in it; let an untouched one go.
        const el = dialogRef.current;
        if (!el || el.open) return;
        if (dirty || saving) {
          try {
            el.showModal();
          } catch {
            /* already open */
          }
        } else {
          onClose();
        }
      }}
      onMouseDown={onBackdropPress}
      onClick={onBackdropClick}
    >
      <form className="confirm-dialog__panel" onSubmit={(event) => void submit(event)} noValidate>
        <h2 className="confirm-dialog__title" id="budget-editor-title">
          {editing ? t("budget-editor-title-edit") : t("budget-editor-title-add")}
        </h2>

        <div className="budget-editor__fields">
          <div className="budget-field">
            <label htmlFor="budget-field-name">{t("budget-field-name")}</label>
            <input
              id="budget-field-name"
              className="input"
              type="text"
              maxLength={128}
              value={form.label}
              onChange={(event) => update({ label: event.target.value })}
            />
            <p className="form__hint">{t("budget-field-name-hint")}</p>
          </div>

          <div className="budget-editor__pair">
            <div className="budget-field">
              <label htmlFor="budget-field-scope">{t("budget-field-scope")}</label>
              <select
                id="budget-field-scope"
                className="select"
                value={kind}
                onChange={(event) => changeKind(event.target.value as BudgetScope["kind"])}
              >
                <option value="global">{t("budget-scope-option-global")}</option>
                <option value="key">{t("budget-scope-option-key")}</option>
                <option value="plugin">{t("budget-scope-option-plugin")}</option>
                <option value="provider">{t("budget-scope-option-provider")}</option>
              </select>
            </div>

            {kind !== "global" && (
              <div className="budget-field">
                <label htmlFor="budget-field-target">{t(`budget-field-target-${kind}`)}</label>
                <select
                  id="budget-field-target"
                  className="select"
                  value={form.scopeId}
                  aria-invalid={issue === "target"}
                  onChange={(event) => update({ scopeId: event.target.value })}
                >
                  {options.map((id) => (
                    <option key={id} value={id}>
                      {targetName(kind, id)}
                    </option>
                  ))}
                </select>
                {issue === "target" && <p className="budget-field__error">{t(ISSUE_TEXT.target)}</p>}
              </div>
            )}
          </div>

          <div className="budget-editor__pair">
            <div className="budget-field">
              <label htmlFor="budget-field-amount">{t("budget-field-amount")}</label>
              <div className="input-adorn" data-invalid={amountIssue}>
                {affix.position === "prefix" && (
                  <span className="input-adorn__text" aria-hidden="true">
                    {affix.symbol}
                  </span>
                )}
                <input
                  id="budget-field-amount"
                  ref={amountRef}
                  className="input-adorn__field"
                  type="text"
                  inputMode="decimal"
                  autoComplete="off"
                  value={form.amount}
                  aria-invalid={amountIssue}
                  aria-describedby="budget-field-amount-hint"
                  onChange={(event) => update({ amount: event.target.value })}
                />
                {affix.position === "suffix" && (
                  <span className="input-adorn__text" aria-hidden="true">
                    {affix.symbol}
                  </span>
                )}
              </div>
              <p className="form__hint" id="budget-field-amount-hint">
                {issue === "amount" || issue === "amount-zero" ?
                  <span className="budget-field__error">{t(ISSUE_TEXT[issue], { unit: status.display.unit })}</span>
                : t("budget-field-amount-hint", { unit: unitName })}
              </p>
            </div>

            <div className="budget-field">
              <label htmlFor="budget-field-warn">{t("budget-field-warn")}</label>
              <input
                id="budget-field-warn"
                className="input"
                type="text"
                inputMode="numeric"
                autoComplete="off"
                value={form.warnPercent}
                aria-invalid={issue === "warn"}
                aria-describedby="budget-field-warn-hint"
                onChange={(event) => update({ warnPercent: event.target.value })}
              />
              <p className="form__hint" id="budget-field-warn-hint">
                {issue === "warn" ?
                  <span className="budget-field__error">{t(ISSUE_TEXT.warn)}</span>
                : t("budget-field-warn-hint")}
              </p>
            </div>
          </div>

          <div className="budget-field">
            <label htmlFor="budget-field-reset">{t("budget-field-reset")}</label>
            <select
              id="budget-field-reset"
              className="select"
              value={form.reset}
              onChange={(event) => update({ reset: event.target.value })}
            >
              {followRefs.map((ref) => (
                <option key={ref} value={`follow:${ref}`}>
                  {t("budget-reset-option-follow", { window: windowLabel(ref) })}
                </option>
              ))}
              <option value="daily">{t("budget-reset-option-daily")}</option>
              <option value="weekly">{t("budget-reset-option-weekly")}</option>
              <option value="never">{t("budget-reset-option-never")}</option>
            </select>
            {followRefs.length > 0 && <p className="form__hint">{t("budget-field-reset-hint")}</p>}
          </div>

          <div className="budget-field">
            <label htmlFor="budget-field-action">{t("budget-field-action")}</label>
            <select
              id="budget-field-action"
              className="select"
              value={form.action}
              onChange={(event) => update({ action: event.target.value === "warn" ? "warn" : "block" })}
            >
              <option value="block">{t("budget-action-block")}</option>
              <option value="warn">{t("budget-action-warn")}</option>
            </select>
          </div>
        </div>

        {problem && (
          <Callout tone="error" title={problem.title}>
            {problem.detail}
          </Callout>
        )}

        <div className="confirm-dialog__actions">
          <Button variant="ghost" onClick={onClose} disabled={saving}>
            {t("common-cancel")}
          </Button>
          <Button variant="primary" type="submit" disabled={saving}>
            {saving ? t("common-working") : t("budget-save")}
          </Button>
        </div>
      </form>
    </dialog>
  );
}
