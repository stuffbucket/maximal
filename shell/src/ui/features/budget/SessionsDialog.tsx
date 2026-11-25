import { type MouseEvent, useEffect, useRef, useState } from "react";

import { t } from "../../../i18n";
import type { BudgetStatusResponse, BudgetSuggestResponse } from "../../../../../src/lib/config/settings-types";
import { apiCall } from "../../../proxy/client";
import { Button } from "../../components/Button";
import { ProblemCallout } from "../../components/ProblemCallout";
import { type Problem, describeProblem } from "../../problems";

import { formatSpan } from "./format";
import type { BudgetFormat } from "./hooks";
import { SessionPicker } from "./SessionPicker";
import { SuggestNotes, SuggestedRules } from "./SuggestedRules";
import { type RangeChoice, rangeChoice } from "./range";
import {
  type PersonaChoice,
  SUGGEST_PERSONAS,
  type Session,
  type SuggestedRule,
  selectionTotals,
  suggestRequest,
} from "./sessions";
import { useSessions } from "./useSessions";

interface SessionsDialogProps {
  open: boolean;
  status: BudgetStatusResponse;
  format: BudgetFormat;
  /** Ids of suggested rules that are in the rules now, so a row says "Added". */
  added: ReadonlySet<string>;
  /** Add a suggested rule as drafted; resolves to why it didn't, or null. */
  onAdd: (rule: SuggestedRule) => Promise<Problem | null>;
  /** Open a suggested rule in the editor, over this dialog. */
  onOpenDraft: (rule: SuggestedRule) => void;
  onClose: () => void;
}

/**
 * Create rules from sessions, in a native dialog like the editor: pick the
 * sessions that look like a normal stretch of work (or none, for all usage in
 * the range), choose the shape of rules to size, then review what the
 * suggestion drafted and add or open each one. Nothing is added until you say so.
 *
 * Nothing picked is thrown away by accident either: once something is picked
 * or a suggestion is on screen, the backdrop and Escape do nothing and Done
 * is the way out (an untouched dialog closes on either).
 */
export function SessionsDialog(props: SessionsDialogProps): JSX.Element | null {
  // Mounted only while open, so each opening starts fresh.
  return props.open ? <SessionsDialogBody {...props} /> : null;
}

function SessionsDialogBody({ status, format, added, onAdd, onOpenDraft, onClose }: SessionsDialogProps): JSX.Element {
  const dialogRef = useRef<HTMLDialogElement | null>(null);
  const [choice, setChoice] = useState<RangeChoice>(() => rangeChoice("7d", Date.now()));
  const { report, isLoading, problem, refresh } = useSessions(choice);
  const [picked, setPicked] = useState<ReadonlyMap<string, Session>>(() => new Map());
  const [persona, setPersona] = useState<PersonaChoice>("auto");
  const [suggestion, setSuggestion] = useState<BudgetSuggestResponse | null>(null);
  const [suggesting, setSuggesting] = useState(false);
  const [suggestProblem, setSuggestProblem] = useState<Problem | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [problems, setProblems] = useState<ReadonlyMap<string, Problem>>(() => new Map());
  const pressedOutside = useRef(false);
  const touched = picked.size > 0 || suggestion !== null || persona !== "auto";
  const totals = selectionTotals([...picked.values()], new Set(picked.keys()));
  const request = suggestRequest([...picked.keys()], choice, persona);

  // A wider range can return a newer aggregate for a session that stayed
  // picked. Keep its saved snapshot current without dropping out-of-view picks.
  useEffect(() => {
    if (!report) return;
    const fresh = new Map(report.sessions.map((session) => [session.id, session]));
    setPicked((current) => {
      let changed = false;
      const next = new Map(current);
      for (const id of current.keys()) {
        const session = fresh.get(id);
        if (session && session !== current.get(id)) {
          next.set(id, session);
          changed = true;
        }
      }
      return changed ? next : current;
    });
  }, [report]);

  useEffect(() => {
    const el = dialogRef.current;
    if (!el || el.open) return;
    try {
      el.showModal();
    } catch {
      /* already open */
    }
  }, []);

  const toggle = (session: Session): void =>
    setPicked((current) => {
      const next = new Map(current);
      if (!next.delete(session.id)) next.set(session.id, session);
      return next;
    });

  const suggest = async (): Promise<void> => {
    if (request === null) return;
    setSuggesting(true);
    setSuggestProblem(null);
    const result = await apiCall({ kind: "budget-suggest", method: "POST", path: "/settings/api/budget/suggest", body: request });
    setSuggesting(false);
    if (result.ok) {
      setSuggestion(result.data);
      setProblems(new Map());
    } else {
      setSuggestProblem(describeProblem(result, { subject: "your suggested rules" }));
    }
  };

  const add = async (rule: SuggestedRule): Promise<boolean> => {
    setBusy(rule.id);
    const failed = await onAdd(rule);
    setBusy(null);
    setProblems((current) => {
      const next = new Map(current);
      if (failed) next.set(rule.id, failed);
      else next.delete(rule.id);
      return next;
    });
    return failed === null;
  };

  const addAll = async (): Promise<void> => {
    for (const rule of suggestion?.limits ?? []) {
      if (added.has(rule.id)) continue;
      // Stop at the first that fails: its row says why, and the rest wait.
      if (!(await add(rule))) return;
    }
  };

  const closeIfUntouched = (): void => {
    if (!touched && busy === null && !suggesting) onClose();
  };
  // A press on the backdrop has the dialog itself as its target, as in the editor.
  const isBackdrop = (event: MouseEvent<HTMLDialogElement>): boolean => {
    const el = dialogRef.current;
    if (!el || event.target !== el) return false;
    const box = el.getBoundingClientRect();
    return event.clientX < box.left || event.clientX > box.right || event.clientY < box.top || event.clientY > box.bottom;
  };

  const rules = suggestion?.limits ?? [];
  const waiting = rules.filter((rule) => !added.has(rule.id));

  return (
    <dialog
      ref={dialogRef}
      className="confirm-dialog budget-editor budget-sessions"
      aria-labelledby="budget-sessions-title"
      onCancel={(event) => {
        event.preventDefault();
        closeIfUntouched();
      }}
      onClose={() => {
        const el = dialogRef.current;
        if (!el || el.open) return;
        if (touched || busy !== null || suggesting) {
          try {
            el.showModal();
          } catch {
            /* already open */
          }
        } else {
          onClose();
        }
      }}
      onMouseDown={(event) => {
        pressedOutside.current = isBackdrop(event);
      }}
      onClick={(event) => {
        if (isBackdrop(event) && pressedOutside.current) closeIfUntouched();
        pressedOutside.current = false;
      }}
    >
      <div className="confirm-dialog__panel">
        <h2 className="confirm-dialog__title" id="budget-sessions-title">
          {t("budget-sessions-title")}
        </h2>

        <div className="budget-editor__fields">
          {suggestion === null ?
            <>
              <p className="form__hint">{t("budget-sessions-intro")}</p>
              <SessionPicker
                choice={choice}
                onChoice={setChoice}
                report={report}
                isLoading={isLoading}
                problem={problem}
                onRetry={refresh}
                format={format}
                picked={picked}
                onToggle={toggle}
                onClear={() => setPicked(new Map())}
                disabled={suggesting}
              />
              <div className="budget-field">
                <label htmlFor="budget-sessions-persona">{t("budget-sessions-persona")}</label>
                <select
                  id="budget-sessions-persona"
                  className="select"
                  value={persona}
                  disabled={suggesting}
                  onChange={(event) => setPersona(event.target.value as PersonaChoice)}
                >
                  <option value="auto">{t("budget-persona-auto")}</option>
                  {SUGGEST_PERSONAS.map((id) => (
                    <option key={id} value={id}>
                      {t(`budget-persona-${id}`)}
                    </option>
                  ))}
                </select>
                <p className="form__hint">{t("budget-sessions-persona-hint")}</p>
              </div>
              {suggestProblem && <ProblemCallout problem={suggestProblem} onRetry={() => void suggest()} />}
            </>
          : <>
              <p className="form__hint">
                {t("budget-suggest-summary", {
                  sessions: suggestion.sessions_considered,
                  requests: suggestion.requests_considered,
                  amount: format.nanoMoney(suggestion.nano_aiu_considered),
                  span: formatSpan(suggestion.range.from, suggestion.range.to, format.locale),
                })}
              </p>
              <SuggestNotes notes={suggestion.notes} />
              {rules.length > 0 && (
                <SuggestedRules
                  rules={rules}
                  status={status}
                  format={format}
                  added={added}
                  problems={problems}
                  busy={busy}
                  onAdd={(rule) => void add(rule)}
                  onOpen={onOpenDraft}
                />
              )}
              {rules.length === 0 && !suggestion.notes.includes("no_spend") && (
                <p className="form__hint">{t("budget-suggest-none")}</p>
              )}
            </>
          }
        </div>

        <div className="confirm-dialog__actions">
          {suggestion === null ?
            <>
              {touched && picked.size > 0 && (
                <p className="form__hint session-footer__sum">
                  {t("budget-sessions-picked", {
                    n: totals.count,
                    amount: format.money(totals.amount),
                  })}
                </p>
              )}
              <Button variant="ghost" onClick={onClose} disabled={suggesting}>
                {t("common-cancel")}
              </Button>
              <Button variant="primary" onClick={() => void suggest()} disabled={suggesting || request === null}>
                {suggesting ? t("common-working")
                : picked.size > 0 ? t("budget-sessions-suggest-picked", { n: picked.size })
                : t("budget-sessions-suggest-all")}
              </Button>
            </>
          : <>
              <Button variant="ghost" onClick={() => setSuggestion(null)} disabled={busy !== null}>
                {t("budget-sessions-back")}
              </Button>
              {waiting.length > 1 && (
                <Button variant="secondary" onClick={() => void addAll()} disabled={busy !== null}>
                  {t("budget-sessions-add-all", { n: waiting.length })}
                </Button>
              )}
              <Button variant="primary" onClick={onClose} disabled={busy !== null}>
                {t("budget-sessions-done")}
              </Button>
            </>
          }
        </div>
      </div>
    </dialog>
  );
}
