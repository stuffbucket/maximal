// Maximal — Dashboard client script (bundled TS entry).
//
// Loaded as an ES module with `defer` semantics (Bun bundles this into
// shell/dist/ui/dashboard/main.js; Tailwind + Lucide stay CLASSIC <script>
// globals loaded before it in index.html — see the `declare` blocks below).
// It shares the SAME i18n runtime + catalog as Settings: `t()` from ../i18n
// and the DOM binder from ../i18n/apply. The visible output is unchanged from
// the previous vanilla main.js — only the strings now route through the
// catalog and a locale picker is wired into the header.
import { t } from "../i18n";
import { applyI18n, wireLocalePicker } from "../i18n/apply";

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
const BROWSER_POLL_INTERVAL_MS = 5000;

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

async function fetchJson<T>(url: string): Promise<T> {
  // No client-side credentials: the proxy exempts the dashboard
  // endpoints from API-key auth when the request comes from
  // loopback. See createAuthMiddleware in src/lib/request-auth.ts.
  const response = await fetch(url);

  if (!response.ok) {
    let message = response.statusText || "Request failed";

    try {
      const contentType = response.headers.get("content-type") || "";
      if (contentType.includes("application/json")) {
        const payload = (await response.json()) as {
          error?: { message?: string };
          message?: string;
        };
        const apiMessage = payload?.error?.message || payload?.message;
        if (typeof apiMessage === "string" && apiMessage.trim()) {
          message = apiMessage.trim();
        }
      } else {
        const text = await response.text();
        if (text.trim()) {
          message = text.trim();
        }
      }
    } catch (error) {
      console.warn("Could not parse error response:", getErrorMessage(error));
    }

    const error = new Error(
      `Request failed with status ${response.status}: ${message}`,
    ) as Error & { status?: number };
    error.status = response.status;
    throw error;
  }

  return (await response.json()) as T;
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

  if (state.isLoading) {
    contentArea.innerHTML = renderSpinner();
    createIcons();
    return;
  }

  const hasContent = Boolean(
    state.error ||
      state.data ||
      state.isTokenUsageLoading ||
      state.isEventsLoading ||
      state.tokenUsageSummary ||
      state.tokenUsageEventsPage ||
      state.tokenUsageSummaryError ||
      state.tokenUsageEventsError,
  );

  if (!hasContent) {
    contentArea.innerHTML = renderWelcomeMessage();
  } else if (state.error && !state.data) {
    contentArea.innerHTML = `
      ${renderError(state.error, t("dashboard-error-usage"))}
      ${renderTokenUsageSection()}
    `;
  } else if (state.data) {
    contentArea.innerHTML = `
      ${renderUsageQuotas(state.data.quota_snapshots)}
      ${renderTokenUsageSection()}
      ${renderDetailedData(state.data)}
    `;
  } else {
    contentArea.innerHTML = renderTokenUsageSection();
  }

  // Replace placeholder icons with actual Lucide icons
  createIcons();
}

/**
 * Renders the "Usage Quotas" section with progress bars.
 */
function renderUsageQuotas(
  snapshots: Record<string, QuotaDetails> | null | undefined,
): string {
  if (!snapshots) return "";

  const quotaCards = Object.entries(snapshots)
    .map(([key, value]) => renderQuotaCard(key, value))
    .join("");

  return `
            <section id="usage-quotas" class="mb-6">
                <h2 class="text-xl font-bold mb-3 flex items-center gap-2" style="color: var(--color-fg-lightest);">
                    <i data-lucide="bar-chart-big"></i> ${escapeHtml(t("dashboard-quotas-title"))}
                </h2>
                <div class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                    ${quotaCards}
                </div>
            </section>
        `;
}

/**
 * Renders a single quota card.
 */
function renderQuotaCard(title: string, details: QuotaDetails): string {
  const { entitlement, remaining, percent_remaining, unlimited } = details;

  const percentUsed = unlimited ? 0 : 100 - percent_remaining;
  const used = unlimited
    ? t("dashboard-not-available")
    : (entitlement - remaining).toLocaleString();

  let progressBarColor = "var(--color-green)";
  if (percentUsed > 75) progressBarColor = "var(--color-yellow)";
  if (percentUsed > 90) progressBarColor = "var(--color-red)";
  if (unlimited) progressBarColor = "var(--color-blue)";

  return `
            <div class="p-4 border" style="background-color: var(--color-bg); border-color: var(--color-bg-light-2);">
                <div class="flex justify-between items-center mb-2">
                    <h3 class="text-md font-semibold capitalize" style="color: var(--color-fg-lightest);">${escapeHtml(title.replace(/_/g, " "))}</h3>
                    ${
                      unlimited
                        ? `<span class="px-2 py-0.5 text-xs font-medium" style="color: var(--color-blue-accent); background-color: var(--color-bg-light-1);">${escapeHtml(t("dashboard-quota-unlimited"))}</span>`
                        : `<span class="text-sm font-mono" style="color: var(--color-fg-medium);">${escapeHtml(t("dashboard-quota-percent-used", { percent: percentUsed.toFixed(1) }))}</span>`
                    }
                </div>
                <div class="mb-3">
                     <div class="w-full progress-bar-bg h-2">
                         <div class="progress-bar-fg h-2" style="width: ${unlimited ? 100 : percentUsed}%; background-color: ${progressBarColor};"></div>
                     </div>
                </div>
                <div class="flex justify-between text-xs font-mono" style="color: var(--color-fg-dark);">
                    <span>${used} / ${unlimited ? "∞" : entitlement.toLocaleString()}</span>
                    <span>${escapeHtml(t("dashboard-quota-remaining", { n: unlimited ? "∞" : remaining.toLocaleString() }))}</span>
                </div>
            </div>
        `;
}

/**
 * Recursively builds a formatted HTML list from a JSON object.
 */
function formatObject(obj: unknown): string {
  if (obj === null || typeof obj !== "object") {
    return `<span style="color: var(--color-green-accent);">${escapeHtml(JSON.stringify(obj))}</span>`;
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
              ? `<span style='color: var(--color-gray-accent)'>[...${value.length} items]</span>`
              : `<span style='color: var(--color-gray-accent)'>[]</span>`;
        } else if (typeof value === "object" && value !== null) {
          displayValue = formatObject(value);
        } else if (typeof value === "boolean") {
          displayValue = `<span class="font-semibold" style="color: ${value ? "var(--color-green-accent)" : "var(--color-red-accent)"}">${escapeHtml(String(value))}</span>`;
        } else {
          displayValue = `<span style="color: var(--color-blue-accent);">${escapeHtml(JSON.stringify(value))}</span>`;
        }

        return `<div class="mt-1">
                        <span class="capitalize font-semibold" style="color: var(--color-fg-medium);">${formattedKey}:</span>
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
                <h2 class="text-xl font-bold mb-3 flex items-center gap-2" style="color: var(--color-fg-lightest);">
                   <i data-lucide="file-text"></i> ${escapeHtml(t("dashboard-api-response-title"))}
                </h2>
                <div class="border p-4 relative font-mono text-xs code-block overflow-auto" style="background-color: var(--color-bg-darkest); border-color: var(--color-bg-light-2);">
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
  const activeRange = summary?.range || eventsPage?.range || null;
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
          <h2 class="text-xl font-bold flex items-center gap-2" style="color: var(--color-fg-lightest);">
            <i data-lucide="database"></i> ${escapeHtml(t("dashboard-token-usage-title"))}
          </h2>
          <p class="mt-1 text-xs" style="color: var(--color-gray);">${escapeHtml(
            renderTokenUsageRangeText(state.tokenUsagePeriod, activeRange),
          )}</p>
        </div>
        <div class="flex flex-wrap items-center gap-2 text-xs" style="color: var(--color-gray-accent);">
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

      <div class="grid grid-cols-2 lg:grid-cols-3 xl:grid-cols-7 gap-3 ${
        state.isTokenUsageLoading ? "opacity-60" : ""
      }">
        ${renderTokenUsageMetric(t("dashboard-col-total"), totals.total_tokens, "var(--color-fg-lightest)")}
        ${renderTokenUsageMetric(t("dashboard-col-input"), totals.input_tokens, "var(--color-blue-accent)")}
        ${renderTokenUsageMetric(t("dashboard-col-output"), totals.output_tokens, "var(--color-green-accent)")}
        ${renderTokenUsageMetric(t("dashboard-col-cache-read"), totals.cache_read_input_tokens, "var(--color-aqua-accent)")}
        ${renderTokenUsageMetric(t("dashboard-col-cache-write"), totals.cache_creation_input_tokens, "var(--color-yellow-accent)")}
        ${renderTokenUsageMetric(t("dashboard-col-requests"), totals.request_count, "var(--color-purple-accent)")}
        ${renderTokenUsageCostMetric(t("dashboard-col-cost"), totals.total_nano_aiu, "var(--color-green)")}
      </div>

      <div class="mt-4 border" style="background-color: var(--color-bg); border-color: var(--color-bg-light-2);">
        <div class="px-4 py-3 border-b flex items-center justify-between gap-3" style="background-color: var(--color-bg-soft); border-color: var(--color-bg-light-2);">
          <div>
            <p class="text-sm font-semibold" style="color: var(--color-fg-lightest);">${escapeHtml(t("dashboard-by-model-title"))}</p>
            <p class="mt-1 text-xs" style="color: var(--color-gray-accent);">${
              summary
                ? escapeHtml(t("dashboard-by-model-count", { n: summary.byModel.length }))
                : escapeHtml(t("dashboard-by-model-none"))
            }</p>
          </div>
        </div>
        ${renderTokenUsageModelBreakdown(summary)}
      </div>

      <div class="mt-4 border" style="background-color: var(--color-bg); border-color: var(--color-bg-light-2);">
        <div class="px-4 py-3 border-b flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between" style="background-color: var(--color-bg-soft); border-color: var(--color-bg-light-2);">
          <div>
            <p class="text-sm font-semibold" style="color: var(--color-fg-lightest);">${escapeHtml(t("dashboard-event-details-title"))}</p>
            <p class="mt-1 text-xs" style="color: var(--color-gray-accent);">${escapeHtml(eventsMeta)}</p>
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

function renderTokenUsageMetric(
  label: string,
  value: number,
  accentColor: string,
): string {
  return `
    <div class="p-4 border" style="background-color: var(--color-bg); border-color: var(--color-bg-light-2);">
      <div class="text-lg font-bold" style="color: ${accentColor};">${formatNumber(value)}</div>
      <div class="mt-1 text-xs uppercase tracking-wide" style="color: var(--color-gray-accent);">${escapeHtml(label)}</div>
    </div>
  `;
}

// A cost metric renders the human AIU unit (from nano-AIU) instead of a raw
// integer, so it needs its own formatter. Same card chrome as the token
// metrics above so the grid stays visually uniform.
function renderTokenUsageCostMetric(
  label: string,
  nanoAiu: number,
  accentColor: string,
): string {
  return `
    <div class="p-4 border" style="background-color: var(--color-bg); border-color: var(--color-bg-light-2);">
      <div class="text-lg font-bold" style="color: ${accentColor};">${escapeHtml(formatCostAiu(nanoAiu))}</div>
      <div class="mt-1 text-xs uppercase tracking-wide" style="color: var(--color-gray-accent);">${escapeHtml(label)}</div>
    </div>
  `;
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
        <tr class="border-b last:border-b-0" style="border-color: var(--color-bg-light-1);">
          <td class="px-4 py-2 max-w-[280px] truncate" style="color: var(--color-fg-lightest);" title="${escapeHtml(model.model)}">${escapeHtml(model.model)}</td>
          <td class="px-4 py-2 text-right" style="color: var(--color-fg-dark);">${formatNumber(model.request_count)}</td>
          <td class="px-4 py-2 text-right" style="color: var(--color-fg-dark);">${formatNumber(model.input_tokens)}</td>
          <td class="px-4 py-2 text-right" style="color: var(--color-fg-dark);">${formatNumber(model.output_tokens)}</td>
          <td class="px-4 py-2 text-right" style="color: var(--color-fg-dark);">${formatNumber(model.cache_read_input_tokens)}</td>
          <td class="px-4 py-2 text-right" style="color: var(--color-fg-dark);">${formatNumber(model.cache_creation_input_tokens)}</td>
          <td class="px-4 py-2 text-right font-semibold" style="color: var(--color-yellow-accent);">${formatNumber(model.total_tokens)}</td>
          <td class="px-4 py-2 text-right font-semibold" style="color: var(--color-green);">${escapeHtml(formatCostAiu(model.total_nano_aiu))}</td>
        </tr>
      `;
    })
    .join("");

  return `
    <div class="overflow-auto ${state.isTokenUsageLoading ? "opacity-60" : ""}">
      <table class="w-full min-w-[860px] text-left text-xs sm:text-sm">
        <thead style="background-color: var(--color-bg-light-1); color: var(--color-fg-medium);">
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
        <tr class="border-b last:border-b-0" style="border-color: var(--color-bg-light-1);">
          <td class="px-4 py-2 whitespace-nowrap" style="color: var(--color-fg-dark);" title="${escapeHtml(event.created_at_utc)}">${escapeHtml(formatDateTime(event.created_at_ms))}</td>
          <td class="px-4 py-2 max-w-[160px] truncate" style="color: var(--color-fg-lightest);" title="${escapeHtml(userId)}">${escapeHtml(userId)}</td>
          <td class="px-4 py-2 whitespace-nowrap" style="color: var(--color-fg-dark);">${escapeHtml(event.endpoint.replace(/_/g, " "))}</td>
          <td class="px-4 py-2 max-w-[220px] truncate" style="color: var(--color-fg-lightest);" title="${escapeHtml(event.model)}">${escapeHtml(event.model)}</td>
          <td class="px-4 py-2 max-w-[180px] truncate font-mono" style="color: var(--color-fg-dark);" title="${escapeHtml(sessionId)}">${escapeHtml(sessionId)}</td>
          <td class="px-4 py-2 max-w-[200px] truncate font-mono" style="color: var(--color-fg-dark);" title="${escapeHtml(traceId)}">${escapeHtml(traceId)}</td>
          <td class="px-4 py-2 text-right" style="color: var(--color-fg-dark);">${formatNumber(event.input_tokens)}</td>
          <td class="px-4 py-2 text-right" style="color: var(--color-fg-dark);">${formatNumber(event.output_tokens)}</td>
          <td class="px-4 py-2 text-right" style="color: var(--color-fg-dark);">${formatNumber(event.cache_read_input_tokens)}</td>
          <td class="px-4 py-2 text-right" style="color: var(--color-fg-dark);">${formatNumber(event.cache_creation_input_tokens)}</td>
          <td class="px-4 py-2 text-right font-semibold" style="color: var(--color-yellow-accent);">${formatNumber(event.total_tokens)}</td>
        </tr>
      `;
    })
    .join("");

  return `
    <div class="overflow-auto ${state.isEventsLoading ? "opacity-60" : ""}">
      <table class="w-full min-w-[1180px] text-left text-xs sm:text-sm">
        <thead style="background-color: var(--color-bg-light-1); color: var(--color-fg-medium);">
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
      style="background-color: var(--color-bg-darkest); border-color: var(--color-bg-light-2); color: var(--color-fg-light);"
      ${disabled ? "disabled" : ""}
    >
      ${escapeHtml(label)}
    </button>
  `;
}

function renderEmptyState(message: string): string {
  return `
    <div class="px-4 py-6 text-sm" style="color: var(--color-gray);">
      ${escapeHtml(message)}
    </div>
  `;
}

/**
 * Renders a loading spinner.
 */
function renderSpinner(): string {
  return `
    <div class="flex justify-center items-center py-20">
        <div class="animate-spin h-12 w-12 rounded-full border-4 border-transparent border-t-4" style="border-top-color: var(--color-blue);"></div>
    </div>`;
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
      style="background-color: rgba(204, 36, 29, 0.2); border-color: var(--color-red); color: var(--color-red-accent);"
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
    <div class="text-center py-16 px-4 border" style="background-color: var(--color-bg-soft); border-color: var(--color-bg-light-2);">
        <i data-lucide="info" class="mx-auto h-10 w-10" style="color: var(--color-gray-accent);"></i>
        <h3 class="mt-2 text-lg font-semibold" style="color: var(--color-fg-lightest);">${escapeHtml(t("dashboard-welcome-title"))}</h3>
        <p class="mt-1 text-sm" style="color: var(--color-gray);">${escapeHtml(t("dashboard-welcome-body"))}</p>
    </div>
  `;
}

// --- Data Fetching ---

/**
 * Fetches usage data and token usage data from the specified API endpoint.
 */
async function fetchData(page = 1): Promise<void> {
  const period = getSelectedPeriod();
  state.isLoading = true;
  state.error = null;
  state.tokenUsageSummaryError = null;
  state.tokenUsageEventsError = null;
  render();

  try {
    const [usageResult, summaryResult, eventsResult] = await Promise.allSettled(
      [
        fetchJson<UsageData>(USAGE_PATH),
        fetchJson<TokenUsageSummary>(buildTokenUsageSummaryUrl(period)),
        fetchJson<TokenUsageEventsPage>(buildTokenUsageEventsUrl(period, page)),
      ],
    );

    if (usageResult.status === "fulfilled") {
      state.data = usageResult.value;
    } else {
      state.data = null;
      state.error = getErrorMessage(usageResult.reason);
    }

    if (summaryResult.status === "fulfilled") {
      state.tokenUsageSummary = summaryResult.value;
    } else if (isMissingTokenUsageEndpointError(summaryResult.reason)) {
      state.tokenUsageSummary = null;
      state.tokenUsageSummaryError = null;
    } else {
      state.tokenUsageSummary = null;
      state.tokenUsageSummaryError = getErrorMessage(summaryResult.reason);
    }

    if (eventsResult.status === "fulfilled") {
      state.tokenUsageEventsPage = eventsResult.value;
    } else if (isMissingTokenUsageEndpointError(eventsResult.reason)) {
      state.tokenUsageEventsPage = null;
      state.tokenUsageEventsError = null;
    } else {
      state.tokenUsageEventsPage = null;
      state.tokenUsageEventsError = getErrorMessage(eventsResult.reason);
    }
  } catch (error) {
    console.error("Fetch error:", error);
    state.data = null;
    state.tokenUsageSummary = null;
    state.tokenUsageEventsPage = null;
    state.error = getErrorMessage(error);
    state.tokenUsageSummaryError = getErrorMessage(error);
    state.tokenUsageEventsError = getErrorMessage(error);
  } finally {
    state.isLoading = false;
    render();
  }
}

async function fetchTokenUsageSummaryAndEvents(page = 1): Promise<void> {
  const period = getSelectedPeriod();
  state.isTokenUsageLoading = true;
  state.tokenUsageSummary = null;
  state.tokenUsageEventsPage = null;
  state.tokenUsageSummaryError = null;
  state.tokenUsageEventsError = null;
  render();

  try {
    const [summaryResult, eventsResult] = await Promise.allSettled([
      fetchJson<TokenUsageSummary>(buildTokenUsageSummaryUrl(period)),
      fetchJson<TokenUsageEventsPage>(buildTokenUsageEventsUrl(period, page)),
    ]);

    if (summaryResult.status === "fulfilled") {
      state.tokenUsageSummary = summaryResult.value;
    } else if (isMissingTokenUsageEndpointError(summaryResult.reason)) {
      state.tokenUsageSummary = null;
      state.tokenUsageSummaryError = null;
    } else {
      state.tokenUsageSummary = null;
      state.tokenUsageSummaryError = getErrorMessage(summaryResult.reason);
    }

    if (eventsResult.status === "fulfilled") {
      state.tokenUsageEventsPage = eventsResult.value;
    } else if (isMissingTokenUsageEndpointError(eventsResult.reason)) {
      state.tokenUsageEventsPage = null;
      state.tokenUsageEventsError = null;
    } else {
      state.tokenUsageEventsPage = null;
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

  const urlParams = new URLSearchParams(window.location.search);
  const periodFromUrl = normalizePeriod(urlParams.get("period"));
  setSelectedPeriod(periodFromUrl);

  // First paint: pull /usage quotas + initial token-usage page so the
  // page isn't blank for a few seconds while the live feed warms up.
  void fetchData();

  if (runningInTauri) {
    // Tauri mode: the Rust shell drives the token-usage feed via
    // Channel<TokenUsageEvent>. Drop the channel on unload so Rust's
    // loop exits cleanly on its next send.
    subscribeTokenUsage(periodFromUrl);
    window.addEventListener("beforeunload", unsubscribeTokenUsage);
  } else {
    // Plain-browser mode: no Channel available. Poll the same endpoint
    // ourselves every 5s. Same cadence the Rust shell uses, so users
    // see equivalent freshness either way.
    browserPollTimer = window.setInterval(() => {
      void fetchTokenUsageSummaryAndEvents(1);
    }, BROWSER_POLL_INTERVAL_MS);
    window.addEventListener("beforeunload", () => {
      if (browserPollTimer !== null) {
        window.clearInterval(browserPollTimer);
        browserPollTimer = null;
      }
    });
  }
}

// The bundle is loaded as a deferred module, so the DOM is parsed by the time
// this runs. Start the app.
init();
