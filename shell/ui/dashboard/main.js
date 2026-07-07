// Maximal — Dashboard client script.
// Loaded with `defer`, so the DOM is ready by the time this runs.

const tokenUsagePeriodGroup = document.getElementById("token-usage-period");
const tokenUsagePeriodButtons = Array.from(
  tokenUsagePeriodGroup.querySelectorAll("[data-period]")
);
const contentArea = document.getElementById("content-area");

// The dashboard always talks to the proxy that served it — same
// origin, no user-typed URL. Each fetch is a relative path; the
// browser resolves it against window.location automatically.
const USAGE_PATH = "/usage";
const TOKEN_USAGE_PATH = "/token-usage";
const TOKEN_USAGE_EVENTS_PATH = "/token-usage/events";
const DEFAULT_TOKEN_USAGE_PERIOD = "day";
const DEFAULT_TOKEN_USAGE_EVENTS_PAGE_SIZE = 20;
const VALID_PERIODS = new Set(["day", "week", "month"]);
const EMPTY_TOKEN_USAGE_TOTALS = {
  cache_creation_input_tokens: 0,
  cache_read_input_tokens: 0,
  input_tokens: 0,
  output_tokens: 0,
  request_count: 0,
  total_tokens: 0,
  total_nano_aiu: 0,
};

// --- State Management ---
const state = {
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
let tauriCore = null;
let runningInTauri = false;
let activeTokenUsageChannel = null;
let browserPollTimer = null;
const BROWSER_POLL_INTERVAL_MS = 5000;

function applyTokenUsagePayload(payload) {
  state.tokenUsageSummary = payload;
  state.tokenUsageSummaryError = null;
  state.isTokenUsageLoading = false;
  render();
}

function applyTokenUsageError(message) {
  // Don't clobber a previously good summary — the user keeps seeing
  // the last known state plus a small error chip.
  state.tokenUsageSummaryError = message;
  render();
}

function subscribeTokenUsage(period) {
  if (!runningInTauri) return;
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
        (message.data && message.data.message) || "Unknown error",
      );
    }
  };
  activeTokenUsageChannel = channel;
  state.isTokenUsageLoading = true;
  render();
  tauriCore
    .invoke("subscribe_token_usage", { period, onEvent: channel })
    .catch((error) => {
      // Rust returns Ok(()) on channel-drop, so this catch only fires
      // on a real invoke failure (e.g. command not registered).
      if (channel === activeTokenUsageChannel) {
        applyTokenUsageError(getErrorMessage(error));
      }
    });
}

function unsubscribeTokenUsage() {
  // Dropping the JS reference is the signal — Rust's `Channel::send`
  // returns Err on the next tick and the poll loop exits.
  activeTokenUsageChannel = null;
}

// --- Rendering Logic ---

/**
 * Safely calls lucide.createIcons() if the library is available.
 */
function createIcons() {
  if (typeof lucide !== "undefined") {
    lucide.createIcons();
  }
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function getErrorMessage(error) {
  if (error instanceof Error) {
    return error.message;
  }
  return typeof error === "string" ? error : "Unknown error.";
}

function isMissingTokenUsageEndpointError(error) {
  return Boolean(
    error
      && typeof error === "object"
      && "status" in error
      && error.status === 404
  );
}

function normalizePeriod(value) {
  return VALID_PERIODS.has(value)
    ? value
    : DEFAULT_TOKEN_USAGE_PERIOD;
}

function getSelectedPeriod() {
  const pressed = tokenUsagePeriodButtons.find(
    (button) => button.getAttribute("aria-pressed") === "true"
  );
  const normalized = normalizePeriod(
    pressed ? pressed.getAttribute("data-period") : null
  );
  setSelectedPeriod(normalized);
  return normalized;
}

function setSelectedPeriod(period) {
  const normalized = normalizePeriod(period);
  for (const button of tokenUsagePeriodButtons) {
    const isActive = button.getAttribute("data-period") === normalized;
    button.setAttribute("aria-pressed", isActive ? "true" : "false");
  }
  state.tokenUsagePeriod = normalized;
}

function buildTokenUsageSummaryUrl(period) {
  const url = new URL(TOKEN_USAGE_PATH, window.location.origin);
  url.searchParams.set("period", period);
  return url.toString();
}

function buildTokenUsageEventsUrl(period, page) {
  const url = new URL(
    TOKEN_USAGE_EVENTS_PATH,
    window.location.origin
  );
  url.searchParams.set("period", period);
  url.searchParams.set("page", String(page));
  url.searchParams.set(
    "page_size",
    String(DEFAULT_TOKEN_USAGE_EVENTS_PAGE_SIZE)
  );
  return url.toString();
}

async function fetchJson(url) {
  // No client-side credentials: the proxy exempts the dashboard
  // endpoints from API-key auth when the request comes from
  // loopback. See createAuthMiddleware in src/lib/request-auth.ts.
  const response = await fetch(url);

  if (!response.ok) {
    let message = response.statusText || "Request failed";

    try {
      const contentType = response.headers.get("content-type") || "";
      if (contentType.includes("application/json")) {
        const payload = await response.json();
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
      console.warn(
        "Could not parse error response:",
        getErrorMessage(error)
      );
    }

    const error = new Error(
      `Request failed with status ${response.status}: ${message}`
    );
    error.status = response.status;
    throw error;
  }

  return response.json();
}

function syncUrlState() {
  try {
    const currentUrl = new URL(window.location.href);
    currentUrl.searchParams.set("period", getSelectedPeriod());
    window.history.pushState({}, "", currentUrl);
  } catch (error) {
    console.warn("Could not update URL:", getErrorMessage(error));
  }
}

function updateControls() {
  const periodDisabled = state.isLoading || state.isTokenUsageLoading;
  for (const button of tokenUsagePeriodButtons) {
    button.disabled = periodDisabled;
  }
}

function formatNumber(value) {
  return Number.isFinite(value) ? Number(value).toLocaleString() : "0";
}

// Copilot reports per-request cost in nano-AIU (1 AIU = 1e9 nano-AIU).
// See src/lib/token-usage/store.ts (`total_nano_aiu`). We render the human
// unit (AIU). Zero/absent cost is common — many models bill nothing here —
// so we show an em dash rather than `0.000 AIU` or `NaN`, per the design
// failure-modes guidance (graceful zero/absent handling).
const NANO_AIU_PER_AIU = 1_000_000_000;

function formatCostAiu(nanoAiu) {
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

function formatDateTime(value) {
  if (!Number.isFinite(value)) {
    return "N/A";
  }
  return new Date(value).toLocaleString();
}

function formatCellText(value) {
  if (typeof value !== "string") {
    return "—";
  }

  const trimmed = value.trim();
  return trimmed || "—";
}

function renderTokenUsageRangeText(period, range) {
  const labels = {
    day: "Day window",
    week: "Week window",
    month: "Month window",
  };

  if (!range) {
    return labels[period] || labels.day;
  }

  return `${labels[period] || labels.day}: ${formatDateTime(
    range.start_ms
  )} - ${formatDateTime(range.end_ms)}`;
}

/**
 * Renders the entire UI based on the current state.
 */
function render() {
  updateControls();

  if (state.isLoading) {
    contentArea.innerHTML = renderSpinner();
    createIcons();
    return;
  }

  const hasContent = Boolean(
    state.error
      || state.data
      || state.isTokenUsageLoading
      || state.isEventsLoading
      || state.tokenUsageSummary
      || state.tokenUsageEventsPage
      || state.tokenUsageSummaryError
      || state.tokenUsageEventsError
  );

  if (!hasContent) {
    contentArea.innerHTML = renderWelcomeMessage();
  } else if (state.error && !state.data) {
    contentArea.innerHTML = `
      ${renderError(state.error, "Usage request failed")}
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
 * @param {object} snapshots - The quota_snapshots object from the API response.
 * @returns {string} HTML string for the usage quotas section.
 */
function renderUsageQuotas(snapshots) {
  if (!snapshots) return "";

  const quotaCards = Object.entries(snapshots)
    .map(([key, value]) => {
      return renderQuotaCard(key, value);
    })
    .join("");

  return `
            <section id="usage-quotas" class="mb-6">
                <h2 class="text-xl font-bold mb-3 flex items-center gap-2" style="color: var(--color-fg-lightest);">
                    <i data-lucide="bar-chart-big"></i> Usage Quotas
                </h2>
                <div class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                    ${quotaCards}
                </div>
            </section>
        `;
}

/**
 * Renders a single quota card.
 * @param {string} title - The name of the quota (e.g., 'chat').
 * @param {object} details - The details object for the quota.
 * @returns {string} HTML string for a single card.
 */
function renderQuotaCard(title, details) {
  const { entitlement, remaining, percent_remaining, unlimited } =
    details;

  const percentUsed = unlimited ? 0 : 100 - percent_remaining;
  const used = unlimited
    ? "N/A"
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
                        ? `<span class="px-2 py-0.5 text-xs font-medium" style="color: var(--color-blue-accent); background-color: var(--color-bg-light-1);">Unlimited</span>`
                        : `<span class="text-sm font-mono" style="color: var(--color-fg-medium);">${percentUsed.toFixed(1)}% Used</span>`
                    }
                </div>
                <div class="mb-3">
                     <div class="w-full progress-bar-bg h-2">
                         <div class="progress-bar-fg h-2" style="width: ${unlimited ? 100 : percentUsed}%; background-color: ${progressBarColor};"></div>
                     </div>
                </div>
                <div class="flex justify-between text-xs font-mono" style="color: var(--color-fg-dark);">
                    <span>${used} / ${unlimited ? "∞" : entitlement.toLocaleString()}</span>
                    <span>${unlimited ? "∞" : remaining.toLocaleString()} remaining</span>
                </div>
            </div>
        `;
}

/**
 * Recursively builds a formatted HTML list from a JSON object.
 * @param {object} obj - The object to format.
 * @returns {string} HTML string for the formatted list.
 */
function formatObject(obj) {
  if (obj === null || typeof obj !== "object") {
    return `<span style="color: var(--color-green-accent);">${escapeHtml(JSON.stringify(obj))}</span>`;
  }

  return (
    '<div class="pl-4">' +
    Object.entries(obj)
      .map(([key, value]) => {
        const formattedKey = escapeHtml(key.replace(/_/g, " "));
        let displayValue;

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
 * @param {object} data - The full API response data.
 * @returns {string} HTML string for the full data section.
 */
function renderDetailedData(data) {
  const formattedDetails = formatObject(data);
  return `
            <section id="detailed-data">
                <h2 class="text-xl font-bold mb-3 flex items-center gap-2" style="color: var(--color-fg-lightest);">
                   <i data-lucide="file-text"></i> Usage API Response
                </h2>
                <div class="border p-4 relative font-mono text-xs code-block overflow-auto" style="background-color: var(--color-bg-darkest); border-color: var(--color-bg-light-2);">
                    ${formattedDetails}
                </div>
            </section>
        `;
}

function renderTokenUsageSection() {
  const hasTokenUsageContent = Boolean(
    state.isTokenUsageLoading
      || state.isEventsLoading
      || state.tokenUsageSummary
      || state.tokenUsageEventsPage
      || state.tokenUsageSummaryError
      || state.tokenUsageEventsError
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
    ? `Page ${eventsPage.page} / ${totalPages} · ${formatNumber(
        eventsPage.total
      )} events`
    : "No detail page loaded yet.";

  return `
    <section id="token-usage" class="mb-6">
      <div class="mb-3 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h2 class="text-xl font-bold flex items-center gap-2" style="color: var(--color-fg-lightest);">
            <i data-lucide="database"></i> Token Usage
          </h2>
          <p class="mt-1 text-xs" style="color: var(--color-gray);">${escapeHtml(
            renderTokenUsageRangeText(state.tokenUsagePeriod, activeRange)
          )}</p>
        </div>
        <div class="flex flex-wrap items-center gap-2 text-xs" style="color: var(--color-gray-accent);">
          ${
            state.isTokenUsageLoading
              ? "<span>Refreshing summary...</span>"
              : ""
          }
          ${
            state.isEventsLoading
              ? "<span>Refreshing details...</span>"
              : ""
          }
        </div>
      </div>

      ${
        state.tokenUsageSummaryError
          ? renderError(
              state.tokenUsageSummaryError,
              "Token usage summary failed"
            )
          : ""
      }

      <div class="grid grid-cols-2 lg:grid-cols-3 xl:grid-cols-7 gap-3 ${
        state.isTokenUsageLoading ? "opacity-60" : ""
      }">
        ${renderTokenUsageMetric(
          "Total",
          totals.total_tokens,
          "var(--color-fg-lightest)"
        )}
        ${renderTokenUsageMetric(
          "Input",
          totals.input_tokens,
          "var(--color-blue-accent)"
        )}
        ${renderTokenUsageMetric(
          "Output",
          totals.output_tokens,
          "var(--color-green-accent)"
        )}
        ${renderTokenUsageMetric(
          "Cache Read",
          totals.cache_read_input_tokens,
          "var(--color-aqua-accent)"
        )}
        ${renderTokenUsageMetric(
          "Cache Write",
          totals.cache_creation_input_tokens,
          "var(--color-yellow-accent)"
        )}
        ${renderTokenUsageMetric(
          "Requests",
          totals.request_count,
          "var(--color-purple-accent)"
        )}
        ${renderTokenUsageCostMetric(
          "Cost",
          totals.total_nano_aiu,
          "var(--color-green)"
        )}
      </div>

      <div class="mt-4 border" style="background-color: var(--color-bg); border-color: var(--color-bg-light-2);">
        <div class="px-4 py-3 border-b flex items-center justify-between gap-3" style="background-color: var(--color-bg-soft); border-color: var(--color-bg-light-2);">
          <div>
            <p class="text-sm font-semibold" style="color: var(--color-fg-lightest);">By Model</p>
            <p class="mt-1 text-xs" style="color: var(--color-gray-accent);">${summary ? `${formatNumber(summary.byModel.length)} models` : "No summary rows loaded."}</p>
          </div>
        </div>
        ${renderTokenUsageModelBreakdown(summary)}
      </div>

      <div class="mt-4 border" style="background-color: var(--color-bg); border-color: var(--color-bg-light-2);">
        <div class="px-4 py-3 border-b flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between" style="background-color: var(--color-bg-soft); border-color: var(--color-bg-light-2);">
          <div>
            <p class="text-sm font-semibold" style="color: var(--color-fg-lightest);">Event Details</p>
            <p class="mt-1 text-xs" style="color: var(--color-gray-accent);">${escapeHtml(
              eventsMeta
            )}</p>
          </div>
          <div class="flex items-center gap-2">
            ${renderPaginationButton(
              "previous",
              "Previous",
              !eventsPage || state.isEventsLoading || eventsPage.page <= 1
            )}
            ${renderPaginationButton(
              "next",
              "Next",
              !eventsPage
                || state.isEventsLoading
                || eventsPage.page >= totalPages
            )}
          </div>
        </div>
        ${
          state.tokenUsageEventsError
            ? `<div class="p-4">${renderError(
                state.tokenUsageEventsError,
                "Token usage details failed"
              )}</div>`
            : ""
        }
        ${renderTokenUsageEventsTable(eventsPage)}
      </div>
    </section>
  `;
}

function renderTokenUsageMetric(label, value, accentColor) {
  return `
    <div class="p-4 border" style="background-color: var(--color-bg); border-color: var(--color-bg-light-2);">
      <div class="text-lg font-bold" style="color: ${accentColor};">${formatNumber(
        value
      )}</div>
      <div class="mt-1 text-xs uppercase tracking-wide" style="color: var(--color-gray-accent);">${escapeHtml(
        label
      )}</div>
    </div>
  `;
}

// A cost metric renders the human AIU unit (from nano-AIU) instead of a raw
// integer, so it needs its own formatter. Same card chrome as the token
// metrics above so the grid stays visually uniform.
function renderTokenUsageCostMetric(label, nanoAiu, accentColor) {
  return `
    <div class="p-4 border" style="background-color: var(--color-bg); border-color: var(--color-bg-light-2);">
      <div class="text-lg font-bold" style="color: ${accentColor};">${escapeHtml(
        formatCostAiu(nanoAiu)
      )}</div>
      <div class="mt-1 text-xs uppercase tracking-wide" style="color: var(--color-gray-accent);">${escapeHtml(
        label
      )}</div>
    </div>
  `;
}

function renderTokenUsageModelBreakdown(summary) {
  if (!summary || summary.byModel.length === 0) {
    return renderEmptyState(
      "No token usage recorded for the selected period."
    );
  }

  const rows = summary.byModel
    .map((model) => {
      return `
        <tr class="border-b last:border-b-0" style="border-color: var(--color-bg-light-1);">
          <td class="px-4 py-2 max-w-[280px] truncate" style="color: var(--color-fg-lightest);" title="${escapeHtml(
            model.model
          )}">${escapeHtml(model.model)}</td>
          <td class="px-4 py-2 text-right" style="color: var(--color-fg-dark);">${formatNumber(
            model.request_count
          )}</td>
          <td class="px-4 py-2 text-right" style="color: var(--color-fg-dark);">${formatNumber(
            model.input_tokens
          )}</td>
          <td class="px-4 py-2 text-right" style="color: var(--color-fg-dark);">${formatNumber(
            model.output_tokens
          )}</td>
          <td class="px-4 py-2 text-right" style="color: var(--color-fg-dark);">${formatNumber(
            model.cache_read_input_tokens
          )}</td>
          <td class="px-4 py-2 text-right" style="color: var(--color-fg-dark);">${formatNumber(
            model.cache_creation_input_tokens
          )}</td>
          <td class="px-4 py-2 text-right font-semibold" style="color: var(--color-yellow-accent);">${formatNumber(
            model.total_tokens
          )}</td>
          <td class="px-4 py-2 text-right font-semibold" style="color: var(--color-green);">${escapeHtml(
            formatCostAiu(model.total_nano_aiu)
          )}</td>
        </tr>
      `;
    })
    .join("");

  return `
    <div class="overflow-auto ${state.isTokenUsageLoading ? "opacity-60" : ""}">
      <table class="w-full min-w-[860px] text-left text-xs sm:text-sm">
        <thead style="background-color: var(--color-bg-light-1); color: var(--color-fg-medium);">
          <tr>
            <th class="px-4 py-2 font-semibold">Model</th>
            <th class="px-4 py-2 text-right font-semibold">Requests</th>
            <th class="px-4 py-2 text-right font-semibold">Input</th>
            <th class="px-4 py-2 text-right font-semibold">Output</th>
            <th class="px-4 py-2 text-right font-semibold">Cache Read</th>
            <th class="px-4 py-2 text-right font-semibold">Cache Write</th>
            <th class="px-4 py-2 text-right font-semibold">Total</th>
            <th class="px-4 py-2 text-right font-semibold">Cost</th>
          </tr>
        </thead>
        <tbody>
          ${rows}
        </tbody>
      </table>
    </div>
  `;
}

function renderTokenUsageEventsTable(eventsPage) {
  if (!eventsPage || eventsPage.items.length === 0) {
    return renderEmptyState(
      "No token usage detail rows for the selected period."
    );
  }

  const rows = eventsPage.items
    .map((event) => {
      const userId = formatCellText(event.user_id);
      const sessionId = formatCellText(event.session_id);
      const traceId = formatCellText(event.trace_id);

      return `
        <tr class="border-b last:border-b-0" style="border-color: var(--color-bg-light-1);">
          <td class="px-4 py-2 whitespace-nowrap" style="color: var(--color-fg-dark);" title="${escapeHtml(
            event.created_at_utc
          )}">${escapeHtml(formatDateTime(event.created_at_ms))}</td>
          <td class="px-4 py-2 max-w-[160px] truncate" style="color: var(--color-fg-lightest);" title="${escapeHtml(
            userId
          )}">${escapeHtml(userId)}</td>
          <td class="px-4 py-2 whitespace-nowrap" style="color: var(--color-fg-dark);">${escapeHtml(
            event.endpoint.replace(/_/g, " ")
          )}</td>
          <td class="px-4 py-2 max-w-[220px] truncate" style="color: var(--color-fg-lightest);" title="${escapeHtml(
            event.model
          )}">${escapeHtml(event.model)}</td>
          <td class="px-4 py-2 max-w-[180px] truncate font-mono" style="color: var(--color-fg-dark);" title="${escapeHtml(
            sessionId
          )}">${escapeHtml(sessionId)}</td>
          <td class="px-4 py-2 max-w-[200px] truncate font-mono" style="color: var(--color-fg-dark);" title="${escapeHtml(
            traceId
          )}">${escapeHtml(traceId)}</td>
          <td class="px-4 py-2 text-right" style="color: var(--color-fg-dark);">${formatNumber(
            event.input_tokens
          )}</td>
          <td class="px-4 py-2 text-right" style="color: var(--color-fg-dark);">${formatNumber(
            event.output_tokens
          )}</td>
          <td class="px-4 py-2 text-right" style="color: var(--color-fg-dark);">${formatNumber(
            event.cache_read_input_tokens
          )}</td>
          <td class="px-4 py-2 text-right" style="color: var(--color-fg-dark);">${formatNumber(
            event.cache_creation_input_tokens
          )}</td>
          <td class="px-4 py-2 text-right font-semibold" style="color: var(--color-yellow-accent);">${formatNumber(
            event.total_tokens
          )}</td>
        </tr>
      `;
    })
    .join("");

  return `
    <div class="overflow-auto ${state.isEventsLoading ? "opacity-60" : ""}">
      <table class="w-full min-w-[1180px] text-left text-xs sm:text-sm">
        <thead style="background-color: var(--color-bg-light-1); color: var(--color-fg-medium);">
          <tr>
            <th class="px-4 py-2 font-semibold">Time</th>
            <th class="px-4 py-2 font-semibold">User</th>
            <th class="px-4 py-2 font-semibold">Endpoint</th>
            <th class="px-4 py-2 font-semibold">Model</th>
            <th class="px-4 py-2 font-semibold">Session</th>
            <th class="px-4 py-2 font-semibold">Trace</th>
            <th class="px-4 py-2 text-right font-semibold">Input</th>
            <th class="px-4 py-2 text-right font-semibold">Output</th>
            <th class="px-4 py-2 text-right font-semibold">Cache Read</th>
            <th class="px-4 py-2 text-right font-semibold">Cache Write</th>
            <th class="px-4 py-2 text-right font-semibold">Total</th>
          </tr>
        </thead>
        <tbody>
          ${rows}
        </tbody>
      </table>
    </div>
  `;
}

function renderPaginationButton(action, label, disabled) {
  return `
    <button
      type="button"
      data-page-action="${action}"
      class="px-3 py-1.5 border text-xs font-medium"
      style="background-color: var(--color-bg-darkest); border-color: var(--color-bg-light-2); color: var(--color-fg-light);"
      ${disabled ? "disabled" : ""}
    >
      ${label}
    </button>
  `;
}

function renderEmptyState(message) {
  return `
    <div class="px-4 py-6 text-sm" style="color: var(--color-gray);">
      ${escapeHtml(message)}
    </div>
  `;
}

/**
 * Renders a loading spinner.
 * @returns {string} HTML string for the spinner.
 */
function renderSpinner() {
  return `
    <div class="flex justify-center items-center py-20">
        <div class="animate-spin h-12 w-12 rounded-full border-4 border-transparent border-t-4" style="border-top-color: var(--color-blue);"></div>
    </div>`;
}

/**
 * Renders an error message box.
 * @param {string} message - The error message to display.
 * @returns {string} HTML string for the error message.
 */
function renderError(message, title = "An Error Occurred") {
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
 * @returns {string} HTML string for the welcome message.
 */
function renderWelcomeMessage() {
  return `
    <div class="text-center py-16 px-4 border" style="background-color: var(--color-bg-soft); border-color: var(--color-bg-light-2);">
        <i data-lucide="info" class="mx-auto h-10 w-10" style="color: var(--color-gray-accent);"></i>
        <h3 class="mt-2 text-lg font-semibold" style="color: var(--color-fg-lightest);">Welcome!</h3>
        <p class="mt-1 text-sm" style="color: var(--color-gray);">Enter a usage endpoint and click "Fetch" to load usage and token usage data.</p>
    </div>
  `;
}

// --- Data Fetching ---

/**
 * Fetches usage data and token usage data from the specified API endpoint.
 */
async function fetchData(page = 1) {
  const period = getSelectedPeriod();
  state.isLoading = true;
  state.error = null;
  state.tokenUsageSummaryError = null;
  state.tokenUsageEventsError = null;
  render();

  try {
    const [usageResult, summaryResult, eventsResult] =
      await Promise.allSettled([
        fetchJson(USAGE_PATH),
        fetchJson(buildTokenUsageSummaryUrl(period)),
        fetchJson(buildTokenUsageEventsUrl(period, page)),
      ]);

    if (usageResult.status === "fulfilled") {
      state.data = usageResult.value;
    } else {
      state.data = null;
      state.error = getErrorMessage(usageResult.reason);
    }

    if (summaryResult.status === "fulfilled") {
      state.tokenUsageSummary = summaryResult.value;
    } else if (
      isMissingTokenUsageEndpointError(summaryResult.reason)
    ) {
      state.tokenUsageSummary = null;
      state.tokenUsageSummaryError = null;
    } else {
      state.tokenUsageSummary = null;
      state.tokenUsageSummaryError = getErrorMessage(
        summaryResult.reason
      );
    }

    if (eventsResult.status === "fulfilled") {
      state.tokenUsageEventsPage = eventsResult.value;
    } else if (
      isMissingTokenUsageEndpointError(eventsResult.reason)
    ) {
      state.tokenUsageEventsPage = null;
      state.tokenUsageEventsError = null;
    } else {
      state.tokenUsageEventsPage = null;
      state.tokenUsageEventsError = getErrorMessage(
        eventsResult.reason
      );
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

async function fetchTokenUsageSummaryAndEvents(page = 1) {
  const period = getSelectedPeriod();
  state.isTokenUsageLoading = true;
  state.tokenUsageSummary = null;
  state.tokenUsageEventsPage = null;
  state.tokenUsageSummaryError = null;
  state.tokenUsageEventsError = null;
  render();

  try {
    const [summaryResult, eventsResult] = await Promise.allSettled([
      fetchJson(buildTokenUsageSummaryUrl(period)),
      fetchJson(buildTokenUsageEventsUrl(period, page)),
    ]);

    if (summaryResult.status === "fulfilled") {
      state.tokenUsageSummary = summaryResult.value;
    } else if (
      isMissingTokenUsageEndpointError(summaryResult.reason)
    ) {
      state.tokenUsageSummary = null;
      state.tokenUsageSummaryError = null;
    } else {
      state.tokenUsageSummary = null;
      state.tokenUsageSummaryError = getErrorMessage(
        summaryResult.reason
      );
    }

    if (eventsResult.status === "fulfilled") {
      state.tokenUsageEventsPage = eventsResult.value;
    } else if (
      isMissingTokenUsageEndpointError(eventsResult.reason)
    ) {
      state.tokenUsageEventsPage = null;
      state.tokenUsageEventsError = null;
    } else {
      state.tokenUsageEventsPage = null;
      state.tokenUsageEventsError = getErrorMessage(
        eventsResult.reason
      );
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

async function fetchTokenUsageEventsPage(page) {
  state.isEventsLoading = true;
  state.tokenUsageEventsError = null;
  render();

  try {
    state.tokenUsageEventsPage = await fetchJson(
      buildTokenUsageEventsUrl(getSelectedPeriod(), page)
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

function handlePeriodChange() {
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

function handlePeriodButtonClick(event) {
  const button = event.currentTarget;
  const period = normalizePeriod(button.getAttribute("data-period"));
  if (period === state.tokenUsagePeriod) {
    return;
  }
  setSelectedPeriod(period);
  handlePeriodChange();
}

function handlePeriodButtonKeydown(event) {
  if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") {
    return;
  }
  event.preventDefault();
  const currentIndex = tokenUsagePeriodButtons.indexOf(event.currentTarget);
  if (currentIndex < 0) {
    return;
  }
  const delta = event.key === "ArrowRight" ? 1 : -1;
  const nextIndex =
    (currentIndex + delta + tokenUsagePeriodButtons.length)
    % tokenUsagePeriodButtons.length;
  const nextButton = tokenUsagePeriodButtons[nextIndex];
  const period = normalizePeriod(nextButton.getAttribute("data-period"));
  setSelectedPeriod(period);
  nextButton.focus();
  handlePeriodChange();
}

function handleContentAreaClick(event) {
  if (!(event.target instanceof Element)) {
    return;
  }

  const actionButton = event.target.closest("[data-page-action]");
  if (!actionButton || !state.tokenUsageEventsPage || state.isEventsLoading) {
    return;
  }

  const action = actionButton.getAttribute("data-page-action");
  if (
    action === "previous"
    && state.tokenUsageEventsPage.page > 1
  ) {
    void fetchTokenUsageEventsPage(state.tokenUsageEventsPage.page - 1);
  }

  if (
    action === "next"
    && state.tokenUsageEventsPage.page
      < state.tokenUsageEventsPage.total_pages
  ) {
    void fetchTokenUsageEventsPage(state.tokenUsageEventsPage.page + 1);
  }
}

/**
 * Initializes the application.
 */
function init() {
  // Detect Tauri lazily — `window.__TAURI__` isn't guaranteed to be
  // injected by the time this script's top-level code parses. By the
  // time init() runs (DOMContentLoaded via the script's `defer` attr)
  // it's reliably there if we're inside a Tauri webview.
  tauriCore = (window.__TAURI__ && window.__TAURI__.core) || null;
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

// Start the app
init();
