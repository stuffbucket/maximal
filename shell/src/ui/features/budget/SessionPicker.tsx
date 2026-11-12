import { useState } from "react";

import { t } from "../../../i18n";
import type { BudgetSessionsResponse } from "../../../../../src/lib/config/settings-types";
import { Button } from "../../components/Button";
import { EmptyState } from "../../components/EmptyState";
import { ProblemCallout } from "../../components/ProblemCallout";
import type { Problem } from "../../problems";

import { formatInstant } from "./format";
import type { BudgetFormat } from "./hooks";
import { sessionName } from "./labels";
import { RangePicker } from "./RangePicker";
import { type RangeChoice, isRangeReady } from "./range";
import { MAX_SESSIONS, type Session, modelMix, sessionMinutes } from "./sessions";

/** Sessions shown before "Show all": enough to find the ones you mean. */
const VISIBLE_SESSIONS = 12;

interface SessionPickerProps {
  choice: RangeChoice;
  onChoice: (next: RangeChoice) => void;
  report: BudgetSessionsResponse | null;
  isLoading: boolean;
  problem: Problem | null;
  onRetry: () => void;
  format: BudgetFormat;
  /** The sessions picked so far, which stay picked when the range changes. */
  picked: ReadonlyMap<string, Session>;
  onToggle: (session: Session) => void;
  onClear: () => void;
  disabled?: boolean;
}

/** "claude-sonnet-5-5 62%, claude-opus-5 30%, and 2 more". */
function mixText(session: Session, locale: string): string {
  const { shown, more } = modelMix(session);
  const parts = shown.map((mix) => t("budget-session-model", { model: mix.model, share: mix.share }));
  if (more > 0) parts.push(t("budget-session-more-models", { n: more }));
  return new Intl.ListFormat(locale, { style: "short", type: "unit" }).format(parts);
}

/**
 * The sessions to size rules from: a range picker, then one row per session,
 * the biggest spender first, each with what it cost, how long it ran and which
 * models it used. A row is a checkbox, so it reads and acts as one. What is
 * picked stays picked when the range changes (a count says how many are out of
 * view), and picking none means "all usage in the range", which the button says.
 */
export function SessionPicker(props: SessionPickerProps): JSX.Element {
  const { choice, onChoice, report, isLoading, problem, onRetry, format, picked, onToggle, onClear, disabled = false } = props;
  const [showAll, setShowAll] = useState(false);
  const ready = isRangeReady(choice);
  const sessions = report?.sessions ?? [];
  const shown = showAll ? sessions : sessions.slice(0, VISIBLE_SESSIONS);
  const inView = new Set(sessions.map((session) => session.id));
  const outOfView = [...picked.keys()].filter((id) => !inView.has(id)).length;
  const atLimit = picked.size >= MAX_SESSIONS;

  return (
    <div className="session-picker" aria-busy={isLoading}>
      <RangePicker id="budget-sessions-range" value={choice} disabled={disabled} onChange={(next) => { onChoice(next); setShowAll(false); }} />
      {problem && ready && <ProblemCallout problem={problem} onRetry={onRetry} onRestarted={onRetry} />}
      {!ready && <p className="panel-status">{t("budget-range-incomplete")}</p>}
      {ready && !report && isLoading && <p className="panel-status">{t("budget-loading-sessions")}</p>}
      {ready && report && sessions.length === 0 && (
        <EmptyState title={t("budget-sessions-empty-title")} compact>
          <p>{t("budget-sessions-empty-body")}</p>
        </EmptyState>
      )}
      {ready && report && sessions.length > 0 && (
        <>
          <div className="session-picker__head">
            <p className="form__hint">
              {t("budget-sessions-count", { shown: sessions.length, total: report.total_sessions })}
            </p>
            {picked.size > 0 && (
              <Button variant="ghost" size="sm" onClick={onClear} disabled={disabled}>
                {t("budget-sessions-clear", { n: picked.size })}
              </Button>
            )}
          </div>
          <ul className="session-list">
            {shown.map((session) => {
              const checked = picked.has(session.id);
              return (
                <li key={session.id}>
                  <label className="session-row">
                    <input
                      type="checkbox"
                      className="checkbox session-row__box"
                      checked={checked}
                      disabled={disabled || (!checked && atLimit)}
                      onChange={() => onToggle(session)}
                    />
                    <span className="session-row__main">
                      <span className="session-row__name">{sessionName(session)}</span>
                      <span className="session-row__meta">
                        {t("budget-session-meta", {
                          when: formatInstant(session.started_at, format.locale, true),
                          requests: session.requests,
                          minutes: sessionMinutes(session),
                        })}
                      </span>
                      <span className="session-row__meta">{mixText(session, format.locale)}</span>
                    </span>
                    <span className="session-row__cost">{format.money(session.amount)}</span>
                  </label>
                </li>
              );
            })}
          </ul>
          {sessions.length > VISIBLE_SESSIONS && (
            <div>
              <Button variant="ghost" size="sm" onClick={() => setShowAll((open) => !open)} aria-expanded={showAll} disabled={disabled}>
                {showAll ? t("budget-show-fewer") : t("budget-show-all", { n: sessions.length })}
              </Button>
            </div>
          )}
        </>
      )}
      {outOfView > 0 && <p className="form__hint">{t("budget-sessions-out-of-view", { n: outOfView })}</p>}
      {atLimit && <p className="form__hint">{t("budget-sessions-max", { n: MAX_SESSIONS })}</p>}
    </div>
  );
}
