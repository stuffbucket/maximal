// The Dashboard's live sessions: polls GET /token-usage/sessions every 2 s
// while the page is visible, ticks the cache countdowns every second, and owns
// the selection shared by the live card and session table.
//
// Both render into fixed hosts in index.html that main.ts's string renders
// never touch, so the selection, hover, focus and the card's animation survive
// every summary re-render.
import { SessionsResponse } from "../../../../src/lib/token-usage/sessions-schema";
import { fetchJson } from "../fetch-json";
import { mountLiveCard } from "./card";
import { liveSessions } from "./rows";
import { mountSessionTable } from "./table";

const SESSIONS_PATH = "/token-usage/sessions";
const POLL_MS = 2_000;
/** A read that hasn't answered by now is given up, so a hung request can't
 *  stop the polling. */
const FETCH_TIMEOUT_MS = POLL_MS * 5;
const TICK_MS = 1_000;

/**
 * Start the live card and the session table inside `container` (the
 * Dashboard's content area, which holds `#live-sessions`, `#sessions` and
 * `#sessions-table`). Returns a function that stops the polling and the clock.
 */
export function startLiveSessions(container: HTMLElement): () => void {
  const cardHost = container.querySelector<HTMLElement>("#live-sessions");
  const metricsHost = container.querySelector<HTMLElement>("#live-metrics");
  const cacheHitHost = container.querySelector<HTMLElement>("#cache-hit");
  const sectionHost = container.querySelector<HTMLElement>("#sessions");
  const tableHost = container.querySelector<HTMLElement>("#sessions-table");
  if (!cardHost || !metricsHost || !cacheHitHost || !sectionHost || !tableHost) return () => {};
  const section: HTMLElement = sectionHost;

  const card = mountLiveCard(cardHost, metricsHost, cacheHitHost, (id) => {
    select(id);
    if (id === null) return;
    requestAnimationFrame(() => {
      const row = [...tableHost.querySelectorAll<HTMLElement>(".session-row")]
        .find((candidate) => candidate.dataset.sessionId === id);
      row?.scrollIntoView({ block: "nearest" });
    });
  });

  /** The last good payload, as the server sent it. */
  let latest: SessionsResponse | null = null;
  let selected: string | null = null;
  let preview: string | null = null;
  /** Each session's id and state as last given to the card, to skip no-op updates. */
  let cardKey = "";

  let pollTimer: number | null = null;
  let tickTimer: number | null = null;
  let polling = false;
  let stopped = false;
  let surfaceVisible = !new URLSearchParams(location.search).has("embedded");
  const isVisible = (): boolean =>
    surfaceVisible && document.visibilityState === "visible";

  /** Redraw from `latest` as of now. The card only redraws when asked or when
   *  a session changed state (a countdown ran out). */
  function refresh(redrawCard: boolean): void {
    if (!latest) return;
    const now = Date.now();
    const view = liveSessions(latest, now);
    section.hidden = view.sessions.length === 0;

    const ids = new Set(view.sessions.map((s) => s.id));
    if (selected !== null && !ids.has(selected)) selected = null;
    if (preview !== null && !ids.has(preview)) preview = null;

    table.update(view, selected, now);
    table.preview(preview);

    const key = view.sessions.map((s) => `${s.id}:${s.state}`).join("|");
    if (redrawCard || key !== cardKey) {
      cardKey = key;
      card.update(view, preview ?? selected);
    }
  }

  function select(id: string | null): void {
    if (id === selected) return;
    selected = id;
    refresh(true);
  }

  function setPreview(id: string | null): void {
    if (id === preview) return;
    preview = id;
    if (!latest) return;
    table.preview(id);
    card.update(liveSessions(latest, Date.now()), preview ?? selected);
  }

  const table = mountSessionTable(tableHost, select, setPreview);

  async function poll(): Promise<void> {
    pollTimer = null;
    if (polling || stopped) return;
    polling = true;
    try {
      const body = await fetchJson<unknown>(SESSIONS_PATH, {
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
      if (stopped) return;
      const parsed = SessionsResponse.safeParse(body);
      if (parsed.success) {
        latest = parsed.data;
        card.showError(null);
        refresh(true);
      } else {
        // Keep what's on screen; say the new data couldn't be read.
        card.showError(parsed.error.issues[0]?.message ?? parsed.error.message);
      }
    } catch (error) {
      // A failed or timed-out read: say so, keep what's shown, try again.
      if (!stopped) card.showError(error instanceof Error ? error.message : String(error));
    } finally {
      polling = false;
      schedule();
    }
  }

  function schedule(): void {
    if (stopped || pollTimer !== null || !isVisible()) return;
    pollTimer = window.setTimeout(() => void poll(), POLL_MS);
  }

  function startClock(): void {
    if (tickTimer === null) tickTimer = window.setInterval(() => refresh(false), TICK_MS);
  }

  function stopTimers(): void {
    if (pollTimer !== null) window.clearTimeout(pollTimer);
    if (tickTimer !== null) window.clearInterval(tickTimer);
    pollTimer = null;
    tickTimer = null;
  }

  function updateActivity(): void {
    if (!isVisible()) {
      stopTimers();
      return;
    }
    startClock();
    // Catch up straight away: the data is as old as the hidden stretch.
    if (pollTimer !== null) window.clearTimeout(pollTimer);
    pollTimer = null;
    void poll();
  }

  function onDashboardVisibility(event: MessageEvent<unknown>): void {
    if (event.origin !== location.origin || typeof event.data !== "object" || event.data === null) return;
    const message = event.data as { type?: unknown; visible?: unknown };
    if (message.type !== "maximal:dashboard-visibility" || typeof message.visible !== "boolean") return;
    surfaceVisible = message.visible;
    updateActivity();
  }

  // Escape clears the selection, unless something else already took the key
  // or it was meant for a form control (the language menu, say).
  function onKeydown(event: KeyboardEvent): void {
    if (event.key !== "Escape" || selected === null || event.defaultPrevented) return;
    const target = event.target;
    if (
      target instanceof HTMLInputElement ||
      target instanceof HTMLSelectElement ||
      target instanceof HTMLTextAreaElement ||
      (target instanceof HTMLElement && target.isContentEditable)
    ) {
      return;
    }
    select(null);
  }

  document.addEventListener("keydown", onKeydown);
  document.addEventListener("visibilitychange", updateActivity);
  window.addEventListener("message", onDashboardVisibility);
  if (window.parent !== window) {
    window.parent.postMessage({ type: "maximal:dashboard-ready" }, location.origin);
  }

  if (isVisible()) updateActivity();

  return () => {
    stopped = true;
    stopTimers();
    card.destroy();
    document.removeEventListener("keydown", onKeydown);
    document.removeEventListener("visibilitychange", updateActivity);
    window.removeEventListener("message", onDashboardVisibility);
  };
}
