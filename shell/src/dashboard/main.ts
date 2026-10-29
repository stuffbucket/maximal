// Maximal — Dashboard client script (bundled TS entry).
//
// Loaded as an ES module with `defer` semantics (Bun bundles this into
// shell/dist/ui/dashboard/main.js; Tailwind + Lucide stay CLASSIC <script>
// globals loaded before it in index.html — see the `declare` blocks below).
// It shares the SAME i18n runtime + catalog as Settings: `t()` from ../i18n
// and the DOM binder from ../i18n/apply. The visible output is unchanged from
// the previous vanilla main.js — only the strings now route through the
// catalog and a locale picker is wired into the header.
import { resolveLocale, t } from "../i18n";
import { applyI18n, wireLocalePicker } from "../i18n/apply";
import { fetchJson } from "./fetch-json";
import { startLiveSessions } from "./live/controller";

// Tailwind + Lucide are loaded as classic global <script>s in index.html, so
// they exist on `window` at runtime; the bundle references them as ambient
// globals rather than importing (importing would break their global setup).
declare const lucide: { createIcons: () => void } | undefined;

interface TauriCore {
  Channel: new () => TauriChannel;
  invoke: (cmd: string, args: Record<string, unknown>) => Promise<unknown>;
}
interface TauriChannel {
  onmessage: ((message: TokenUsageChannelMessage) => void) | null;
}
interface TauriGlobal {
  __TAURI__?: { core?: TauriCore };
}

// --- Wire-shape types (only the fields this UI reads) ----------------------
interface TokenUsageTotals {
  cache_creation_input_tokens: number;
  cache_read_input_tokens: number;
  input_tokens: number;
  output_tokens: number;
  request_count: number;
  total_tokens: number;
  total_nano_aiu: number;
}
interface TokenUsageRange {
  start_ms: number;
  end_ms: number;
}
interface TokenUsageModelRow extends TokenUsageTotals {
  model: string;
}
interface TokenUsageSummary {
  totals?: TokenUsageTotals;
  range?: TokenUsageRange;
  byModel: TokenUsageModelRow[];
}
interface TokenUsageEvent {
  created_at_utc: string;
  created_at_ms: number;
  user_id: string | null;
  session_id: string | null;
  trace_id: string | null;
  endpoint: string;
  model: string;
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens: number;
  cache_creation_input_tokens: number;
  total_tokens: number;
}
interface TokenUsageEventsPage {
  items: TokenUsageEvent[];
  page: number;
  total: number;
  total_pages: number;
  range?: TokenUsageRange;
}
interface QuotaDetails {
  entitlement: number;
  remaining: number;
  percent_remaining: number;
  unlimited: boolean;
}
interface UsageData {
  quota_snapshots?: Record<string, QuotaDetails> | null;
  /** When the quotas next reset (GitHub sends a date, "2025-07-01", UTC).
   *  The end of the current period; GitHub doesn't send its start. */
  quota_reset_date?: string;
}
interface TokenUsageChannelMessage {
  event?: "update" | "error";
  data?: { payload?: TokenUsageSummary; message?: string };
}
type Period = "day" | "week" | "month";

const tokenUsagePeriodGroup = document.getElementById(
  "token-usage-period",
) as HTMLElement;
const tokenUsagePeriodButtons = Array.from(
  tokenUsagePeriodGroup.querySelectorAll<HTMLButtonElement>("[data-period]"),
);
const contentArea = document.getElementById("content-area") as HTMLElement;
// The bento and the session table stay in the page across renders: render()
// fills the quota column and the rest of the page, never the live card or the
// session table, which the live sessions controller updates in place (see
// index.html and live/controller.ts).
const bento = document.getElementById("dashboard-bento") as HTMLElement;
const quotaSection = document.getElementById("usage-column") as HTMLElement;
const quotaColumn = document.getElementById("usage-quotas") as HTMLElement;
const restArea = document.getElementById("dashboard-rest") as HTMLElement;

// The dashboard always talks to the proxy that served it — same
// origin, no user-typed URL. Each fetch is a relative path; the
// browser resolves it against window.location automatically.
const USAGE_PATH = "/usage";
const TOKEN_USAGE_PATH = "/token-usage";
const DEFAULT_TOKEN_USAGE_PERIOD: Period = "day";
const DEFAULT_TOKEN_USAGE_EVENTS_PAGE_SIZE = 20;
const VALID_PERIODS = new Set<Period>(["day", "week", "month"]);
const EMPTY_TOKEN_USAGE_TOTALS: TokenUsageTotals = {
  cache_creation_input_tokens: 0,
  cache_read_input_tokens: 0,
  input_tokens: 0,
  output_tokens: 0,
  request_count: 0,
  total_tokens: 0,
  total_nano_aiu: 0,
};

// --- State Management ---
interface DashboardState {
  isLoading: boolean;
  isTokenUsageLoading: boolean;
  isEventsLoading: boolean;
  error: string | null;
  data: UsageData | null;
  tokenUsageSummary: TokenUsageSummary | null;
  tokenUsageEventsPage: TokenUsageEventsPage | null;
  tokenUsageSummaryError: string | null;
  tokenUsageEventsError: string | null;
  tokenUsagePeriod: Period;
  /** When `data` (/usage) was fetched; /usage is live from GitHub, so this
   *  is "as of". */
  usageFetchedAt: number | null;
  /** Last background /usage refetch attempt (rate-limits them). */
  usageRefetchAt: number;
  /** Whether the "Chat and completions" quotas are unfolded. Render rebuilds
   *  the page from strings, so the open state lives here, not in the DOM. */
  quotaMoreOpen: boolean;
}

const QUOTA_MORE_STORAGE_KEY = "maximal.dashboard.quotaMoreOpen";

/** The remembered open state; closed when storage is empty or unavailable. */
function readQuotaMoreOpen(): boolean {
  try {
    return localStorage.getItem(QUOTA_MORE_STORAGE_KEY) === "1";
  } catch {
    return false;
  }
}

function writeQuotaMoreOpen(open: boolean): void {
  try {
    localStorage.setItem(QUOTA_MORE_STORAGE_KEY, open ? "1" : "0");
  } catch {
    // Private window or blocked storage: the choice lasts until reload.
  }
}

const state: DashboardState = {
  isLoading: false,
  isTokenUsageLoading: false,
  isEventsLoading: false,
  error: null,
  data: null,
  tokenUsageSummary: null,
  tokenUsageEventsPage: null,
  tokenUsageSummaryError: null,
  tokenUsageEventsError: null,
  tokenUsagePeriod: DEFAULT_TOKEN_USAGE_PERIOD,
  usageFetchedAt: null,
  usageRefetchAt: 0,
  quotaMoreOpen: readQuotaMoreOpen(),
};

// --- Tauri Channel live feed -------------------------------------------
// When the dashboard runs inside a Tauri webview, token-usage updates
// arrive on a Channel<TokenUsageEvent> driven by the Rust shell. The
// shell polls `/token-usage?period=…` every 5s and sends each snapshot
// down the channel; dropping `activeTokenUsageChannel` (period change,
// page unload) closes Rust's loop on its next send.
//
// In a plain browser (`window.__TAURI__` undefined) we poll the
// `/token-usage?period=…` endpoint directly every 5s as a fallback —
// there's no Fetch button, the data refreshes itself.
//
// Detection is deferred to init() because `window.__TAURI__` isn't
// guaranteed to be injected by the time this script's top-level code
// runs (Tauri injects asynchronously after webview creation). A module-
// top check returned a false negative, leaving Tauri-mode features off.
let tauriCore: TauriCore | null = null;
let runningInTauri = false;
let activeTokenUsageChannel: TauriChannel | null = null;
let browserPollTimer: number | null = null;
/** After a failed fetch, wait this long instead (don't hammer the sidecar). */
const BROWSER_RETRY_INTERVAL_MS = 5000;

/** Data-update interval: 500 ms per digit of the total tokens used (0–9 →
 *  500 ms, 10–99 → 1 s, … 100K–999,999 → 3 s), and a flat 10 s from a
 *  million on. The point is only to show tokens are coming in, not to hammer
 *  the sidecar. Same rule as `dashboard_poll_interval` in
 *  shell/src-tauri/src/lib.rs. */
function pollIntervalMs(totalTokens: number | undefined): number {
  const total = Math.max(0, Math.trunc(Number.isFinite(totalTokens) ? Number(totalTokens) : 0));
  if (total >= 1_000_000) return 10_000;
  return 500 * String(total).length;
}

function applyTokenUsagePayload(payload: TokenUsageSummary | undefined): void {
  state.tokenUsageSummary = payload ?? null;
  state.tokenUsageSummaryError = null;
  state.isTokenUsageLoading = false;
  render();
}

function applyTokenUsageError(message: string): void {
  // Don't clobber a previously good summary — the user keeps seeing
  // the last known state plus a small error chip.
  state.tokenUsageSummaryError = message;
  render();
}

function subscribeTokenUsage(period: Period): void {
  if (!runningInTauri || !tauriCore) return;
  const channel = new tauriCore.Channel();
  channel.onmessage = (message) => {
    // `activeTokenUsageChannel` is the liveness reference — once it's
    // been replaced (period change) or nulled (page unload), drop any
    // straggler messages from the previous Rust loop.
    if (channel !== activeTokenUsageChannel) return;
    if (message && message.event === "update") {
      applyTokenUsagePayload(message.data && message.data.payload);
    } else if (message && message.event === "error") {
      applyTokenUsageError(
        (message.data && message.data.message) || t("dashboard-unknown-error"),
      );
    }
  };
  activeTokenUsageChannel = channel;
  state.isTokenUsageLoading = true;
  render();
  tauriCore
    .invoke("subscribe_token_usage", { period, onEvent: channel })
    .catch((error: unknown) => {
      // Rust returns Ok(()) on channel-drop, so this catch only fires
      // on a real invoke failure (e.g. command not registered).
      if (channel === activeTokenUsageChannel) {
        applyTokenUsageError(getErrorMessage(error));
      }
    });
}

function unsubscribeTokenUsage(): void {
  // Dropping the JS reference is the signal — Rust's `Channel::send`
  // returns Err on the next tick and the poll loop exits.
  activeTokenUsageChannel = null;
}

// --- Rendering Logic ---

/**
 * Safely calls lucide.createIcons() if the library is available.
 */
function createIcons(): void {
  if (typeof lucide !== "undefined" && lucide) {
    lucide.createIcons();
  }
}

function escapeHtml(value: unknown): string {
  // Use regex .replace (ES2020-safe) rather than .replaceAll — the shell
  // tsconfig targets ES2020, and this file is now typechecked (it lives under
  // src/, unlike the old shell/ui vanilla main.js where replaceAll was fine).
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return typeof error === "string" ? error : t("dashboard-unknown-error");
}

function isMissingTokenUsageEndpointError(error: unknown): boolean {
  return Boolean(
    error &&
      typeof error === "object" &&
      "status" in error &&
      (error as { status?: number }).status === 404,
  );
}

function normalizePeriod(value: string | null): Period {
  return value !== null && VALID_PERIODS.has(value as Period)
    ? (value as Period)
    : DEFAULT_TOKEN_USAGE_PERIOD;
}

function getSelectedPeriod(): Period {
  const pressed = tokenUsagePeriodButtons.find(
    (button) => button.getAttribute("aria-pressed") === "true",
  );
  const normalized = normalizePeriod(
    pressed ? pressed.getAttribute("data-period") : null,
  );
  setSelectedPeriod(normalized);
  return normalized;
}

function setSelectedPeriod(period: Period): void {
  const normalized = normalizePeriod(period);
  for (const button of tokenUsagePeriodButtons) {
    const isActive = button.getAttribute("data-period") === normalized;
    button.setAttribute("aria-pressed", isActive ? "true" : "false");
  }
  state.tokenUsagePeriod = normalized;
}

function buildTokenUsageSummaryUrl(period: Period): string {
  const url = new URL(TOKEN_USAGE_PATH, window.location.origin);
  url.searchParams.set("period", period);
  return url.toString();
}

function buildTokenUsageEventsUrl(period: Period, page: number): string {
  const url = new URL(`${TOKEN_USAGE_PATH}/events`, window.location.origin);
  url.searchParams.set("period", period);
  url.searchParams.set("page", String(page));
  url.searchParams.set(
    "page_size",
    String(DEFAULT_TOKEN_USAGE_EVENTS_PAGE_SIZE),
  );
  return url.toString();
}

function syncUrlState(): void {
  try {
    const currentUrl = new URL(window.location.href);
    currentUrl.searchParams.set("period", getSelectedPeriod());
    window.history.pushState({}, "", currentUrl);
  } catch (error) {
    console.warn("Could not update URL:", getErrorMessage(error));
  }
}

function updateControls(): void {
  const periodDisabled = state.isLoading || state.isTokenUsageLoading;
  for (const button of tokenUsagePeriodButtons) {
    button.disabled = periodDisabled;
  }

  // The window the numbers cover, beside the period control: compact text
  // from the hour-aligned baseline, the server's exact range on hover.
  const rangeEl = document.getElementById("token-usage-range");
  if (rangeEl) {
    const baseline = syncRangeBaseline(false);
    rangeEl.textContent = formatCompactRange(baseline.period, {
      start_ms: baseline.hourMs - PERIOD_DAYS[baseline.period] * 24 * HOUR_MS,
      end_ms: baseline.hourMs,
    });
    const range =
      state.tokenUsageSummary?.range || state.tokenUsageEventsPage?.range || null;
    rangeEl.title = renderTokenUsageRangeText(state.tokenUsagePeriod, range);
  }

  // The language globe's hover names the current language.
  const localeSelect = document.getElementById("locale-select") as HTMLSelectElement | null;
  if (localeSelect) localeSelect.title = localeSelect.selectedOptions[0]?.textContent ?? "";

  if (window.parent && window.parent !== window) {
    window.parent.postMessage(
      {
        type: "maximal:dashboard-state",
        period: state.tokenUsagePeriod,
        rangeText: rangeEl?.textContent ?? "",
        rangeTitle: rangeEl?.title ?? "",
      },
      window.location.origin,
    );
  }
}

const HOUR_MS = 3_600_000;
const PERIOD_DAYS: Record<Period, number> = { day: 1, week: 7, month: 30 };

/** What the range label shows: the selected period, back from the top of the
 *  hour it was computed in. Every period runs from now into the past, so the
 *  label has to move with the clock — but not on every 5s data update, and
 *  not while someone is looking at it. */
let rangeBaseline: { period: Period; hourMs: number } | null = null;

/**
 * Recompute the label's baseline when there's none yet or the period changed;
 * with `hourRolled`, also when the clock has moved into a new hour. Called
 * with `hourRolled` only as the Dashboard comes back into view (see the
 * visibilitychange listener), so the label never shifts while it's shown.
 */
function syncRangeBaseline(hourRolled: boolean): { period: Period; hourMs: number } {
  const hourMs = Math.floor(Date.now() / HOUR_MS) * HOUR_MS;
  if (
    !rangeBaseline ||
    rangeBaseline.period !== state.tokenUsagePeriod ||
    (hourRolled && rangeBaseline.hourMs !== hourMs)
  ) {
    rangeBaseline = { period: state.tokenUsagePeriod, hourMs };
  }
  return rangeBaseline;
}

/**
 * The token-usage window at the precision its period needs, in the UI
 * locale: a rolling day as weekday + hour ("Sat 8 AM – Sun 8 AM"), a week
 * or month as dates ("Jun 8 – 15"). No seconds, no year.
 */
function formatCompactRange(period: Period, range: TokenUsageRange): string {
  const options: Intl.DateTimeFormatOptions =
    period === "day" ?
      { weekday: "short", hour: "numeric" }
    : { month: "short", day: "numeric" };
  try {
    const format = new Intl.DateTimeFormat(resolveLocale(), options);
    if (period === "day") {
      // formatRange would add the day-of-month when the window crosses
      // midnight; two plain ends read better ("Sat 8 AM – Sun 8 AM").
      return `${format.format(range.start_ms)} – ${format.format(range.end_ms)}`;
    }
    // formatRange is ES2021 (every webview we ship has it); the shell's lib
    // target is ES2020, so type the one method we use.
    const ranged = format as Intl.DateTimeFormat & {
      formatRange: (start: number, end: number) => string;
    };
    return ranged.formatRange(range.start_ms, range.end_ms);
  } catch {
    return "";
  }
}

function formatNumber(value: number): string {
  return Number.isFinite(value) ? Number(value).toLocaleString() : "0";
}

// Copilot reports per-request cost in nano-AIU (1 AIU = 1e9 nano-AIU).
// See src/lib/token-usage/store.ts (`total_nano_aiu`). We render the human
// unit (AIU). Zero/absent cost is common — many models bill nothing here —
// so we show an em dash rather than `0.000 AIU` or `NaN`, per the design
// failure-modes guidance (graceful zero/absent handling).
const NANO_AIU_PER_AIU = 1_000_000_000;

function formatCostAiu(nanoAiu: number): string {
  if (!Number.isFinite(nanoAiu) || nanoAiu <= 0) {
    return "—";
  }
  const aiu = nanoAiu / NANO_AIU_PER_AIU;
  // Small values (e.g. 0.0096 AIU) need more digits than large ones. Trim
  // trailing zeros so 7.426 AIU doesn't read as 7.426000 AIU.
  const digits = aiu < 1 ? 4 : 3;
  const text = aiu.toLocaleString(undefined, {
    minimumFractionDigits: 0,
    maximumFractionDigits: digits,
  });
  return `${text} AIU`;
}

function formatDateTime(value: number): string {
  if (!Number.isFinite(value)) {
    return t("dashboard-not-available");
  }
  return new Date(value).toLocaleString();
}

function formatCellText(value: unknown): string {
  if (typeof value !== "string") {
    return "—";
  }
  const trimmed = value.trim();
  return trimmed || "—";
}

function renderTokenUsageRangeText(
  period: Period,
  range: TokenUsageRange | null,
): string {
  const labels: Record<Period, string> = {
    day: t("dashboard-window-day"),
    week: t("dashboard-window-week"),
    month: t("dashboard-window-month"),
  };

  if (!range) {
    return labels[period] || labels.day;
  }

  return t("dashboard-window-range", {
    label: labels[period] || labels.day,
    start: formatDateTime(range.start_ms),
    end: formatDateTime(range.end_ms),
  });
}

/**
 * Renders the entire UI based on the current state.
 */
function render(): void {
  updateControls();

  const quotasHtml =
    state.data ? renderUsageQuotas(state.data.quota_snapshots)
    : state.error ? renderQuotaColumn(renderError(state.error, t("dashboard-error-usage")))
    : state.isLoading ?
      renderQuotaColumn(`
        <div class="p-4 border text-sm" style="background-color: var(--surface-card); border-color: var(--border-subtle); color: var(--text-muted);">
          ${escapeHtml(t("common-working"))}
        </div>`)
    : "";

  const tokenUsageHtml = renderTokenUsageSection();
  const detailedHtml = state.data ? renderDetailedData(state.data) : "";

  // The quota column and the rest are rebuilt; the live card beside the
  // quotas is not (it updates in place).
  const welcome = !quotasHtml && !tokenUsageHtml && !detailedHtml;
  bento.hidden = welcome;
  bento.classList.toggle("dashboard-bento--live-only", !quotasHtml);
  quotaSection.hidden = !quotasHtml;
  quotaColumn.innerHTML = quotasHtml;
  restArea.innerHTML = welcome ? renderWelcomeMessage() : `${tokenUsageHtml}${detailedHtml}`;

  // Replace placeholder icons with actual Lucide icons
  createIcons();

  // Numbers from a finished quota period render as "—"; fetch the new ones.
  if (quotaPeriodEnded()) void refreshUsage();
}

/** The dynamic quota content inside the bento's static heading and card. */
function renderQuotaColumn(body: string): string {
  return `<div class="dashboard-bento__body">${body}</div>`;
}

/**
 * Renders the "Usage Quotas" column: the metered cards stacked, then the
 * unlimited ones folded away.
 */
function renderUsageQuotas(
  snapshots: Record<string, QuotaDetails> | null | undefined,
): string {
  if (!snapshots) return "";

  const entries = Object.entries(snapshots);
  const metered = entries.filter(([, value]) => !value.unlimited);
  const unlimited = entries.filter(([, value]) => value.unlimited);
  const resetMs = parseResetDate(state.data?.quota_reset_date);
  const meteredCards = metered
    .map(([key, value]) => renderQuotaCard(key, value, resetMs))
    .join("");
  // Unlimited quotas have nothing to measure, so they share one list, folded
  // away under the metered cards. With no metered card it is all there is.
  const unlimitedHtml =
    unlimited.length > 0 ? renderUnlimitedQuotas(unlimited.map(([key]) => key)) : "";

  if (!meteredCards && !unlimitedHtml) return "";
  return renderQuotaColumn(`
                ${meteredCards ? `<div class="flex flex-col gap-4">${meteredCards}</div>` : ""}
                ${unlimitedHtml}`);
}

/** GitHub's quota_reset_date as a timestamp. A bare date is midnight UTC. */
function parseResetDate(value: string | undefined): number | null {
  if (!value) return null;
  const ms = Date.parse(/^\d{4}-\d{2}-\d{2}$/.test(value) ? `${value}T00:00:00Z` : value);
  return Number.isFinite(ms) ? ms : null;
}

/** "Jul 1" in the UI locale. Shown in UTC: GitHub's date is a UTC date, and
 *  local time would turn "Jul 1" into "Jun 30" west of Greenwich. */
function formatResetDate(ms: number): string {
  return new Intl.DateTimeFormat(resolveLocale(), {
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  }).format(ms);
}

/**
 * Renders a single quota card: percent used as the headline, the meter, the
 * counts, and when the period resets. The meter's color says how close the
 * quota is to its limit (see .meter in style.css), with an icon from
 * "running low" on so the state never rests on color alone. Unlimited
 * quotas don't come here (renderUnlimitedQuotas): a full bar would read as
 * "used up".
 *
 * If the period these numbers belong to has already ended (the window sat
 * open across the reset), or GitHub's numbers don't add up, the figures show
 * "—" rather than a stale or made-up percentage.
 */
function renderQuotaCard(title: string, details: QuotaDetails, resetMs: number | null): string {
  const { entitlement, remaining, percent_remaining } = details;
  const ended = resetMs !== null && Date.now() >= resetMs;
  const known =
    !ended &&
    Number.isFinite(percent_remaining) &&
    Number.isFinite(entitlement) &&
    Number.isFinite(remaining) &&
    entitlement > 0;
  const percentUsed = known ? 100 - percent_remaining : 0;
  const level = !known ? "ok" : percentUsed >= 90 ? "out" : percentUsed >= 75 ? "low" : "ok";
  const icon = level === "ok" ? "" : `<i data-lucide="triangle-alert" aria-hidden="true"></i>`;

  const period =
    resetMs === null ? ""
    : ended ? t("dashboard-quota-period-ended", { date: formatResetDate(resetMs) })
    : t("dashboard-quota-resets", { date: formatResetDate(resetMs) });
  const asOf =
    state.usageFetchedAt === null ? ""
    : t("dashboard-quota-as-of", {
        time: new Intl.DateTimeFormat(resolveLocale(), { timeStyle: "short" }).format(state.usageFetchedAt),
      });

  return `
            <header class="usage-panel__header" title="${escapeHtml(asOf)}">
                <div class="usage-panel__heading">
                    <h3 class="usage-panel__title">${escapeHtml(title.replace(/_/g, " "))}</h3>
                    ${period ? `<p class="usage-panel__subtitle">${escapeHtml(period)}</p>` : ""}
                </div>
                <output class="usage-panel__headline meter-state meter-state--${level} meter-state--headline">${icon}${
                  known ?
                    escapeHtml(t("dashboard-quota-percent-used", { percent: percentUsed.toFixed(1) }))
                  : "—"
                }</output>
            </header>
            <div class="usage-panel__body">
                <progress class="quota-progress quota-progress--${known ? level : "unknown"}" max="100" value="${known ? Math.min(100, Math.max(0, percentUsed)) : 0}"></progress>
                <div class="usage-panel__meta">
                    <span>${known ? `${(entitlement - remaining).toLocaleString()} / ${entitlement.toLocaleString()}` : "—"}</span>
                    <span>${known ? escapeHtml(t("dashboard-quota-remaining", { n: remaining.toLocaleString() })) : ""}</span>
                </div>
            </div>
        `;
}

/**
 * The unlimited quotas, folded behind a chevron: name, then "Unlimited".
 * The open state is `state.quotaMoreOpen`; see handleQuotaMoreToggle.
 */
function renderUnlimitedQuotas(titles: Array<string>): string {
  const rows = titles
    .map(
      (title) => `
                <div class="quota-more__row">
                    <h3 class="quota-more__title">${escapeHtml(title.replace(/_/g, " "))}</h3>
                    <span class="quota-more__value">${escapeHtml(t("dashboard-quota-unlimited"))}</span>
                </div>`,
    )
    .join("");
  return `
            <details class="quota-more" data-quota-more${state.quotaMoreOpen ? " open" : ""}>
                <summary class="quota-more__summary"><i data-lucide="chevron-right" class="quota-more__chevron" aria-hidden="true"></i>${escapeHtml(t("dashboard-quotas-more"))}</summary>
                <div class="quota-more__body">${rows}
                </div>
            </details>
        `;
}

/**
 * Remembers the user's fold/unfold. `toggle` also fires when render() inserts
 * a details that already carries `open`; that matches the state, so it is
 * skipped and never rewrites storage.
 */
function handleQuotaMoreToggle(event: Event): void {
  const target = event.target;
  if (!(target instanceof HTMLDetailsElement) || !target.hasAttribute("data-quota-more")) {
    return;
  }
  if (target.open === state.quotaMoreOpen) return;
  state.quotaMoreOpen = target.open;
  writeQuotaMoreOpen(target.open);
}

/**
 * Recursively builds a formatted HTML list from a JSON object.
 */
function formatObject(obj: unknown): string {
  if (obj === null || typeof obj !== "object") {
    return `<span style="color: var(--status-success);">${escapeHtml(JSON.stringify(obj))}</span>`;
  }

  return (
    '<div class="pl-4">' +
    Object.entries(obj as Record<string, unknown>)
      .map(([key, value]) => {
        const formattedKey = escapeHtml(key.replace(/_/g, " "));
        let displayValue: string;

        if (Array.isArray(value)) {
          displayValue =
            value.length > 0
              ? `<span style='color: var(--text-muted)'>[...${value.length} items]</span>`
              : `<span style='color: var(--text-muted)'>[]</span>`;
        } else if (typeof value === "object" && value !== null) {
          displayValue = formatObject(value);
        } else if (typeof value === "boolean") {
          displayValue = `<span class="font-semibold" style="color: ${value ? "var(--status-success)" : "var(--status-error)"}">${escapeHtml(String(value))}</span>`;
        } else {
          displayValue = `<span style="color: var(--link);">${escapeHtml(JSON.stringify(value))}</span>`;
        }

        return `<div class="mt-1">
                        <span class="capitalize font-semibold" style="color: var(--text-base-color);">${formattedKey}:</span>
                        ${typeof value === "object" && value !== null && !Array.isArray(value) ? displayValue : ` ${displayValue}`}
                   </div>`;
      })
      .join("") +
    "</div>"
  );
}

/**
 * Renders the section with the full, formatted API response.
 */
function renderDetailedData(data: UsageData): string {
  const formattedDetails = formatObject(data);
  return `
            <section id="detailed-data">
                <h2 class="section__title"><i data-lucide="file-text" aria-hidden="true"></i>${escapeHtml(t("dashboard-api-response-title"))}</h2>
                <div class="border p-4 relative font-mono text-xs code-block overflow-auto" style="background-color: var(--surface-base); border-color: var(--border-subtle);">
                    ${formattedDetails}
                </div>
            </section>
        `;
}

function renderTokenUsageSection(): string {
  const hasTokenUsageContent = Boolean(
    state.isTokenUsageLoading ||
      state.isEventsLoading ||
      state.tokenUsageSummary ||
      state.tokenUsageEventsPage ||
      state.tokenUsageSummaryError ||
      state.tokenUsageEventsError,
  );

  if (!hasTokenUsageContent) {
    return "";
  }

  const summary = state.tokenUsageSummary;
  const eventsPage = state.tokenUsageEventsPage;
  const totals = summary?.totals || EMPTY_TOKEN_USAGE_TOTALS;
  const totalPages = eventsPage ? Math.max(eventsPage.total_pages, 1) : 1;
  const eventsMeta = eventsPage
    ? t("dashboard-events-meta", {
        page: eventsPage.page,
        total: totalPages,
        events: eventsPage.total,
      })
    : t("dashboard-events-none");

  return `
    <section id="token-usage" class="mb-6">
      <div class="mb-3 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h2 class="section__title" style="margin-bottom: 0;"><i data-lucide="database" aria-hidden="true"></i>${escapeHtml(t("dashboard-token-usage-title"))}</h2>
        </div>
        <div class="flex flex-wrap items-center gap-2 text-xs" style="color: var(--text-muted);">
          ${
            state.isTokenUsageLoading
              ? `<span>${escapeHtml(t("dashboard-refreshing-summary"))}</span>`
              : ""
          }
          ${
            state.isEventsLoading
              ? `<span>${escapeHtml(t("dashboard-refreshing-details"))}</span>`
              : ""
          }
        </div>
      </div>

      ${
        state.tokenUsageSummaryError
          ? renderError(
              state.tokenUsageSummaryError,
              t("dashboard-error-summary"),
            )
          : ""
      }

      <div class="totals ${state.isTokenUsageLoading ? "opacity-60" : ""}">
        <div class="totals__head">
          <div>
            <div class="totals__hero-value">${formatNumber(totals.total_tokens)}</div>
            <div class="totals__label">${escapeHtml(t("dashboard-col-total"))}</div>
          </div>
        </div>
        <dl class="totals__parts">
          ${renderTotalsPart(t("dashboard-col-input"), formatNumber(totals.input_tokens))}
          ${renderTotalsPart(t("dashboard-col-output"), formatNumber(totals.output_tokens))}
          ${renderTotalsPart(t("dashboard-col-cache-read"), formatNumber(totals.cache_read_input_tokens))}
          ${renderTotalsPart(t("dashboard-col-cache-write"), formatNumber(totals.cache_creation_input_tokens))}
          ${renderTotalsPart(t("dashboard-col-requests"), formatNumber(totals.request_count))}
          ${renderTotalsPart(t("dashboard-col-cost"), escapeHtml(formatCostAiu(totals.total_nano_aiu)))}
        </dl>
      </div>

      <div class="mt-4 border" style="background-color: var(--surface-card); border-color: var(--border-subtle);">
        <div class="px-4 py-3 border-b flex items-center justify-between gap-3" style="background-color: var(--surface-card); border-color: var(--border-subtle);">
          <div>
            <p class="text-sm font-semibold" style="color: var(--text-strong);">${escapeHtml(t("dashboard-by-model-title"))}</p>
            <p class="mt-1 text-xs" style="color: var(--text-muted);">${
              summary
                ? escapeHtml(t("dashboard-by-model-count", { n: summary.byModel.length }))
                : escapeHtml(t("dashboard-by-model-none"))
            }</p>
          </div>
        </div>
        ${renderTokenUsageModelBreakdown(summary)}
      </div>

      <div class="mt-4 border" style="background-color: var(--surface-card); border-color: var(--border-subtle);">
        <div class="px-4 py-3 border-b flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between" style="background-color: var(--surface-card); border-color: var(--border-subtle);">
          <div>
            <p class="text-sm font-semibold" style="color: var(--text-strong);">${escapeHtml(t("dashboard-event-details-title"))}</p>
            <p class="mt-1 text-xs" style="color: var(--text-muted);">${escapeHtml(eventsMeta)}</p>
          </div>
          <div class="flex items-center gap-2">
            ${renderPaginationButton("previous", t("dashboard-pager-previous"), !eventsPage || state.isEventsLoading || eventsPage.page <= 1)}
            ${renderPaginationButton("next", t("dashboard-pager-next"), !eventsPage || state.isEventsLoading || eventsPage.page >= totalPages)}
          </div>
        </div>
        ${
          state.tokenUsageEventsError
            ? `<div class="p-4">${renderError(state.tokenUsageEventsError, t("dashboard-error-details"))}</div>`
            : ""
        }
        ${renderTokenUsageEventsTable(eventsPage)}
      </div>
    </section>
  `;
}

/** One figure in the totals row: value over a muted label. The value is
 *  already formatted/escaped by the caller. */
function renderTotalsPart(label: string, value: string): string {
  return `
          <div>
            <dt class="totals__label">${escapeHtml(label)}</dt>
            <dd>${value}</dd>
          </div>`;
}

function renderTokenUsageModelBreakdown(
  summary: TokenUsageSummary | null,
): string {
  if (!summary || summary.byModel.length === 0) {
    return renderEmptyState(t("dashboard-empty-summary"));
  }

  const rows = summary.byModel
    .map((model) => {
      return `
        <tr class="border-b last:border-b-0" style="border-color: var(--surface-control);">
          <td class="px-4 py-2 max-w-[280px] truncate" style="color: var(--text-strong);" title="${escapeHtml(model.model)}">${escapeHtml(model.model)}</td>
          <td class="px-4 py-2 text-right" style="color: var(--text-muted);">${formatNumber(model.request_count)}</td>
          <td class="px-4 py-2 text-right" style="color: var(--text-muted);">${formatNumber(model.input_tokens)}</td>
          <td class="px-4 py-2 text-right" style="color: var(--text-muted);">${formatNumber(model.output_tokens)}</td>
          <td class="px-4 py-2 text-right" style="color: var(--text-muted);">${formatNumber(model.cache_read_input_tokens)}</td>
          <td class="px-4 py-2 text-right" style="color: var(--text-muted);">${formatNumber(model.cache_creation_input_tokens)}</td>
          <td class="px-4 py-2 text-right font-semibold" style="color: var(--text-strong);">${formatNumber(model.total_tokens)}</td>
          <td class="px-4 py-2 text-right" style="color: var(--text-base-color);">${escapeHtml(formatCostAiu(model.total_nano_aiu))}</td>
        </tr>
      `;
    })
    .join("");

  return `
    <div class="overflow-auto ${state.isTokenUsageLoading ? "opacity-60" : ""}">
      <table class="w-full min-w-[860px] text-left text-xs sm:text-sm">
        <thead style="background-color: var(--surface-control); color: var(--text-base-color);">
          <tr>
            <th class="px-4 py-2 font-semibold">${escapeHtml(t("dashboard-col-model"))}</th>
            <th class="px-4 py-2 text-right font-semibold">${escapeHtml(t("dashboard-col-requests"))}</th>
            <th class="px-4 py-2 text-right font-semibold">${escapeHtml(t("dashboard-col-input"))}</th>
            <th class="px-4 py-2 text-right font-semibold">${escapeHtml(t("dashboard-col-output"))}</th>
            <th class="px-4 py-2 text-right font-semibold">${escapeHtml(t("dashboard-col-cache-read"))}</th>
            <th class="px-4 py-2 text-right font-semibold">${escapeHtml(t("dashboard-col-cache-write"))}</th>
            <th class="px-4 py-2 text-right font-semibold">${escapeHtml(t("dashboard-col-total"))}</th>
            <th class="px-4 py-2 text-right font-semibold">${escapeHtml(t("dashboard-col-cost"))}</th>
          </tr>
        </thead>
        <tbody>
          ${rows}
        </tbody>
      </table>
    </div>
  `;
}

function renderTokenUsageEventsTable(
  eventsPage: TokenUsageEventsPage | null,
): string {
  if (!eventsPage || eventsPage.items.length === 0) {
    return renderEmptyState(t("dashboard-empty-events"));
  }

  const rows = eventsPage.items
    .map((event) => {
      const userId = formatCellText(event.user_id);
      const sessionId = formatCellText(event.session_id);
      const traceId = formatCellText(event.trace_id);

      return `
        <tr class="border-b last:border-b-0" style="border-color: var(--surface-control);">
          <td class="px-4 py-2 whitespace-nowrap" style="color: var(--text-muted);" title="${escapeHtml(event.created_at_utc)}">${escapeHtml(formatDateTime(event.created_at_ms))}</td>
          <td class="px-4 py-2 max-w-[160px] truncate" style="color: var(--text-strong);" title="${escapeHtml(userId)}">${escapeHtml(userId)}</td>
          <td class="px-4 py-2 whitespace-nowrap" style="color: var(--text-muted);">${escapeHtml(event.endpoint.replace(/_/g, " "))}</td>
          <td class="px-4 py-2 max-w-[220px] truncate" style="color: var(--text-strong);" title="${escapeHtml(event.model)}">${escapeHtml(event.model)}</td>
          <td class="px-4 py-2 max-w-[180px] truncate font-mono" style="color: var(--text-muted);" title="${escapeHtml(sessionId)}">${escapeHtml(sessionId)}</td>
          <td class="px-4 py-2 max-w-[200px] truncate font-mono" style="color: var(--text-muted);" title="${escapeHtml(traceId)}">${escapeHtml(traceId)}</td>
          <td class="px-4 py-2 text-right" style="color: var(--text-muted);">${formatNumber(event.input_tokens)}</td>
          <td class="px-4 py-2 text-right" style="color: var(--text-muted);">${formatNumber(event.output_tokens)}</td>
          <td class="px-4 py-2 text-right" style="color: var(--text-muted);">${formatNumber(event.cache_read_input_tokens)}</td>
          <td class="px-4 py-2 text-right" style="color: var(--text-muted);">${formatNumber(event.cache_creation_input_tokens)}</td>
          <td class="px-4 py-2 text-right font-semibold" style="color: var(--text-strong);">${formatNumber(event.total_tokens)}</td>
        </tr>
      `;
    })
    .join("");

  return `
    <div class="overflow-auto ${state.isEventsLoading ? "opacity-60" : ""}">
      <table class="w-full min-w-[1180px] text-left text-xs sm:text-sm">
        <thead style="background-color: var(--surface-control); color: var(--text-base-color);">
          <tr>
            <th class="px-4 py-2 font-semibold">${escapeHtml(t("dashboard-col-time"))}</th>
            <th class="px-4 py-2 font-semibold">${escapeHtml(t("dashboard-col-user"))}</th>
            <th class="px-4 py-2 font-semibold">${escapeHtml(t("dashboard-col-endpoint"))}</th>
            <th class="px-4 py-2 font-semibold">${escapeHtml(t("dashboard-col-model"))}</th>
            <th class="px-4 py-2 font-semibold">${escapeHtml(t("dashboard-col-session"))}</th>
            <th class="px-4 py-2 font-semibold">${escapeHtml(t("dashboard-col-trace"))}</th>
            <th class="px-4 py-2 text-right font-semibold">${escapeHtml(t("dashboard-col-input"))}</th>
            <th class="px-4 py-2 text-right font-semibold">${escapeHtml(t("dashboard-col-output"))}</th>
            <th class="px-4 py-2 text-right font-semibold">${escapeHtml(t("dashboard-col-cache-read"))}</th>
            <th class="px-4 py-2 text-right font-semibold">${escapeHtml(t("dashboard-col-cache-write"))}</th>
            <th class="px-4 py-2 text-right font-semibold">${escapeHtml(t("dashboard-col-total"))}</th>
          </tr>
        </thead>
        <tbody>
          ${rows}
        </tbody>
      </table>
    </div>
  `;
}

function renderPaginationButton(
  action: "previous" | "next",
  label: string,
  disabled: boolean,
): string {
  return `
    <button
      type="button"
      data-page-action="${action}"
      class="px-3 py-1.5 border text-xs font-medium"
      style="background-color: var(--surface-base); border-color: var(--border-subtle); color: var(--text-base-color);"
      ${disabled ? "disabled" : ""}
    >
      ${escapeHtml(label)}
    </button>
  `;
}

function renderEmptyState(message: string): string {
  return `
    <div class="px-4 py-6 text-sm" style="color: var(--text-muted);">
      ${escapeHtml(message)}
    </div>
  `;
}

/**
 * Renders an error message box.
 */
function renderError(
  message: string,
  title = t("dashboard-error-generic"),
): string {
  return `
    <div
      class="p-3 border"
      style="background-color: color-mix(in srgb, var(--status-error) 15%, transparent); border-color: var(--status-error); color: var(--status-error);"
      role="alert"
    >
      <div class="flex items-start">
        <i data-lucide="alert-triangle" class="h-5 w-5 mr-3 mt-0.5"></i>
        <div>
          <p class="font-bold text-sm">${escapeHtml(title)}</p>
          <p class="text-xs">${escapeHtml(message)}</p>
        </div>
      </div>
    </div>
  `;
}

/**
 * Renders a welcome message when the page first loads.
 */
function renderWelcomeMessage(): string {
  return `
    <div class="text-center py-16 px-4 border" style="background-color: var(--surface-card); border-color: var(--border-subtle);">
        <i data-lucide="info" class="mx-auto h-10 w-10" style="color: var(--text-muted);"></i>
        <h3 class="mt-2 text-lg font-semibold" style="color: var(--text-strong);">${escapeHtml(t("dashboard-welcome-title"))}</h3>
        <p class="mt-1 text-sm" style="color: var(--text-muted);">${escapeHtml(t("dashboard-welcome-body"))}</p>
    </div>
  `;
}

// --- Data Fetching ---

/**
 * Fetches usage data (remote GitHub API) and token usage data (local SQLite)
 * independently so the Dashboard renders immediately without waiting on GitHub.
 */
async function fetchData(page = 1): Promise<void> {
  state.isLoading = true;
  state.error = null;
  render();

  const usagePromise = fetchJson<UsageData>(USAGE_PATH)
    .then((usage) => {
      state.data = usage;
      state.usageFetchedAt = Date.now();
      state.error = null;
    })
    .catch((error: unknown) => {
      state.data = null;
      state.error = getErrorMessage(error);
    })
    .finally(() => {
      state.isLoading = false;
      render();
    });

  const tokenUsagePromise = fetchTokenUsageSummaryAndEvents(page);
  await Promise.allSettled([usagePromise, tokenUsagePromise]);
}

/**
 * Re-read just /usage (live from GitHub), quietly, at most once a minute.
 * Used when the quota period has ended under an open window, and when the
 * window comes back into view with a stale snapshot.
 */
async function refreshUsage(): Promise<void> {
  if (Date.now() - state.usageRefetchAt < 60_000) return;
  state.usageRefetchAt = Date.now();
  try {
    state.data = await fetchJson<UsageData>(USAGE_PATH);
    state.usageFetchedAt = Date.now();
    render();
  } catch {
    // Keep what's shown; the next trigger tries again.
  }
}

/** True when the quota numbers on screen belong to a period that's over. */
function quotaPeriodEnded(): boolean {
  const resetMs = parseResetDate(state.data?.quota_reset_date);
  return resetMs !== null && Date.now() >= resetMs;
}

/**
 * `quiet` is for background updates: keep what's on screen (no blanking, no
 * loading state) and just swap in the new numbers when they arrive. Polls
 * can run every 500 ms, so anything else would flicker.
 */
async function fetchTokenUsageSummaryAndEvents(
  page = 1,
  { quiet = false }: { quiet?: boolean } = {},
): Promise<void> {
  const period = getSelectedPeriod();
  if (!quiet) {
    state.isTokenUsageLoading = true;
    state.tokenUsageSummary = null;
    state.tokenUsageEventsPage = null;
    state.tokenUsageSummaryError = null;
    state.tokenUsageEventsError = null;
    render();
  }

  try {
    const [summaryResult, eventsResult] = await Promise.allSettled([
      fetchJson<TokenUsageSummary>(buildTokenUsageSummaryUrl(period)),
      fetchJson<TokenUsageEventsPage>(buildTokenUsageEventsUrl(period, page)),
    ]);

    if (summaryResult.status === "fulfilled") {
      state.tokenUsageSummary = summaryResult.value;
      state.tokenUsageSummaryError = null;
    } else if (isMissingTokenUsageEndpointError(summaryResult.reason)) {
      state.tokenUsageSummary = null;
      state.tokenUsageSummaryError = null;
    } else {
      if (!quiet) state.tokenUsageSummary = null;
      state.tokenUsageSummaryError = getErrorMessage(summaryResult.reason);
    }

    if (eventsResult.status === "fulfilled") {
      state.tokenUsageEventsPage = eventsResult.value;
      state.tokenUsageEventsError = null;
    } else if (isMissingTokenUsageEndpointError(eventsResult.reason)) {
      state.tokenUsageEventsPage = null;
      state.tokenUsageEventsError = null;
    } else {
      if (!quiet) state.tokenUsageEventsPage = null;
      state.tokenUsageEventsError = getErrorMessage(eventsResult.reason);
    }
  } catch (error) {
    console.error("Token usage fetch error:", error);
    state.tokenUsageSummary = null;
    state.tokenUsageEventsPage = null;
    state.tokenUsageSummaryError = getErrorMessage(error);
    state.tokenUsageEventsError = getErrorMessage(error);
  } finally {
    state.isTokenUsageLoading = false;
    render();
  }
}

async function fetchTokenUsageEventsPage(page: number): Promise<void> {
  state.isEventsLoading = true;
  state.tokenUsageEventsError = null;
  render();

  try {
    state.tokenUsageEventsPage = await fetchJson<TokenUsageEventsPage>(
      buildTokenUsageEventsUrl(getSelectedPeriod(), page),
    );
  } catch (error) {
    if (isMissingTokenUsageEndpointError(error)) {
      state.tokenUsageEventsPage = null;
      state.tokenUsageEventsError = null;
    } else {
      console.error("Token usage events fetch error:", error);
      state.tokenUsageEventsError = getErrorMessage(error);
    }
  } finally {
    state.isEventsLoading = false;
    render();
  }
}

// --- Event Handlers & Initialization ---

function handlePeriodChange(): void {
  syncUrlState();
  if (runningInTauri) {
    // The Rust loop is bound to the previous period; dropping the
    // channel here closes it on its next send, and we open a fresh
    // one with the new period. We still hit the summary/events
    // endpoints once for an immediate refresh — the Channel will
    // overwrite the summary on its next tick.
    subscribeTokenUsage(state.tokenUsagePeriod);
  }
  void fetchTokenUsageSummaryAndEvents(1);
}

function handlePeriodButtonClick(event: Event): void {
  const button = event.currentTarget as HTMLButtonElement;
  const period = normalizePeriod(button.getAttribute("data-period"));
  if (period === state.tokenUsagePeriod) {
    return;
  }
  setSelectedPeriod(period);
  handlePeriodChange();
}

function handlePeriodButtonKeydown(event: KeyboardEvent): void {
  if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") {
    return;
  }
  event.preventDefault();
  const currentIndex = tokenUsagePeriodButtons.indexOf(
    event.currentTarget as HTMLButtonElement,
  );
  if (currentIndex < 0) {
    return;
  }
  const delta = event.key === "ArrowRight" ? 1 : -1;
  const nextIndex =
    (currentIndex + delta + tokenUsagePeriodButtons.length) %
    tokenUsagePeriodButtons.length;
  const nextButton = tokenUsagePeriodButtons[nextIndex];
  if (!nextButton) return;
  const period = normalizePeriod(nextButton.getAttribute("data-period"));
  setSelectedPeriod(period);
  nextButton.focus();
  handlePeriodChange();
}

function handleContentAreaClick(event: Event): void {
  if (!(event.target instanceof Element)) {
    return;
  }

  const actionButton = event.target.closest("[data-page-action]");
  if (!actionButton || !state.tokenUsageEventsPage || state.isEventsLoading) {
    return;
  }

  const action = actionButton.getAttribute("data-page-action");
  if (action === "previous" && state.tokenUsageEventsPage.page > 1) {
    void fetchTokenUsageEventsPage(state.tokenUsageEventsPage.page - 1);
  }

  if (
    action === "next" &&
    state.tokenUsageEventsPage.page < state.tokenUsageEventsPage.total_pages
  ) {
    void fetchTokenUsageEventsPage(state.tokenUsageEventsPage.page + 1);
  }
}

/**
 * Initializes the application.
 */
function init(): void {
  // Fill catalog-backed labels (period buttons, "Period", the picker label)
  // before first paint, and wire the shared locale picker. On a locale change
  // the picker re-runs applyI18n(document) then calls our render() so the
  // JS-composed content-area strings update live too. The maximal.locale
  // override is shared with Settings (same :4141 origin), so a switch here or
  // there is reflected on the other surface's next load.
  applyI18n();
  wireLocalePicker(render);

  // Detect Tauri lazily — `window.__TAURI__` isn't guaranteed to be
  // injected by the time this script's top-level code parses. By the
  // time init() runs it's reliably there if we're inside a Tauri webview.
  const tauriGlobal = window as unknown as TauriGlobal;
  tauriCore = (tauriGlobal.__TAURI__ && tauriGlobal.__TAURI__.core) || null;
  runningInTauri = Boolean(tauriCore && tauriCore.Channel);

  for (const button of tokenUsagePeriodButtons) {
    button.addEventListener("click", handlePeriodButtonClick);
    button.addEventListener("keydown", handlePeriodButtonKeydown);
  }
  contentArea.addEventListener("click", handleContentAreaClick);
  // `toggle` doesn't bubble; capture it on the stable container so it
  // survives render() replacing the details.
  contentArea.addEventListener("toggle", handleQuotaMoreToggle, true);

  const urlParams = new URLSearchParams(window.location.search);
  if (urlParams.get("embedded") === "1") {
    document.documentElement.setAttribute("data-embedded", "true");
    window.addEventListener("keydown", (ev: KeyboardEvent) => {
      if (!(ev.metaKey || ev.ctrlKey) || ev.altKey || ev.shiftKey) return;
      if (ev.key === "," || ev.key.toLowerCase() === "d") {
        ev.preventDefault();
        window.parent.postMessage(
          { type: "maximal:shortcut", key: ev.key },
          window.location.origin,
        );
      }
    });
  }
  const periodFromUrl = normalizePeriod(urlParams.get("period"));
  setSelectedPeriod(periodFromUrl);

  window.addEventListener("message", (event: MessageEvent) => {
    if (event.origin !== window.location.origin) return;
    const msg = event.data as { type?: string; period?: string } | null;
    if (!msg || typeof msg !== "object") return;
    if (msg.type === "maximal:set-period") {
      const nextPeriod = normalizePeriod(msg.period ?? null);
      if (nextPeriod !== state.tokenUsagePeriod) {
        setSelectedPeriod(nextPeriod);
        handlePeriodChange();
      }
    } else if (msg.type === "maximal:set-locale") {
      applyI18n();
      render();
    }
  });

  // First paint: pull /usage quotas + initial token-usage page so the
  // page isn't blank for a few seconds while the live feed warms up.
  void fetchData();

  // Live sessions poll their own endpoint in both modes (the Tauri channel
  // carries only the summary).
  startLiveSessions(contentArea);

  if (runningInTauri) {
    // Tauri mode: the Rust shell drives the token-usage feed via
    // Channel<TokenUsageEvent>. Drop the channel on unload so Rust's
    // loop exits cleanly on its next send.
    subscribeTokenUsage(periodFromUrl);
    window.addEventListener("beforeunload", unsubscribeTokenUsage);
  } else {
    // Plain-browser mode: no Channel available. Poll the same endpoint
    // ourselves at the same pace the Rust shell uses (pollIntervalMs), so
    // users see equivalent freshness either way. Quiet, and on the page
    // they're looking at, so updates don't blank the view or reset paging.
    const pollBrowser = (): void => {
      const wait =
        state.tokenUsageSummaryError ?
          BROWSER_RETRY_INTERVAL_MS
        : pollIntervalMs(state.tokenUsageSummary?.totals?.total_tokens);
      browserPollTimer = window.setTimeout(async () => {
        await fetchTokenUsageSummaryAndEvents(state.tokenUsageEventsPage?.page ?? 1, {
          quiet: true,
        });
        pollBrowser();
      }, wait);
    };
    pollBrowser();
    window.addEventListener("beforeunload", () => {
      if (browserPollTimer !== null) {
        window.clearTimeout(browserPollTimer);
        browserPollTimer = null;
      }
    });
  }
}

// /usage is only fetched on load and period changes, so a window left open
// drifts; re-read it when the window comes back into view and it's >10 min old.
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState !== "visible") return;
  // Coming back into view: move the range label to the current hour if the
  // clock has rolled over while it was hidden.
  syncRangeBaseline(true);
  updateControls();
  const age = state.usageFetchedAt === null ? Infinity : Date.now() - state.usageFetchedAt;
  if (age > 10 * 60_000 || quotaPeriodEnded()) void refreshUsage();
});

// The bundle is loaded as a deferred module, so the DOM is parsed by the time
// this runs. Start the app.
init();
