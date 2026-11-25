/**
 * The logic behind "Create rules from sessions", free of the DOM and the
 * catalog so it can be tested on its own (tests/budget-sessions.test.ts):
 * which sessions to list, what to ask the server to size, and how a
 * suggested rule becomes something the editor or a PUT can take.
 */

import type {
  BudgetLimitPutRequest,
  BudgetPersonaId,
  BudgetSessionsResponse,
  BudgetSuggestRequest,
  BudgetSuggestResponse,
} from "../../../../../src/lib/config/settings-types";

import {
  type DisplayInfo,
  type LimitForm,
  type LimitReset,
  amountText,
  nanoToDisplay,
  resetChoice,
  warnPercentText,
} from "./format";
import { type RangeChoice, rangeBody, rangeParams } from "./range";

export type Session = BudgetSessionsResponse["sessions"][number];
export type SuggestedRule = BudgetSuggestResponse["limits"][number];

/** The personas the suggestion accepts, each a shape of rules: what the picker offers, in order. */
export const SUGGEST_PERSONAS: ReadonlyArray<BudgetPersonaId> = [
  "trying-things-out",
  "daily-driver",
  "heavy-agent-use",
  "team",
];

/** "Let Maximal choose": no persona, which sizes a daily and a weekly cap and a daily cap for a plugin with a big share. */
export type PersonaChoice = BudgetPersonaId | "auto";

/** The most sessions one suggestion takes (the API's limit). */
export const MAX_SESSIONS = 200;

/** How many sessions the picker lists, biggest spender first. */
export const LISTED_SESSIONS = 100;

/** The request path for the sessions to pick from, or null while a custom range is incomplete. */
export function sessionsPath(choice: RangeChoice): `/settings/api/budget/sessions?${string}` | null {
  const range = rangeParams(choice);
  if (!range) return null;
  return `/settings/api/budget/sessions?${new URLSearchParams([...range, ["limit", String(LISTED_SESSIONS)]]).toString()}`;
}

/** What the picked sessions add up to, for the line above the button. */
export function selectionTotals(
  sessions: ReadonlyArray<Session>,
  selected: ReadonlySet<string>,
): { count: number; requests: number; nanoAiu: number; amount: number } {
  let requests = 0;
  let nanoAiu = 0;
  let amount = 0;
  let count = 0;
  for (const session of sessions) {
    if (!selected.has(session.id)) continue;
    count += 1;
    requests += session.requests;
    nanoAiu += session.nano_aiu;
    amount += session.amount;
  }
  return { count, requests, nanoAiu, amount };
}

/**
 * The suggestion to ask for. With sessions picked, those sessions alone (the
 * server runs the range from their first request to now); with none, all usage
 * in the range. Null while a custom range is incomplete.
 */
export function suggestRequest(
  selected: ReadonlyArray<string>,
  choice: RangeChoice,
  persona: PersonaChoice,
): BudgetSuggestRequest | null {
  const shape = persona === "auto" ? {} : { persona };
  if (selected.length > 0) return { session_ids: selected.slice(0, MAX_SESSIONS), ...shape };
  const range = rangeBody(choice);
  return range === null ? null : { range, ...shape };
}

/** The models of a session as "claude-sonnet-5-5 62%": the biggest `max`, and how many more there are. */
export function modelMix(session: Session, max = 3): { shown: Array<{ model: string; share: number }>; more: number } {
  const shown = session.models.slice(0, max).map((mix) => ({ model: mix.model, share: mix.share }));
  return { shown, more: Math.max(0, session.models.length - shown.length) };
}

/** A session's length: "12 min" is the caller's to word; this is whole minutes, at least one. */
export function sessionMinutes(session: Pick<Session, "duration_ms">): number {
  return Math.max(1, Math.round(session.duration_ms / 60_000));
}

/** Whether the editor can open a draft with this reset: it offers daily, weekly, never and a followed window only. */
export function editorSupportsReset(reset: LimitReset): boolean {
  return typeof reset === "string" || "follow" in reset;
}

/** A suggested rule as the body of the PUT that adds it (the amount in nano-AIU, so nothing is rounded again). */
export function draftToPut(rule: SuggestedRule): BudgetLimitPutRequest {
  return {
    label: rule.label,
    scope: rule.scope,
    limit: rule.limit,
    limit_reset: rule.limit_reset,
    warn_at: rule.warn_at,
    action: rule.action,
  };
}

/** A suggested rule as the editor's form, in the current display unit and the locale's decimal mark. */
export function draftForm(rule: SuggestedRule, display: DisplayInfo, locale: string): LimitForm {
  return {
    label: rule.label,
    scopeKind: rule.scope.kind,
    scopeId: rule.scope.kind === "global" ? "" : rule.scope.id,
    // Convert from the canonical nano-AIU amount. The display unit may have
    // changed in another window since this suggestion was produced.
    amount: amountText(nanoToDisplay(rule.limit, display), locale),
    reset: resetChoice(rule.limit_reset),
    warnPercent: warnPercentText(rule.warn_at),
    action: rule.action,
  };
}
