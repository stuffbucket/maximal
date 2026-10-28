// The session table's order, its wording (countdowns, times, the context
// meter's figures) and the cold rows it shows. No DOM, so the root test suite
// can import it.
import type { SessionsResponse, SessionView } from "../../../../src/lib/token-usage/sessions-schema";
import { t } from "../../i18n";

export type Session = SessionView;

const TEN_MINUTES_S = 600;
const HOUR_S = 3600;

/** Cold rows shown before "Show N more". */
export const COLD_ROWS = 20;

/** Context fill from which the meter warns, and from which it's an error. */
const CONTEXT_LOW = 75;
const CONTEXT_OUT = 90;

const byRateThenRecency = (a: Session, b: Session): number =>
  b.rate_per_min - a.rate_per_min || b.last_request_at_ms - a.last_request_at_ms;

const byRecency = (a: Session, b: Session): number => b.last_request_at_ms - a.last_request_at_ms;

/**
 * Above the line: streaming and warm sessions, busiest first (tokens/min, then
 * the latest activity). Below it: cold sessions, the latest activity first.
 * "Other requests" rows sort the same way as sessions.
 */
export function sortSessions(sessions: SessionsResponse["sessions"]): {
  above: Array<Session>;
  below: Array<Session>;
} {
  return {
    above: sessions.filter((s) => s.state !== "cold").sort(byRateThenRecency),
    below: sessions.filter((s) => s.state === "cold").sort(byRecency),
  };
}

/**
 * The view as of `nowMs`: a warm session whose cache has run out reads cold
 * now, without waiting for the next poll. Warm means `now < expires_at_ms`, so
 * a session exactly at its expiry is cold. Streaming sessions stay as the
 * server said. Returns `view` itself when nothing changed.
 */
export function liveSessions(view: SessionsResponse, nowMs: number): SessionsResponse {
  const expired = (s: Session): boolean =>
    s.state === "warm" && s.cache.expires_at_ms !== null && nowMs >= s.cache.expires_at_ms;
  if (!view.sessions.some(expired)) return view;
  return {
    ...view,
    sessions: view.sessions.map((s) => (expired(s) ? { ...s, state: "cold" } : s)),
  };
}

function formatUnit(value: number, unit: "minute" | "hour", locale: string): string {
  return new Intl.NumberFormat(locale, { style: "unit", unit, unitDisplay: "short" }).format(value);
}

/**
 * Time left on a session's cache: "3:12" under 10 minutes, "48 min" from 10
 * minutes, "24 hr" (in whole hours) from an hour. Seconds and minutes round
 * up, so the last second reads "0:01" and "0:00" never shows (the row is cold
 * by then). A lifetime the proxy hasn't seen work yet says "about".
 */
export function formatCountdown(
  msLeft: number,
  confidence: Session["cache"]["confidence"],
  locale: string,
): string {
  // Switch on the rounded values, so 599.5 s reads "10 min", not "10:00", and
  // 3599 s reads "1 hr", not "60 min".
  const seconds = Math.ceil(Math.max(0, msLeft) / 1000);
  const minutes = Math.ceil(seconds / 60);
  const time =
    seconds < TEN_MINUTES_S ? `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`
    : minutes < 60 ? formatUnit(minutes, "minute", locale)
    : formatUnit(Math.round(seconds / HOUR_S), "hour", locale);
  return confidence === "observed" ? time : t("dashboard-sessions-about", { time });
}

/**
 * Formats a time as the table shows it: the time of day for today, with a
 * short day in front for any other day ("Tue 10:42 AM"), so a session from
 * yesterday doesn't read as today's.
 */
export function clockFormatter(locale: string): (ms: number, nowMs: number) => string {
  const today = new Intl.DateTimeFormat(locale, { timeStyle: "short" });
  const otherDay = new Intl.DateTimeFormat(locale, { weekday: "short", hour: "numeric", minute: "2-digit" });
  return (ms, nowMs) =>
    new Date(ms).toDateString() === new Date(nowMs).toDateString() ? today.format(ms) : otherDay.format(ms);
}

/** "Cache didn't last 1 hour; using 5 min", naming the lifetime that failed. */
export function downgradedText(lifetimeS: number, locale: string): string {
  const lifetime =
    lifetimeS % HOUR_S === 0 ?
      new Intl.NumberFormat(locale, { style: "unit", unit: "hour", unitDisplay: "long" }).format(lifetimeS / HOUR_S)
    : new Intl.NumberFormat(locale, { style: "unit", unit: "minute", unitDisplay: "long" }).format(
        Math.round(lifetimeS / 60),
      );
  return t("dashboard-sessions-downgraded", { lifetime });
}

/** What the context meter draws, as percentages of its track. */
export interface ContextMeter {
  /** Used, as a share of the limit: the smaller of the window and Copilot's
   *  ceiling. */
  percent: number;
  level: "ok" | "low" | "out";
  /** The fill's length: the percent, kept within the track. */
  fill: number;
  /** Where the client compacts, when that's below the limit. */
  compactAt: number | null;
  title: string;
}

/**
 * The context meter for a session. The track is the limit, the smaller of
 * the window and Copilot's ceiling, so the fill, the percent and its warning
 * steps all agree. When the ceiling is the lower one, the tooltip names both
 * and credits each to its own source. A compaction point below the limit gets
 * a tick and a tooltip line of its own. Null with neither number known.
 */
export function contextMeter(context: Session["context"], locale: string): ContextMeter | null {
  const { used_tokens: used, ceiling_tokens: ceiling, compact_at_tokens: compact, window_source } = context;
  const window = context.window_tokens ?? ceiling;
  if (window === null || window <= 0) return null;
  const lowerCeiling = ceiling !== null && ceiling > 0 && ceiling < window ? ceiling : null;
  const limit = lowerCeiling ?? window;
  const percent = (used / limit) * 100;
  const share = (n: number): number => Math.min(100, Math.max(0, (n / limit) * 100));
  const numbers = new Intl.NumberFormat(locale);
  const source = t(`dashboard-sessions-source-${window_source}`);
  const lines = [
    lowerCeiling === null ?
      t("dashboard-sessions-context-title", { used: numbers.format(used), window: numbers.format(window), source })
    : t("dashboard-sessions-context-title-ceiling", {
        used: numbers.format(used),
        ceiling: numbers.format(lowerCeiling),
        window: numbers.format(window),
        source,
      }),
  ];
  const compactAt = compact !== null && compact > 0 && compact < limit ? share(compact) : null;
  if (compactAt !== null && compact !== null) {
    lines.push(t("dashboard-sessions-context-compact", { tokens: numbers.format(compact) }));
  }
  return {
    percent,
    level:
      percent >= CONTEXT_OUT ? "out"
      : percent >= CONTEXT_LOW ? "low"
      : "ok",
    fill: share(used),
    compactAt,
    title: lines.join("\n"),
  };
}

/** The cold rows to show: the first COLD_ROWS unless expanded, and how many
 *  more there are. */
export function coldRows(cold: Array<Session>, expanded: boolean): { shown: Array<Session>; hidden: number } {
  if (expanded || cold.length <= COLD_ROWS) return { shown: cold, hidden: 0 };
  return { shown: cold.slice(0, COLD_ROWS), hidden: cold.length - COLD_ROWS };
}
