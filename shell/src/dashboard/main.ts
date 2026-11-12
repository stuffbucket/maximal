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
import { fetchJson, isFetchJsonError } from "./fetch-json";
import { startLiveSessions } from "./live/controller";
import {
  escapeHtml,
  parseResetDate,
  renderRemoteUsage,
  type UsageData,
} from "./usage-quotas";
import {
  createTrafficWatch,
  createUsageRefresher,
  shownSnapshot,
} from "./usage-refresh";

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
const usagePrerequisite = document.getElementById(
  "usage-prerequisite",
) as HTMLElement;
const liveMetrics = document.getElementById("live-metrics") as HTMLElement;
const quotaMetrics = document.getElementById("quota-metrics") as HTMLElement;
const quotaColumn = document.getElementById("usage-quotas") as HTMLElement;
const restArea = document.getElementById("dashboard-rest") as HTMLElement;
const observabilityViews = Array.from(
  document.querySelectorAll<HTMLElement>("[data-observability-view]"),
);
type ObservabilitySurface = "settings" | "dashboard" | "sessions";

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
  isTokenUsageLoading: boolean;
  isEventsLoading: boolean;
  tokenUsageSummary: TokenUsageSummary | null;
  tokenUsageEventsPage: TokenUsageEventsPage | null;
  tokenUsageSummaryError: string | null;
  tokenUsageEventsError: string | null;
  tokenUsagePeriod: Period;
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
  isTokenUsageLoading: false,
  isEventsLoading: false,
  tokenUsageSummary: null,
  tokenUsageEventsPage: null,
  tokenUsageSummaryError: null,
  tokenUsageEventsError: null,
  tokenUsagePeriod: DEFAULT_TOKEN_USAGE_PERIOD,
  quotaMoreOpen: readQuotaMoreOpen(),
};

function isNotAuthenticated(error: unknown): boolean {
  return (
    isFetchJsonError(error) &&
    error.status === 401 &&
    error.code === "not_authenticated"
  );
}

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
let restartBrowserPolling: (() => void) | null = null;
const initialQuery = new URLSearchParams(location.search);
let observabilitySurface: ObservabilitySurface =
  initialQuery.get("embedded") === "1"
    ? "settings"
    : initialQuery.get("surface") === "sessions"
      ? "sessions"
      : "dashboard";
const dashboardIsActive = (): boolean =>
  observabilitySurface === "dashboard" &&
  document.visibilityState === "visible";

// GitHub's quotas (/usage). Every reason to re-read them (the Dashboard shown,
// the window back in view, new traffic, the retry timer, a quota period
// ending) goes through `usageRefresher.request`; see usage-refresh.ts for when
// each one fetches.
const usageRefresher = createUsageRefresher<UsageData>({
  fetchUsage: () => fetchJson<UsageData>(USAGE_PATH),
  isSignedOut: isNotAuthenticated,
  describeError: getErrorMessage,
  isActive: dashboardIsActive,
  periodEnded: (data) => {
    const resetMs = parseResetDate(data.quota_reset_date);
    return resetMs !== null && Date.now() >= resetMs;
  },
  onChange: render,
});
// New requests in the live token feed show the network is up again.
const sawNewTraffic = createTrafficWatch();

function showObservabilitySurface(surface: ObservabilitySurface): void {
  observabilitySurface = surface;
  for (const view of observabilityViews) {
    view.hidden = view.dataset.observabilityView !== surface;
  }
  const standalone = document.documentElement.dataset.embedded !== "true";
  const toolbar = document.querySelector<HTMLElement>(".dashboard-toolbar");
  if (toolbar && standalone) toolbar.hidden = false;
  if (standalone) {
    tokenUsagePeriodGroup.hidden = surface === "sessions";
    const range = document.getElementById("token-usage-range");
    if (range) range.hidden = surface === "sessions";
  }
  document.title =
    surface === "sessions"
      ? t("dashboard-sessions-title")
      : t("dashboard-title");
}
/** After a failed fetch, wait this long instead (don't hammer the sidecar). */
const BROWSER_RETRY_INTERVAL_MS = 5000;

/** Data-update interval: 500 ms per digit of the total tokens used (0–9 →
 *  500 ms, 10–99 → 1 s, … 100K–999,999 → 3 s), and a flat 10 s from a
 *  million on. The point is only to show tokens are coming in, not to hammer
 *  the sidecar. Same rule as `dashboard_poll_interval` in
 *  shell/src-tauri/src/lib.rs. */
function pollIntervalMs(totalTokens: number | undefined): number {
  const total = Math.max(
    0,
    Math.trunc(Number.isFinite(totalTokens) ? Number(totalTokens) : 0),
  );
  if (total >= 1_000_000) return 10_000;
  return 500 * String(total).length;
}

function applyTokenUsagePayload(payload: TokenUsageSummary | undefined): void {
  state.tokenUsageSummary = payload ?? null;
  state.tokenUsageSummaryError = null;
  state.isTokenUsageLoading = false;
  render();
  noteTokenUsage(state.tokenUsageSummary);
}

/** A token-usage snapshot arrived: if it shows new requests, the upstream is
 *  reachable, so quotas that aren't ready (or are old) are worth re-reading. */
function noteTokenUsage(summary: TokenUsageSummary | null): void {
  if (sawNewTraffic(state.tokenUsagePeriod, summary?.totals?.request_count)) {
    void usageRefresher.request("traffic");
  }
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
  const periodDisabled = state.isTokenUsageLoading;
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
      state.tokenUsageSummary?.range ||
      state.tokenUsageEventsPage?.range ||
      null;
    rangeEl.title = renderTokenUsageRangeText(state.tokenUsagePeriod, range);
  }

  // The language globe's hover names the current language.
  const localeSelect = document.getElementById(
    "locale-select",
  ) as HTMLSelectElement | null;
  if (localeSelect)
    localeSelect.title = localeSelect.selectedOptions[0]?.textContent ?? "";

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
function syncRangeBaseline(hourRolled: boolean): {
  period: Period;
  hourMs: number;
} {
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
    period === "day"
      ? { weekday: "short", hour: "numeric" }
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

  const usage = usageRefresher.usage;
  const quotasHtml = renderRemoteUsage(usage, {
    quotaMoreOpen: state.quotaMoreOpen,
    now: Date.now(),
  });

  const tokenUsageHtml = renderTokenUsageSection();
  const snapshot = shownSnapshot(usage);
  const detailedHtml = snapshot ? renderDetailedData(snapshot.data) : "";

  // The quota column and the rest are rebuilt; the live card beside the
  // quotas is not (it updates in place).
  const welcome = !quotasHtml && !tokenUsageHtml && !detailedHtml;
  // The live-flow slot is permanent: when there is no graphable traffic its
  // own empty state explains what will appear here.
  bento.hidden = false;
  quotaSection.hidden = false;
  const signedOut = usage.status === "signed-out";
  usagePrerequisite.hidden = !signedOut;
  usagePrerequisite.innerHTML = signedOut ? quotasHtml : "";
  liveMetrics.hidden = signedOut;
  quotaMetrics.hidden = signedOut;
  quotaColumn.innerHTML = signedOut ? "" : quotasHtml;
  restArea.innerHTML = welcome
    ? renderWelcomeMessage()
    : `${tokenUsageHtml}${detailedHtml}`;

  // Replace placeholder icons with actual Lucide icons
  createIcons();

  // Numbers from a finished quota period render as "—"; fetch the new ones.
  void usageRefresher.request("period-ended");
}

/**
 * Remembers the user's fold/unfold. `toggle` also fires when render() inserts
 * a details that already carries `open`; that matches the state, so it is
 * skipped and never rewrites storage.
 */
function handleQuotaMoreToggle(event: Event): void {
  const target = event.target;
  if (
    !(target instanceof HTMLDetailsElement) ||
    !target.hasAttribute("data-quota-more")
  ) {
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
                ? escapeHtml(
                    t("dashboard-by-model-count", {
                      n: summary.byModel.length,
                    }),
                  )
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
  await Promise.allSettled([
    usageRefresher.request("load"),
    fetchTokenUsageSummaryAndEvents(page),
  ]);
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
      noteTokenUsage(summaryResult.value);
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

  if (event.target.closest('[data-usage-action="open-account-settings"]')) {
    if (window.parent === window) {
      window.location.assign("/ui/settings/#account");
    } else {
      window.parent.postMessage(
        { type: "maximal:open-settings", section: "account" },
        window.location.origin,
      );
    }
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

function updateDashboardActivity(): void {
  usageRefresher.activityChanged();
  if (!dashboardIsActive()) {
    unsubscribeTokenUsage();
    if (browserPollTimer !== null) window.clearTimeout(browserPollTimer);
    browserPollTimer = null;
  } else if (runningInTauri) {
    if (activeTokenUsageChannel === null) {
      subscribeTokenUsage(state.tokenUsagePeriod);
    }
  } else {
    restartBrowserPolling?.();
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
  wireLocalePicker(() => {
    render();
    showObservabilitySurface(observabilitySurface);
  });

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
  showObservabilitySurface(observabilitySurface);
  const periodFromUrl = normalizePeriod(urlParams.get("period"));
  setSelectedPeriod(periodFromUrl);

  window.addEventListener("message", (event: MessageEvent) => {
    if (event.origin !== window.location.origin) return;
    const msg = event.data as {
      type?: string;
      period?: string;
      surface?: string;
      visible?: boolean;
    } | null;
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
      showObservabilitySurface(observabilitySurface);
    } else if (
      msg.type === "maximal:surface" &&
      (msg.surface === "settings" ||
        msg.surface === "dashboard" ||
        msg.surface === "sessions")
    ) {
      showObservabilitySurface(msg.surface);
      updateDashboardActivity();
      if (dashboardIsActive()) void usageRefresher.request("shown");
    } else if (
      msg.type === "maximal:dashboard-visibility" &&
      typeof msg.visible === "boolean"
    ) {
      showObservabilitySurface(msg.visible ? "dashboard" : "settings");
      updateDashboardActivity();
      if (dashboardIsActive()) void usageRefresher.request("shown");
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
    if (dashboardIsActive()) subscribeTokenUsage(periodFromUrl);
    window.addEventListener("beforeunload", unsubscribeTokenUsage);
  } else {
    // Plain-browser mode: no Channel available. Poll the same endpoint
    // ourselves at the same pace the Rust shell uses (pollIntervalMs), so
    // users see equivalent freshness either way. Quiet, and on the page
    // they're looking at, so updates don't blank the view or reset paging.
    const pollBrowser = (): void => {
      if (!dashboardIsActive() || browserPollTimer !== null) return;
      const wait = state.tokenUsageSummaryError
        ? BROWSER_RETRY_INTERVAL_MS
        : pollIntervalMs(state.tokenUsageSummary?.totals?.total_tokens);
      browserPollTimer = window.setTimeout(async () => {
        browserPollTimer = null;
        await fetchTokenUsageSummaryAndEvents(
          state.tokenUsageEventsPage?.page ?? 1,
          {
            quiet: true,
          },
        );
        pollBrowser();
      }, wait);
    };
    restartBrowserPolling = pollBrowser;
    pollBrowser();
    window.addEventListener("beforeunload", () => {
      restartBrowserPolling = null;
      if (browserPollTimer !== null) {
        window.clearTimeout(browserPollTimer);
        browserPollTimer = null;
      }
    });
  }
}

// A window left open drifts; re-read the quotas when it comes back into view
// and they aren't ready, are old, or belong to a period that has ended.
document.addEventListener("visibilitychange", () => {
  updateDashboardActivity();
  if (!dashboardIsActive()) return;
  // Coming back into view: move the range label to the current hour if the
  // clock has rolled over while it was hidden.
  syncRangeBaseline(true);
  updateControls();
  void usageRefresher.request("visible");
});

// The bundle is loaded as a deferred module, so the DOM is parsed by the time
// this runs. Start the app.
init();
