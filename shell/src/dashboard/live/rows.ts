// The session table's order and countdown wording. No DOM, so the root test
// suite can import it.
import type { SessionsResponse, SessionView } from "../../../../src/lib/token-usage/sessions-schema";
import { t } from "../../i18n";

export type Session = SessionView;

const TEN_MINUTES_MS = 600_000;

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

/**
 * Time left on a session's cache: "3:12" under 10 minutes, "48 min" from 10
 * minutes on. Rounded up, so the last second reads "0:01" and "0:00" never
 * shows (the row is cold by then). A lifetime the proxy hasn't seen work yet
 * says "about".
 */
export function formatCountdown(
  msLeft: number,
  confidence: Session["cache"]["confidence"],
  locale: string,
): string {
  const ms = Math.max(0, msLeft);
  let time: string;
  if (ms < TEN_MINUTES_MS) {
    const seconds = Math.ceil(ms / 1000);
    time = `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
  } else {
    time = new Intl.NumberFormat(locale, { style: "unit", unit: "minute", unitDisplay: "short" }).format(
      Math.ceil(ms / 60_000),
    );
  }
  return confidence === "observed" ? time : `${t("dashboard-sessions-about")} ${time}`;
}
