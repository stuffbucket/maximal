import { invoke } from "@tauri-apps/api/core";

import { getShellApiKey, openUrl, safeInvoke } from "./tauri/shell";


import type {
  DiagnosticsResponse,
  UpdateStatusResponse,
} from "../../src/lib/settings-types";
import type { AuthStatus, EventSubscription, UpstreamRejection } from "./proxy/client";
import { apiCall, subscribeAuthEvents } from "./proxy/client";
import { mountApiClients } from "./ui/islands/api-clients-island";
import { mountApps } from "./ui/islands/apps-island";
import { mountModels } from "./ui/islands/models-island";

type SectionId =
  | "account"
  | "apps"
  | "endpoint"
  | "api-clients"
  | "models"
  | "logs"
  | "diagnostics";

const SECTIONS: ReadonlyArray<SectionId> = [
  "account",
  "apps",
  "endpoint",
  "api-clients",
  "models",
  "logs",
  "diagnostics",
];

const DEFAULT_SECTION: SectionId = "account";

function isSectionId(value: string): value is SectionId {
  return (SECTIONS as ReadonlyArray<string>).includes(value);
}

function showSection(id: SectionId): void {
  for (const sec of document.querySelectorAll<HTMLElement>("[data-section]")) {
    sec.hidden = sec.dataset.section !== id;
  }
  for (const link of document.querySelectorAll<HTMLAnchorElement>(
    "[data-nav]",
  )) {
    const active = link.dataset.nav === id;
    link.setAttribute("aria-current", active ? "page" : "false");
    link.classList.toggle("nav__item--active", active);
  }
  // Pane is the scroll container now; reset *its* scroll, not the window's.
  const pane = document.getElementById("pane");
  if (pane) pane.scrollTop = 0;
}

function readHashSection(): SectionId {
  const raw = window.location.hash.replace(/^#/, "");
  return isSectionId(raw) ? raw : DEFAULT_SECTION;
}

function syncFromHash(): void {
  showSection(readHashSection());
}

/**
 * Bind a direct click handler to nav links in addition to the
 * hashchange listener. Belt-and-braces: in some webviews (Tauri's
 * WebKit on macOS in particular) a click on an `<a href="#x">` whose
 * target equals the current hash doesn't fire `hashchange`. The
 * direct handler keeps the UI feeling responsive in that case and
 * also lets us suppress the default anchor navigation so the
 * embedded webview never tries to treat it as a top-level navigation.
 */
function wireNav(): void {
  for (const link of document.querySelectorAll<HTMLAnchorElement>(
    "[data-nav]",
  )) {
    link.addEventListener("click", (ev) => {
      const id = link.dataset.nav;
      if (!id || !isSectionId(id)) return;
      ev.preventDefault();
      if (window.location.hash !== `#${id}`) {
        window.location.hash = id;
      } else {
        // Same hash → hashchange won't fire. Drive it manually.
        showSection(id);
      }
    });
  }
}


let busyCount = 0;

/**
 * Toggle the ambient "work in progress" indicator (the accent bar across the
 * top of the window). Ref-counted so overlapping transient operations compose
 * correctly — the bar shows while >=1 op is in flight, hides when all settle.
 * Wrap each transient op in setBusy(true, "…") … setBusy(false) (try/finally)
 * so an early return/throw can't leak a stuck bar.
 */
function setBusy(on: boolean, label = "Working…"): void {
  busyCount = Math.max(0, busyCount + (on ? 1 : -1));
  const root = document.documentElement;
  const labelEl = document.querySelector<HTMLElement>("[data-busybar-label]");
  if (busyCount > 0) {
    if (root.getAttribute("data-busy") !== "true") {
      root.setAttribute("data-busy", "true"); // 0 -> 1: show + announce once
      if (labelEl) labelEl.textContent = label;
    }
  } else {
    root.removeAttribute("data-busy");
    if (labelEl) labelEl.textContent = ""; // clear; do not re-announce
  }
}

function wireLogs(): void {
  const revealLogs = () => {
    void safeInvoke("reveal_logs_dir");
  };
  document
    .querySelector('[data-section="logs"] [data-action="reveal-logs"]')
    ?.addEventListener("click", revealLogs);
}

// ---- Endpoint section ------------------------------------------------------

const ENDPOINT_BASE_URL = "http://127.0.0.1:4141";
let endpointApiKey: string | null = null;

async function loadEndpointApiKey(): Promise<void> {
  if (endpointApiKey !== null) return;
  try {
    endpointApiKey = await getShellApiKey();
  } catch (err) {
    console.warn("invoke(get_shell_api_key) failed:", err);
    endpointApiKey = null;
  }
}

function getEndpointKeyEl(): HTMLElement | null {
  return document.querySelector<HTMLElement>(
    '[data-section="endpoint"] [data-field="endpoint-api-key"]',
  );
}

async function copyToClipboard(text: string, btn: Element | null): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
    if (btn instanceof HTMLElement) {
      const original = btn.textContent;
      btn.textContent = "Copied";
      window.setTimeout(() => {
        btn.textContent = original;
      }, 1200);
    }
  } catch (err) {
    console.warn("clipboard.writeText failed:", err);
  }
}

/** Show or clear the inline, non-blocking error inside the Uninstall card.
 *  Pass null to clear. Mirrors the diagnostics error row. */
function setUninstallError(message: string | null): void {
  const row = document.querySelector<HTMLElement>("[data-uninstall-error]");
  const msg = document.querySelector<HTMLElement>(
    "[data-uninstall-error-message]",
  );
  if (!row || !msg) return;
  if (message === null) {
    row.hidden = true;
    return;
  }
  msg.textContent = message;
  row.hidden = false;
}

/** Wire the in-app "Uninstall Maximal…" button. Reads the two option
 *  checkboxes in the card (not the dialog — neither window.confirm nor the
 *  native dialog supports in-dialog checkboxes), summarizes the choices into a
 *  confirm prompt, then runs the privileged `uninstall_maximal` command.
 *  Mirrors the signOut() shape: confirm → setBusy → invoke → settle. */
function wireUninstall(): void {
  const section = document.querySelector('[data-section="diagnostics"]');
  if (!section) return;
  section
    .querySelector('[data-action="uninstall-maximal"]')
    ?.addEventListener("click", () => {
      void runInAppUninstall();
    });
}

async function runInAppUninstall(): Promise<void> {
  const revertClaude =
    document.querySelector<HTMLInputElement>("[data-uninstall-revert-claude]")
      ?.checked ?? false;
  const purge =
    document.querySelector<HTMLInputElement>("[data-uninstall-purge]")
      ?.checked ?? false;

  const clauses = ["removes the maximal CLI"];
  if (revertClaude) clauses.push("reverts Claude Desktop’s keys");
  if (purge) clauses.push("deletes stored secrets & config");
  const tail = clauses.length > 1 ? `, and ${clauses.pop() ?? ""}` : "";
  const summary = `${clauses.join(", ")}${tail}`;
  const confirmed = window.confirm(
    "Uninstall Maximal?\n\n" +
      `This stops the background agent and ${summary}. ` +
      "You'll drag the app to the Trash to finish.\n\n" +
      "This can't be undone.",
  );
  if (!confirmed) return;

  setUninstallError(null);
  setBusy(true, "Uninstalling…");
  try {
    await invoke("uninstall_maximal", { revertClaude, purge });
    showUninstallComplete();
  } catch (err) {
    // Tauri rejects with the Err(String) reason from the Rust command, or a
    // generic message in plain-browser (app:ui, no Tauri host). Surface it
    // inline rather than leaving the user with no feedback.
    console.warn("invoke(uninstall_maximal) failed:", err);
    setUninstallError(
      `Couldn't finish uninstalling: ${String(err)}. ` +
        "You can run `maximal uninstall` in the terminal instead.",
    );
  } finally {
    setBusy(false);
  }
}

/** Replace the card body with a calm completion state. No new quit command —
 *  the user quits from the tray and trashes the app from Applications. */
function showUninstallComplete(): void {
  const body = document.querySelector<HTMLElement>("[data-uninstall-body]");
  if (!body) return;
  const done = document.createElement("p");
  done.className = "card__hint";
  done.textContent =
    "Maximal is uninstalled. Quit Maximal from the tray menu, then drag it " +
    "from Applications to the Trash to finish.";
  body.replaceChildren(done);
}

function wireEndpoint(): void {
  const section = document.querySelector('[data-section="endpoint"]');
  if (!section) return;

  section
    .querySelector('[data-action="copy-base-url"]')
    ?.addEventListener("click", (ev) => {
      void copyToClipboard(ENDPOINT_BASE_URL, ev.currentTarget as Element);
    });

  section
    .querySelector('[data-action="reveal-api-key"]')
    ?.addEventListener("click", async (ev) => {
      await loadEndpointApiKey();
      const el = getEndpointKeyEl();
      if (!el) return;
      const revealed = el.dataset.revealed === "true";
      if (revealed) {
        el.dataset.revealed = "false";
        el.textContent = "••••••••••••••••••••••";
        (ev.currentTarget as HTMLElement).textContent = "Reveal";
      } else {
        el.dataset.revealed = "true";
        el.textContent = endpointApiKey ?? "(not available)";
        (ev.currentTarget as HTMLElement).textContent = "Hide";
      }
    });

  section
    .querySelector('[data-action="copy-api-key"]')
    ?.addEventListener("click", async (ev) => {
      await loadEndpointApiKey();
      if (endpointApiKey) {
        void copyToClipboard(endpointApiKey, ev.currentTarget as Element);
      }
    });

  section
    .querySelector('[data-action="copy-curl-example"]')
    ?.addEventListener("click", async (ev) => {
      await loadEndpointApiKey();
      const key = endpointApiKey ?? "$MAXIMAL_API_KEY";
      const curl = [
        `curl ${ENDPOINT_BASE_URL}/v1/messages \\`,
        `  -H "x-api-key: ${key}" \\`,
        `  -H "anthropic-version: 2023-06-01" \\`,
        `  -H "content-type: application/json" \\`,
        `  -d '{"model":"claude-sonnet-4-5","max_tokens":256,"messages":[{"role":"user","content":"Hello"}]}'`,
      ].join("\n");
      void copyToClipboard(curl, ev.currentTarget as Element);
    });
}

function applyTheme(): void {
  const root = document.documentElement;
  if (root.dataset.theme) return;
  const prefersLight =
    window.matchMedia &&
    window.matchMedia("(prefers-color-scheme: light)").matches;
  root.dataset.theme = prefersLight ? "light" : "dark";
}

// ---- Diagnostics section ---------------------------------------------------

function formatUptime(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const s = totalSeconds % 60;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

function formatRateLimit(rl: DiagnosticsResponse["rate_limit"]): string {
  if (rl.interval_seconds === null) return "Unlimited";
  const tail = rl.last_request_at
    ? ` (last request ${new Date(rl.last_request_at).toLocaleTimeString()})`
    : "";
  const wait = rl.wait_when_throttled ? "wait" : "reject";
  return `≥${rl.interval_seconds}s between requests, ${wait}${tail}`;
}

function setField(name: string, value: string): void {
  const el = document.querySelector<HTMLElement>(`[data-field="${name}"]`);
  if (el) el.textContent = value;
}

function renderDiagnostics(data: DiagnosticsResponse): void {
  setField("version", data.version);
  setField("source_revision", data.source_revision ?? "unknown");
  setField("launch_source", formatLaunchSource(data));
  setField("pid", String(data.pid));
  setField("uptime", formatUptime(data.uptime_ms));
  setField("account_type", data.account_type ?? "unknown");
  setField("models_cached", String(data.models_cached));
  setField("github_copilot_status", deriveGithubCopilotStatus(data.tokens));
  setField("rate_limit", formatRateLimit(data.rate_limit));
}

/**
 * Human-readable launch origin: a short label for the install kind plus
 * the absolute path it ran from. Lets a bug report distinguish a DMG
 * launch from a stray Homebrew or dev-build one at a glance.
 */
function formatLaunchSource(data: DiagnosticsResponse): string {
  const labels: Record<DiagnosticsResponse["launch_kind"], string> = {
    "dmg-app": "Desktop app",
    homebrew: "Homebrew",
    "user-bin": "User bin",
    dev: "Dev build",
    other: "Other",
  };
  const label = labels[data.launch_kind] ?? "Other";
  return `${label} — ${data.launch_path}`;
}

/**
 * Collapse the two underlying booleans into one human-readable status.
 *
 *   github | copilot | status
 *   -------+---------+--------------------------------------------------
 *   true   | true    | "Signed in, ready"
 *   true   | false   | "Token will refresh on first request"
 *   false  | false   | "Not signed in"
 *   false  | true    | "Inconsistent — try signing in again"
 *
 * Wire format keeps both booleans; this derivation is purely a UI
 * concern. Surfacing the inconsistent state (rather than hiding it)
 * gives the user an actionable path when something's off.
 */
function deriveGithubCopilotStatus(
  tokens: DiagnosticsResponse["tokens"],
): string {
  const gh = tokens.github_token_present;
  const cop = tokens.copilot_token_present;
  if (gh && cop) return "Signed in, ready";
  if (gh && !cop) return "Token will refresh on first request";
  if (!gh && !cop) return "Not signed in";
  return "Inconsistent — try signing in again";
}

function setDiagnosticsError(message: string | null): void {
  const banner = document.querySelector<HTMLElement>("[data-diagnostics-error]");
  const msg = document.querySelector<HTMLElement>("[data-error-message]");
  if (!banner || !msg) return;
  if (message === null) {
    banner.hidden = true;
    return;
  }
  msg.textContent = message;
  banner.hidden = false;
}

let lastDiagnostics: DiagnosticsResponse | null = null;

async function loadDiagnostics(): Promise<void> {
  const root = document.querySelector<HTMLElement>("[data-diagnostics-root]");
  if (!root) return;
  root.setAttribute("aria-busy", "true");
  setDiagnosticsError(null);
  const result = await apiCall({
    kind: "diagnostics",
    method: "GET",
    path: "/settings/api/diagnostics",
  });
  root.setAttribute("aria-busy", "false");
  if (!result.ok) {
    setDiagnosticsError(`Failed to load diagnostics: ${result.error}`);
    return;
  }
  lastDiagnostics = result.data;
  renderDiagnostics(result.data);
  // Best-effort, independent of the diagnostics fetch: the proxy caches the
  // GitHub ping for hours, so re-running on each section open is cheap.
  void loadUpdateStatus();
}

/**
 * Render the Diagnostics "Updates" row from GET /settings/api/update-status.
 * Three shapes: a newer release (offer the mxml.sh link), up to date, or
 * unknown (check disabled / offline / rate-limited — never claim "up to date"
 * when we couldn't actually check). The link opens in the system browser via
 * the opener plugin; mxml.sh routes to the right artifact for the install.
 */
function renderUpdateStatus(data: UpdateStatusResponse): void {
  const dd = document.querySelector<HTMLElement>(
    '[data-field="update_status"]',
  );
  if (!dd) return;
  dd.replaceChildren();

  if (data.update_available && data.latest) {
    const label = document.createElement("span");
    label.className = "mono";
    label.textContent = `v${data.latest} available · `;
    const link = document.createElement("a");
    link.href = data.url;
    link.textContent = "Get it at mxml.sh";
    link.addEventListener("click", (ev) => {
      ev.preventDefault();
      void openExternalUrl(data.url);
    });
    dd.append(label, link);
    return;
  }

  const span = document.createElement("span");
  span.className = "mono";
  // `latest` known but not newer → genuinely current. `latest === null` → we
  // couldn't check; say so rather than imply everything's fine.
  span.textContent = data.latest ? "Up to date" : "—";
  dd.append(span);
}

async function loadUpdateStatus(): Promise<void> {
  const dd = document.querySelector<HTMLElement>(
    '[data-field="update_status"]',
  );
  const result = await apiCall({
    kind: "update-status",
    method: "GET",
    path: "/settings/api/update-status",
  });
  if (!result.ok) {
    if (dd) dd.textContent = "—";
    return;
  }
  renderUpdateStatus(result.data);
}

async function copyDiagnosticsAsJson(): Promise<void> {
  if (!lastDiagnostics) return;
  try {
    await navigator.clipboard.writeText(JSON.stringify(lastDiagnostics, null, 2));
  } catch (err) {
    console.error("clipboard write failed", err);
  }
}

function wireDiagnostics(): void {
  document
    .querySelector("[data-diagnostics-retry]")
    ?.addEventListener("click", () => {
      void loadDiagnostics();
    });
  document
    .querySelector('[data-action="copy-json"]')
    ?.addEventListener("click", () => {
      void copyDiagnosticsAsJson();
    });
  document
    .querySelector('[data-section="diagnostics"] [data-action="reveal-config"]')
    ?.addEventListener("click", () => {
      void safeInvoke("reveal_config_dir");
    });
}

// ---- Account section -------------------------------------------------------

/**
 * Account-section update contract (ADR-0007):
 *  - SSE is the PRIMARY channel. While #account is open we hold one
 *    `subscribeAuthEvents` subscription; `auth.changed` drives `renderAccount`
 *    with no poll lag. Opened on section enter, closed on leave.
 *  - The GET poll is the FALLBACK. `schedulePoll()` is a no-op while the
 *    stream is connected (`sseConnected`); it only runs when a sign-in is
 *    pending and SSE is down, so a dropped stream degrades to polling.
 *  - Only one poll timer runs at a time (`authPollTimer`).
 *  - `stopAuthPolling()` clears the timer; called on terminal states
 *    (authenticated, error, unauthenticated), on sign-out, on SSE connect,
 *    and on navigation away from #account.
 *  - `renderAccount` is the single source of truth for visibility;
 *    a non-pending state always stops polling before the next call.
 */
type AccountStateKey = "unauthenticated" | "pending" | "authenticated" | "error";

const POLL_INTERVAL_MS = 2000;

let currentAuthStatus: AuthStatus | null = null;
let authPollTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * Live updates (ADR-0007). While the Account section is open we hold one
 * SSE subscription to the sidecar; `auth.changed` events drive `renderAccount`
 * the instant the device-code poller resolves — no 2s poll lag. The GET poll
 * remains as a FALLBACK: it runs only while a sign-in is pending AND the SSE
 * stream is not connected (`sseConnected`), so a dropped stream degrades to
 * polling instead of stalling. `subscribeAuthEvents` resolves the API key
 * asynchronously, so a generation counter discards a subscription that
 * resolved after the section was already left.
 */
let authEvents: EventSubscription | null = null;
let sseConnected = false;
let authEventsGen = 0;

function stopAuthPolling(): void {
  if (authPollTimer !== null) {
    clearTimeout(authPollTimer);
    authPollTimer = null;
  }
}

function schedulePoll(): void {
  // SSE is the primary channel; only poll as a fallback when it's down.
  if (sseConnected) {
    stopAuthPolling();
    return;
  }
  stopAuthPolling();
  authPollTimer = setTimeout(() => {
    authPollTimer = null;
    void pollAuthStatus();
  }, POLL_INTERVAL_MS);
}

function openAuthEvents(): void {
  if (authEvents) return;
  const gen = ++authEventsGen;
  void subscribeAuthEvents({
    onOpen: () => {
      if (gen !== authEventsGen) return;
      sseConnected = true;
      // The stream is live; the fallback poll is now redundant.
      stopAuthPolling();
    },
    onAuth: (status) => {
      if (gen !== authEventsGen) return;
      // Only paint while the user is actually on the Account section.
      if (readHashSection() === "account") renderAccount(status);
    },
    onError: () => {
      if (gen !== authEventsGen) return;
      sseConnected = false;
      // Stream dropped — fall back to polling if a sign-in is mid-flight.
      if (
        readHashSection() === "account" &&
        currentAuthStatus !== null &&
        (currentAuthStatus.state === "device_code_issued" ||
          currentAuthStatus.state === "polling")
      ) {
        schedulePoll();
      }
    },
  }).then(
    (subscription) => {
      // Section was left (or re-entered) while the key resolved — discard.
      if (gen !== authEventsGen) {
        subscription.close();
        return;
      }
      authEvents = subscription;
    },
    () => {
      // Key resolution / EventSource construction failed; polling fallback
      // stays in force. Nothing to clean up.
    },
  );
}

function closeAuthEvents(): void {
  authEventsGen++;
  sseConnected = false;
  if (authEvents) {
    authEvents.close();
    authEvents = null;
  }
}

function accountKeyFor(state: AuthStatus["state"]): AccountStateKey {
  // Exhaustive over AuthStatus["state"] (ADR-0006). A new variant added
  // to the union surfaces as a `never` compile error here instead of
  // silently falling through to "unauthenticated" — which is the bug
  // class that hid the upstream-rejection + gh-reuse state additions.
  switch (state) {
    case "device_code_issued":
    case "polling":
      return "pending";
    case "authenticated":
      return "authenticated";
    case "error":
      return "error";
    case "unauthenticated":
      return "unauthenticated";
    default: {
      const _exhaust: never = state;
      void _exhaust;
      return "unauthenticated";
    }
  }
}

function accountSlot(name: string): HTMLElement | null {
  return document.querySelector<HTMLElement>(
    `[data-section="account"] [data-field="${name}"]`,
  );
}

function setAccountField(name: string, value: string): void {
  const el = accountSlot(name);
  if (el) el.textContent = value;
}

/**
 * Render the GitHub avatar for the signed-in user. GitHub serves
 * a public PNG at https://github.com/<login>.png — no API, no auth.
 * We swap in an <img>; on load-failure (404, offline) we fall back
 * to a typographic placeholder showing the user's first initial,
 * so the layout never collapses.
 */
function renderAccountAvatar(login: string, avatarUrl?: string): void {
  const slot = accountSlot("account_avatar");
  if (!slot) return;
  // ADR-0006: `account_login` is required on the authenticated variant
  // and the controller only emits a real GitHub login (a failed user
  // lookup surfaces as `state: "error"` instead — there is no "unknown"
  // sentinel). The empty-string guard remains as belt-and-braces for
  // future variants; current backend never emits one.
  const isPlaceholder = !login;
  const initial = isPlaceholder ? "?" : (login[0] ?? "?").toUpperCase();
  slot.textContent = "";
  slot.classList.remove("signed-in-hero__avatar--fallback");
  if (isPlaceholder) {
    slot.textContent = initial;
    slot.classList.add("signed-in-hero__avatar--fallback");
    return;
  }
  const img = document.createElement("img");
  img.className = "signed-in-hero__avatar-img";
  // Prefer the API-provided `avatar_url` (resolves for Enterprise Managed
  // Users, whose login has no public github.com profile); fall back to the
  // public `github.com/<login>.png` for any account that predates the field.
  img.src =
    avatarUrl ?? `https://github.com/${encodeURIComponent(login)}.png?size=128`;
  img.alt = `${login} GitHub avatar`;
  img.loading = "lazy";
  img.decoding = "async";
  img.width = 56;
  img.height = 56;
  img.addEventListener("error", () => {
    slot.textContent = initial;
    slot.classList.add("signed-in-hero__avatar--fallback");
  });
  slot.appendChild(img);
}

/**
 * Format how long the session has been connected, from the `connected_since`
 * ISO timestamp. Coarse on purpose — "Connected · 2h", not a ticking clock —
 * so it reads as a status, not a stopwatch. Returns just "Connected" when the
 * timestamp is absent (cold-boot / legacy session) or in the future (clock
 * skew).
 */
function formatConnectedFor(connectedSince: string | undefined): string {
  if (!connectedSince) return "Connected";
  const sinceMs = Date.parse(connectedSince);
  if (Number.isNaN(sinceMs)) return "Connected";
  const elapsed = Date.now() - sinceMs;
  if (elapsed < 60_000) return "Connected · just now";
  const minutes = Math.floor(elapsed / 60_000);
  if (minutes < 60) return `Connected · ${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    const rem = minutes % 60;
    return rem ? `Connected · ${hours}h ${rem}m` : `Connected · ${hours}h`;
  }
  const days = Math.floor(hours / 24);
  return `Connected · ${days}d`;
}

// Re-render the connection line on a coarse cadence so the uptime advances
// without a server round-trip. Only runs while the authenticated card is shown;
// cleared by renderConnection on any non-authenticated state and on leave.
let connUptimeTimer: ReturnType<typeof setInterval> | null = null;

function stopConnUptimeTicker(): void {
  if (connUptimeTimer !== null) {
    clearInterval(connUptimeTimer);
    connUptimeTimer = null;
  }
}

/**
 * Paint the reachability indicator + the "Connected · <uptime>" line. The ⇄
 * stroke turns "degraded" when a recent upstream rejection is riding along
 * (the rejection banner explains the why); otherwise it reads "connected".
 */
function renderConnection(
  connectedSince: string | undefined,
  degraded: boolean,
): void {
  const indicator = accountSlot("conn_indicator");
  if (indicator) {
    indicator.dataset.conn = degraded ? "degraded" : "connected";
    indicator.setAttribute(
      "aria-label",
      degraded ? "Connection degraded" : "Connected to GitHub Copilot",
    );
  }
  setAccountField("conn_status", formatConnectedFor(connectedSince));
  // Keep the uptime advancing while this card is visible.
  stopConnUptimeTicker();
  if (connectedSince) {
    connUptimeTimer = setInterval(() => {
      if (readHashSection() !== "account") return;
      setAccountField("conn_status", formatConnectedFor(connectedSince));
    }, 60_000);
  }
}

/**
 * Render the "Open GitHub to resolve" link in the error card, or
 * hide the surrounding paragraph if GHCP didn't give us a URL. The
 * containing <p> is `hidden` by default in the HTML so the empty
 * state never shows.
 */
function renderRemediationLink(url: string | undefined): void {
  const wrapper = accountSlot("remediation");
  const anchor = accountSlot("remediation_uri");
  if (!wrapper || !(anchor instanceof HTMLAnchorElement)) return;
  if (!url) {
    wrapper.hidden = true;
    anchor.removeAttribute("href");
    anchor.textContent = "";
    return;
  }
  anchor.href = url;
  anchor.textContent = labelForRemediationUrl(url);
  wrapper.hidden = false;
}

/**
 * Render the upstream-rejection banner inside the authenticated card.
 * Shows the upstream message and (when present) a labelled remediation
 * link. Hidden entirely when `rejection` is undefined — the sidecar
 * clears on the next successful completion, so the polling cycle
 * naturally drives the banner away once the user is back to a healthy
 * state.
 */
/** A human category for an upstream HTTP status — so even when the upstream
 *  message is generic, the user can tell a "wait and retry" from a "fix your
 *  billing" from a "this model isn't allowed". */
function rejectionTitle(status: number): string {
  if (status === 402) return "Copilot billing or plan issue";
  if (status === 403) return "Request blocked by Copilot";
  if (status === 404) return "Copilot couldn’t find that";
  if (status === 408 || status === 504) return "Copilot request timed out";
  if (status === 429) return "Copilot usage limit reached";
  if (status >= 500) return "GitHub Copilot is having trouble";
  if (status >= 400) return "Copilot rejected the request";
  return "Copilot returned an error";
}

/** Actionable next step keyed off the status, used when the upstream message
 *  itself is missing or the generic fallback. */
function rejectionExplanation(status: number): string {
  if (status === 402)
    return "Check your Copilot plan or billing on GitHub, then try again.";
  if (status === 403)
    return "This model or request isn’t allowed on your current plan.";
  if (status === 408 || status === 504)
    return "It took too long to respond. Try again in a moment.";
  if (status === 429)
    return "You’ve hit a rate or quota limit. Wait a moment and try again.";
  if (status >= 500)
    return "GitHub’s side returned an error. This is usually temporary — try again shortly.";
  return "Try again, or check your Copilot account on GitHub.";
}

function renderUpstreamRejection(
  rejection: UpstreamRejection | undefined,
): void {
  const wrapper = accountSlot("upstream_rejection");
  if (!wrapper) return;
  if (!rejection) {
    wrapper.hidden = true;
    return;
  }
  const status = rejection.status;
  const titleEl = accountSlot("upstream_rejection_title");
  if (titleEl)
    titleEl.textContent = `${rejectionTitle(status)} · HTTP ${status}`;

  // Show the real upstream message when we have one; otherwise the generic
  // fallback tells the user nothing, so swap in a status-derived next step.
  const raw = rejection.message.trim();
  const useful = raw && raw !== "Copilot returned an error.";
  const messageEl = accountSlot("upstream_rejection_message");
  if (messageEl)
    messageEl.textContent = useful ? raw : rejectionExplanation(status);

  const linkWrap = accountSlot("upstream_rejection_link_wrap");
  const link = accountSlot("upstream_rejection_link");
  if (link instanceof HTMLAnchorElement && linkWrap) {
    if (rejection.remediation_url) {
      link.href = rejection.remediation_url;
      link.textContent = labelForRemediationUrl(rejection.remediation_url);
      linkWrap.hidden = false;
    } else {
      link.removeAttribute("href");
      link.textContent = "";
      linkWrap.hidden = true;
    }
  }
  wrapper.hidden = false;
}

function labelForRemediationUrl(url: string): string {
  // Most GHCP rejection bodies point at one of a few well-known
  // GitHub pages. Map them to verbs the user will recognize; fall
  // back to a generic "Open in GitHub" for everything else so the
  // link still works when GHCP introduces new endpoints.
  if (/\/settings\/copilot/i.test(url)) return "Open Copilot settings on GitHub";
  if (/\/copilot\/signup/i.test(url)) return "Accept updated Copilot terms";
  if (/\/site\/terms|\/terms-of-service/i.test(url)) return "Review GitHub terms";
  return "Open in GitHub";
}

function formatExpiresAt(iso: string | undefined): string {
  if (!iso) return "soon";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleTimeString();
}

/**
 * Show or hide the shared known-account rosters (remembered registry accounts
 * + gh-cli cached accounts) that live OUTSIDE the per-state cards. These are
 * surfaced across the unauthenticated, error, and device-code/polling states
 * so the device-code flow is a fallback, never the only option.
 *
 * When shown, both lists are (re)populated fresh — `loadAccounts`/
 * `loadGhAccounts` each hide their own sub-block when empty, so the outer
 * wrapper can collapse to nothing visible if there's truly nothing to offer.
 * Best-effort: a failed fetch just hides that list, never blocks the page.
 */
function showKnownAccountRosters(visible: boolean): void {
  const wrapper = document.querySelector<HTMLElement>("[data-account-rosters]");
  if (!wrapper) return;
  if (!visible) {
    wrapper.hidden = true;
    return;
  }
  // Reveal the wrapper while the lists load so the "or" divider doesn't pop in
  // after them; collapse it again if BOTH inner blocks turn out empty (so a
  // user with no remembered/gh accounts sees no dangling divider).
  wrapper.hidden = false;
  // Repopulated each time so a `gh logout` or registry change elsewhere can't
  // leave a stale row. Best-effort: a failed fetch just hides that list.
  void Promise.all([loadAccounts("remembered"), loadGhAccounts()]).then(() => {
    const remembered = document.querySelector<HTMLElement>(
      "[data-account-remembered]",
    );
    const gh = document.querySelector<HTMLElement>("[data-gh-reuse]");
    const nothingToOffer =
      (!remembered || remembered.hidden) && (!gh || gh.hidden);
    wrapper.hidden = nothingToOffer;
  });
}

/**
 * Authenticated-state variant of the shared rosters: surface ONLY the gh-CLI
 * accounts below the hero (the inline "Switch to" roster already lists the
 * persisted accounts, so the remembered block stays hidden to avoid showing the
 * same accounts twice). loadGhAccounts dedups against the registry, so the
 * active account never appears here. Collapses the wrapper when gh offers
 * nothing — a single-account user with no gh logins sees just the hero.
 */
function showGhAccountsForAuthenticated(): void {
  const wrapper = document.querySelector<HTMLElement>("[data-account-rosters]");
  const remembered = document.querySelector<HTMLElement>(
    "[data-account-remembered]",
  );
  if (!wrapper) return;
  if (remembered) remembered.hidden = true;
  wrapper.hidden = false;
  void loadGhAccounts().then(() => {
    const gh = document.querySelector<HTMLElement>("[data-gh-reuse]");
    wrapper.hidden = !gh || gh.hidden;
  });
}

function renderAccount(status: AuthStatus): void {
  currentAuthStatus = status;
  const active = accountKeyFor(status.state);
  // The uptime ticker only belongs to the authenticated card; the
  // authenticated branch restarts it via renderConnection.
  stopConnUptimeTicker();

  for (const card of document.querySelectorAll<HTMLElement>(
    "[data-state-account]",
  )) {
    card.hidden = card.dataset.stateAccount !== active;
  }

  // ADR-0006: switch on the discriminator so the compiler narrows per
  // branch. Each variant declares exactly the fields it carries; the
  // previous `?? "(unknown)"` / `?? "…"` / `?? "https://…"` fallbacks
  // are gone because the union guarantees presence.
  switch (status.state) {
    case "device_code_issued":
    case "polling": {
      setAccountField("user_code", status.user_code);
      setAccountField("expires_at", formatExpiresAt(status.expires_at));
      const link = accountSlot("verification_uri");
      if (link instanceof HTMLAnchorElement) {
        link.href = status.verification_uri;
        link.textContent = status.verification_uri.replace(/^https?:\/\//, "");
      }
      // A pending device code is a fallback, not a trap: also surface any
      // known accounts so the user can abandon the code and pick one.
      showKnownAccountRosters(true);
      break;
    }
    case "authenticated": {
      // `account_login` is required on this variant. The controller emits
      // the literal "unknown" string when getGitHubUser failed best-effort
      // during the device flow — `renderAccountAvatar` treats "unknown"
      // as a placeholder trigger.
      setAccountField("account_login", status.account_login);
      renderAccountAvatar(status.account_login, status.account_avatar_url);
      renderConnection(
        status.connected_since,
        status.last_upstream_rejection !== undefined,
      );
      renderUpstreamRejection(status.last_upstream_rejection);
      // Populate the inline "Switch to" roster (other persisted accounts; the
      // active account is the hero and excluded).
      void loadAccounts("roster");
      // Also surface gh-CLI accounts to switch to — they "follow" below the
      // hero. The remembered roster stays hidden (the inline "Switch to"
      // already covers persisted accounts); only gh-reuse shows here.
      showGhAccountsForAuthenticated();
      break;
    }
    case "error": {
      setAccountField("error", status.error);
      renderRemediationLink(status.remediation_url);
      // A failed sign-in must not strand the user on "Try again": offer the
      // accounts we already know about as an escape hatch.
      showKnownAccountRosters(true);
      break;
    }
    case "unauthenticated": {
      showKnownAccountRosters(true);
      break;
    }
    default: {
      const _exhaust: never = status;
      void _exhaust;
    }
  }

  if (active === "pending") {
    schedulePoll();
  } else {
    stopAuthPolling();
  }
}

async function loadAuthStatus(): Promise<void> {
  const result = await apiCall({
    kind: "auth-status",
    method: "GET",
    path: "/settings/api/auth/github/status",
  });
  if (!result.ok) {
    renderAccount({
      state: "error",
      error: `Failed to load auth status: ${result.error}`,
    });
    return;
  }
  renderAccount(result.data);
}

function ghErrorEl(): HTMLElement | null {
  return document.querySelector<HTMLElement>("[data-gh-error]");
}

function showGhError(message: string): void {
  const el = ghErrorEl();
  if (!el) return;
  el.textContent = message;
  el.hidden = false;
  // The account section can be tall (remembered + gh lists), so an error on a
  // row near the bottom can land off-screen. Bring it into view.
  el.scrollIntoView({ block: "nearest" });
}

function hideGhError(): void {
  const el = ghErrorEl();
  if (!el) return;
  el.hidden = true;
  el.textContent = "";
}

/** apiCall surfaces the raw response body in `error`. Our settings endpoints
 *  reply `{ error: { message } }`; pull that out so the UI shows the specific
 *  reason (e.g. the /gh/use pre-flight message) rather than raw JSON. */
function apiErrorMessage(raw: string): string {
  try {
    const parsed = JSON.parse(raw) as { error?: { message?: string } };
    if (typeof parsed.error?.message === "string" && parsed.error.message) {
      return parsed.error.message;
    }
  } catch {
    // not JSON — use the raw text
  }
  return raw;
}

/**
 * Populate the "reuse a GitHub CLI account" list from GET /gh/status. The
 * wrapper stays hidden unless gh is installed AND has ≥1 account — a user
 * with gh-but-no-login sees nothing (the device flow already covers them).
 * Best-effort: any failure just hides the section.
 */
async function loadGhAccounts(): Promise<void> {
  const wrapper = document.querySelector<HTMLElement>("[data-gh-reuse]");
  const list = document.querySelector<HTMLUListElement>("[data-gh-accounts]");
  const template = document.querySelector<HTMLTemplateElement>(
    "[data-gh-row-template]",
  );
  if (!wrapper || !list || !template) return;

  const result = await apiCall({
    kind: "gh-status",
    method: "GET",
    path: "/settings/api/gh/status",
  });
  if (!result.ok || !result.data.installed || result.data.accounts.length === 0) {
    wrapper.hidden = true;
    list.replaceChildren();
    return;
  }

  // Dedup against the registry: a gh account that's already a remembered
  // (persisted) account is offered in the "Switch to a remembered account"
  // list above, so don't ALSO list it here as a fresh sign-in — that
  // double-listing is what reads as confusing. Best-effort: if the accounts
  // fetch fails, fall back to showing every gh account.
  const remembered = await apiCall({
    kind: "accounts-list",
    method: "GET",
    path: "/settings/api/accounts",
  });
  const rememberedKeys = new Set(
    remembered.ok ? remembered.data.accounts.map((a) => a.key) : [],
  );
  const ghAccounts = result.data.accounts.filter(
    (a) => !rememberedKeys.has(`${a.login}@${a.host}`),
  );
  if (ghAccounts.length === 0) {
    wrapper.hidden = true;
    list.replaceChildren();
    return;
  }

  list.replaceChildren();
  hideGhError();
  for (const account of ghAccounts) {
    const seed = template.content.firstElementChild;
    if (!seed) continue;
    const row = seed.cloneNode(true) as HTMLElement;

    const loginEl = row.querySelector<HTMLElement>('[data-field="gh_login"]');
    if (loginEl) loginEl.textContent = account.login;
    const hostEl = row.querySelector<HTMLElement>('[data-field="gh_host"]');
    if (hostEl) hostEl.textContent = account.host;

    if (account.active) {
      row.querySelector(".gh-account__dot")?.classList.add("status--ok");
      const sr = document.createElement("span");
      sr.className = "sr-only";
      sr.textContent = " (currently active)";
      row.querySelector(".gh-account__id")?.appendChild(sr);
    }

    const button = row.querySelector<HTMLButtonElement>(
      '[data-action="gh-use"]',
    );
    if (button) {
      button.dataset.ghLogin = account.login;
      button.dataset.ghHost = account.host;
      button.setAttribute("aria-label", `Use this account: ${account.login}`);
    }
    list.appendChild(row);
  }
  wrapper.hidden = false;
}

/**
 * Refresh the gh-account list with a confirmation micro-interaction: the button
 * settles Refresh → Refreshing… → Updated ✓ → Refresh, so the action reads as
 * done even when the list is unchanged (the silent re-render gives no signal on
 * its own). Motion contract: label + a 150ms colour crossfade only, no
 * transform; the global prefers-reduced-motion block zeroes the fade. The
 * `refreshing` flag guards re-entry while the ~1.6s confirmation is showing.
 */
function refreshGhAccounts(button: HTMLButtonElement): void {
  if (button.dataset.refreshing === "true") return;
  button.dataset.refreshing = "true";
  button.disabled = true;
  button.classList.remove("btn--confirmed");
  button.textContent = "Refreshing…";
  // loadGhAccounts is best-effort and resolves even on failure (it just hides
  // the section), so `finally` is the single settle point either way.
  void loadGhAccounts().finally(() => {
    button.disabled = false;
    button.classList.add("btn--confirmed");
    button.textContent = "Updated ✓";
    window.setTimeout(() => {
      button.classList.remove("btn--confirmed");
      button.textContent = "Refresh";
      button.dataset.refreshing = "false";
    }, 1600);
  });
}

/**
 * Adopt a gh account: POST /gh/use writes its token to the store, then we
 * reboot the sidecar so it boots signed-in (the restart re-drives
 * loadAuthStatus → authenticated). One sign-in at a time: every sign-in
 * button is disabled while this is in flight.
 */
async function useGhAccount(button: HTMLElement): Promise<void> {
  const login = button.dataset.ghLogin;
  const host = button.dataset.ghHost;
  if (!login || !host) return;

  const row = button.closest<HTMLElement>(".gh-account");
  const signInButtons = document.querySelectorAll<HTMLButtonElement>(
    '[data-section="account"] [data-action="gh-use"], [data-section="account"] [data-action="auth-start"]',
  );
  const buttonEl = button as HTMLButtonElement;
  const originalLabel = buttonEl.textContent;

  hideGhError();
  buttonEl.textContent = "Signing in…";
  row?.setAttribute("aria-busy", "true");
  for (const b of signInButtons) b.disabled = true;
  setBusy(true, "Signing in…"); // ambient top-of-window indicator

  const result = await apiCall({
    kind: "gh-use",
    method: "POST",
    path: "/settings/api/gh/use",
    body: { login, host },
  });

  if (!result.ok) {
    setBusy(false);
    for (const b of signInButtons) b.disabled = false;
    buttonEl.textContent = originalLabel;
    row?.removeAttribute("aria-busy");
    // The pre-flight (POST /gh/use) returns a specific reason — stale token,
    // no Copilot subscription, etc. — caught BEFORE any reboot. Show it.
    showGhError(
      apiErrorMessage(result.error) ||
        "Couldn't sign in with that account. Try the code-based sign-in above.",
    );
    buttonEl.focus();
    return;
  }

  // Token written. Reboot into it, then report the result (success switches
  // off the unauthenticated card; failure recovers the row WITHOUT a full
  // re-render, which would re-fetch the gh list and clear the message).
  await rebootAndAwaitAuth(
    (status) => {
      setBusy(false);
      renderAccount(status);
    },
    (sawDown) => {
      setBusy(false);
      for (const b of signInButtons) b.disabled = false;
      buttonEl.textContent = originalLabel;
      row?.removeAttribute("aria-busy");
      showGhError(
        sawDown ?
          `Signed in as ${login}, but the proxy came back unauthenticated — that account may not have Copilot access on this host.`
        : "Sign-in didn't complete — the proxy may not have restarted. Try again, or use the code-based sign-in above.",
      );
      buttonEl.focus();
    },
  );
}

/**
 * Reboot the sidecar and poll auth-status until it's back, then dispatch to
 * onSuccess (now authenticated) or onFailure. Shared by every
 * "write token to disk → reboot into it" flow (gh-reuse, account switch).
 * The sidecar is briefly DOWN mid-reboot — failed polls are expected and tell
 * us a restart actually happened (`sawDown`). safeInvoke no-ops in
 * plain-browser (app:ui), so the loop just times out and onFailure fires.
 */
async function rebootAndAwaitAuth(
  onSuccess: (status: AuthStatus) => void,
  onFailure: (sawDown: boolean) => void,
): Promise<void> {
  // If the restart IPC itself didn't fire (invoke rejected / unavailable),
  // the proxy will never reboot — fail fast and visibly rather than polling a
  // never-changing status for 20s. `sawDown: false` → the "didn't restart"
  // branch of the caller's message.
  const restarted = await safeInvoke("restart_sidecar");
  if (!restarted) {
    onFailure(false);
    return;
  }
  const deadlineMs = Date.now() + 20_000;
  let sawDown = false;
  while (Date.now() < deadlineMs) {
    await new Promise((resolve) => setTimeout(resolve, 1200));
    const poll = await apiCall({
      kind: "auth-status",
      method: "GET",
      path: "/settings/api/auth/github/status",
    });
    if (!poll.ok) {
      sawDown = true; // sidecar is restarting
      continue;
    }
    if (poll.data.state === "authenticated") {
      onSuccess(poll.data);
      return;
    }
    if (poll.data.state === "error" || sawDown) break;
    // Still up + unauthenticated and never saw it go down — the restart likely
    // didn't fire yet. Keep polling until the deadline.
  }
  onFailure(sawDown);
}

// ---- Multi-account roster (quick-switch) ---------------------------------

/** Which roster a row lives in: the authenticated "Switch to" list, or the
 *  unauthenticated "remembered accounts" list. They share a row template but
 *  have distinct list/error containers. */
type AccountRosterMode = "roster" | "remembered";

const ROSTER_SELECTORS: Record<
  AccountRosterMode,
  { wrapper: string; list: string; error: string }
> = {
  roster: {
    wrapper: "[data-account-roster]",
    list: "[data-account-roster-list]",
    error: "[data-account-roster-error]",
  },
  remembered: {
    wrapper: "[data-account-remembered]",
    list: "[data-account-remembered-list]",
    error: "[data-account-remembered-error]",
  },
};

function rosterModeFor(el: HTMLElement): AccountRosterMode {
  return el.closest("[data-account-remembered]") ? "remembered" : "roster";
}

function showRosterError(mode: AccountRosterMode, message: string): void {
  const el = document.querySelector<HTMLElement>(ROSTER_SELECTORS[mode].error);
  if (el) {
    el.textContent = message;
    el.hidden = false;
    el.scrollIntoView({ block: "nearest" });
  }
}

function hideRosterError(mode: AccountRosterMode): void {
  const el = document.querySelector<HTMLElement>(ROSTER_SELECTORS[mode].error);
  if (el) {
    el.textContent = "";
    el.hidden = true;
  }
}

/**
 * Populate a roster list from GET /settings/api/accounts. The authenticated
 * "roster" excludes the active account (it's the hero); the unauthenticated
 * "remembered" list shows all. Best-effort: any failure / empty list just
 * hides the section, mirroring loadGhAccounts.
 */
async function loadAccounts(mode: AccountRosterMode): Promise<void> {
  const sel = ROSTER_SELECTORS[mode];
  const wrapper = document.querySelector<HTMLElement>(sel.wrapper);
  const list = document.querySelector<HTMLUListElement>(sel.list);
  const template = document.querySelector<HTMLTemplateElement>(
    "[data-account-row-template]",
  );
  if (!wrapper || !list || !template) return;

  const result = await apiCall({
    kind: "accounts-list",
    method: "GET",
    path: "/settings/api/accounts",
  });
  const accounts =
    result.ok ?
      mode === "roster" ?
        result.data.accounts.filter((a) => !a.active)
      : result.data.accounts
    : [];

  if (accounts.length === 0) {
    wrapper.hidden = true;
    list.replaceChildren();
    return;
  }

  list.replaceChildren();
  hideRosterError(mode);
  for (const account of accounts) {
    const seed = template.content.firstElementChild;
    if (!seed) continue;
    const row = seed.cloneNode(true) as HTMLElement;

    const loginEl = row.querySelector<HTMLElement>('[data-field="acct_login"]');
    if (loginEl) loginEl.textContent = account.login;
    const hostEl = row.querySelector<HTMLElement>('[data-field="acct_host"]');
    if (hostEl) hostEl.textContent = account.host;

    for (const action of ["account-switch", "account-remove"] as const) {
      const btn = row.querySelector<HTMLButtonElement>(
        `[data-action="${action}"]`,
      );
      if (!btn) continue;
      btn.dataset.acctKey = account.key;
      const verb = action === "account-switch" ? "Switch to" : "Remove";
      btn.setAttribute("aria-label", `${verb} ${account.login}`);
    }
    list.appendChild(row);
  }
  wrapper.hidden = false;
}

/**
 * Switch the active account: POST /accounts/switch sets it, then we reboot the
 * sidecar so it boots signed-in as that account — the same write-then-reboot
 * poll loop as useGhAccount. A 422 (token no longer valid) is caught BEFORE
 * the reboot and shown in the roster's error line.
 */
async function switchToAccount(button: HTMLElement): Promise<void> {
  const key = button.dataset.acctKey;
  if (!key) return;
  const mode = rosterModeFor(button);
  const row = button.closest<HTMLElement>(".gh-account");
  const buttons = document.querySelectorAll<HTMLButtonElement>(
    '[data-section="account"] [data-action="account-switch"], [data-section="account"] [data-action="account-remove"]',
  );
  const buttonEl = button as HTMLButtonElement;
  const originalLabel = buttonEl.textContent;

  hideRosterError(mode);
  buttonEl.textContent = "Switching…";
  row?.setAttribute("aria-busy", "true");
  for (const b of buttons) b.disabled = true;
  setBusy(true, "Switching account…");

  const result = await apiCall({
    kind: "accounts-switch",
    method: "POST",
    path: "/settings/api/accounts/switch",
    body: { key },
  });

  if (!result.ok) {
    setBusy(false);
    for (const b of buttons) b.disabled = false;
    buttonEl.textContent = originalLabel;
    row?.removeAttribute("aria-busy");
    // 422 = the saved token no longer works for Copilot; caught pre-reboot.
    showRosterError(
      mode,
      apiErrorMessage(result.error) || "Couldn't switch to that account.",
    );
    buttonEl.focus();
    return;
  }

  await rebootAndAwaitAuth(
    (status) => {
      setBusy(false);
      renderAccount(status);
    },
    (sawDown) => {
      setBusy(false);
      for (const b of buttons) b.disabled = false;
      buttonEl.textContent = originalLabel;
      row?.removeAttribute("aria-busy");
      showRosterError(
        mode,
        sawDown ?
          "Switched, but the proxy came back unauthenticated — that account's token may no longer be valid."
        : "Switch didn't complete — the proxy may not have restarted. Try again.",
      );
      buttonEl.focus();
    },
  );
}

/**
 * Forget a persisted account: POST /accounts/remove deletes maximal's own copy
 * of its token (gh is untouched). Removing a non-active account needs no reboot
 * — just re-render the shorter list.
 */
async function forgetAccount(button: HTMLElement): Promise<void> {
  const key = button.dataset.acctKey;
  if (!key) return;
  const mode = rosterModeFor(button);
  const login =
    button
      .closest(".gh-account")
      ?.querySelector('[data-field="acct_login"]')?.textContent ?? key;

  const confirmed = window.confirm(
    `Remove ${login}? Maximal forgets its saved sign-in. This doesn't sign you out of gh or GitHub in the browser.`,
  );
  if (!confirmed) return;

  const buttons = document.querySelectorAll<HTMLButtonElement>(
    '[data-section="account"] [data-action="account-switch"], [data-section="account"] [data-action="account-remove"]',
  );
  for (const b of buttons) b.disabled = true;
  setBusy(true, "Removing account…");

  const result = await apiCall({
    kind: "accounts-remove",
    method: "POST",
    path: "/settings/api/accounts/remove",
    body: { key },
  });

  setBusy(false);
  for (const b of buttons) b.disabled = false;

  if (!result.ok) {
    showRosterError(
      mode,
      apiErrorMessage(result.error) || "Couldn't remove that account.",
    );
    return;
  }
  // Re-render the now-shorter list (hides the section if it's the last one).
  void loadAccounts(mode);
}

async function pollAuthStatus(): Promise<void> {
  // Stop if the user navigated away while a poll was in flight.
  if (readHashSection() !== "account") {
    stopAuthPolling();
    return;
  }
  const result = await apiCall({
    kind: "auth-status",
    method: "GET",
    path: "/settings/api/auth/github/status",
  });
  if (readHashSection() !== "account") {
    // Navigated away mid-request; drop the response.
    stopAuthPolling();
    return;
  }
  if (!result.ok) {
    renderAccount({
      state: "error",
      error: `Polling failed: ${result.error}`,
    });
    return;
  }
  renderAccount(result.data);
}

async function startAuth(): Promise<void> {
  stopAuthPolling();
  // Show the ambient busy bar while the device-code request is in flight —
  // matches signOut/useGhAccount, so no action fires without feedback.
  setBusy(true, "Starting sign-in…");
  const result = await apiCall({
    kind: "auth-start",
    method: "POST",
    path: "/settings/api/auth/github/start",
  }).finally(() => {
    setBusy(false);
  });
  if (!result.ok) {
    renderAccount({
      state: "error",
      error: `Couldn't start sign-in: ${result.error}`,
    });
    return;
  }
  renderAccount(result.data);
}

/**
 * Bail out of an in-progress device-code flow WITHOUT signing out. Issuing a
 * code never dropped the current session (server-side), so cancelling returns
 * to whatever was there before: the account you were signed into, or the
 * sign-in screen on a first-run cancel. POST /cancel aborts the server-side
 * poller and reports the restored status; we render whatever it returns.
 */
async function cancelAuth(): Promise<void> {
  stopAuthPolling();
  const result = await apiCall({
    kind: "auth-cancel",
    method: "POST",
    path: "/settings/api/auth/github/cancel",
  });
  if (!result.ok) {
    renderAccount({
      state: "error",
      error: `Couldn't cancel: ${result.error}`,
    });
    return;
  }
  renderAccount(result.data);
}

async function signOut(): Promise<void> {
  const confirmed = window.confirm(
    "Sign out? The proxy will restart and stop forwarding Copilot requests until you sign in again.",
  );
  if (!confirmed) return;
  const ok = await performSignOut();
  if (!ok) return;
  // The on-disk token is now deleted. Reboot the sidecar rather than editing
  // the running instance: the fresh process boots unauthenticated with a clean
  // runtime (no leftover Copilot token-refresh loop, no stale cached model
  // list from the signed-out account). Optimistically show the signed-out view
  // — the token is already gone; the shell's Starting→Ready status carries the
  // proxy back up. `safeInvoke` no-ops gracefully in plain-browser (app:ui).
  renderAccount({ state: "unauthenticated" });
  setBusy(true, "Signing out…");
  try {
    await safeInvoke("restart_sidecar");
    // Keep the indicator up until the sidecar is back (briefly down mid-reboot)
    // so the bar reflects the real "restarting" window, not just the IPC call.
    await waitForSidecarBack(8_000);
  } finally {
    setBusy(false);
  }
}

/** Poll auth-status until the sidecar responds again (it's down mid-reboot),
 *  up to `timeoutMs`. Used to keep the busy indicator honest across a restart
 *  without changing what's rendered. */
async function waitForSidecarBack(timeoutMs: number): Promise<void> {
  const deadlineMs = Date.now() + timeoutMs;
  let sawDown = false;
  while (Date.now() < deadlineMs) {
    await new Promise((resolve) => setTimeout(resolve, 800));
    const poll = await apiCall({
      kind: "auth-status",
      method: "GET",
      path: "/settings/api/auth/github/status",
    });
    if (!poll.ok) {
      sawDown = true; // restarting
      continue;
    }
    if (sawDown) return; // went down and came back → reboot complete
  }
}

/**
 * Shared sign-out path used by both the explicit "Sign out" button and
 * the "Sign in as a different account" affordance. Returns true on
 * success so the caller can decide whether to continue (e.g. start a
 * fresh device flow) or surface an error.
 */
async function performSignOut(): Promise<boolean> {
  stopAuthPolling();
  const result = await apiCall({
    kind: "auth-sign-out",
    method: "POST",
    path: "/settings/api/auth/github/sign-out",
  });
  if (!result.ok) {
    renderAccount({
      state: "error",
      error: `Sign-out failed: ${result.error}`,
    });
    return false;
  }
  return true;
}

/**
 * Start a fresh device flow to sign in as a different account. The intent is
 * "let me add/switch to another account" — no confirm dialog (the user picked
 * the action explicitly), no intermediate empty state (we go straight to the
 * pending code screen). Crucially we do NOT sign out first: the current
 * account stays live until the new sign-in SUCCEEDS (→ switches to it) or the
 * user cancels (→ stays on the current account). Issuing a code is not a
 * commitment.
 */
async function switchAccount(): Promise<void> {
  await startAuth();
}

// One-shot button: copy code to clipboard, then open verification URL.
// Brief on-button flash confirms the clipboard write — it's the only
// feedback the user gets before the system browser takes focus.
const SIGN_IN_FLASH_MS = 1200;

async function openExternalUrl(url: string): Promise<void> {
  try {
    // Tauri v2 opener plugin is registered (opener:default). Call its
    // `open_url` command directly via invoke so we don't need to add a
    // new JS dep just for this one site.
    await openUrl(url);
  } catch (err) {
    // Plain-browser fallback (e.g. `bun run app:ui` mode) and last resort
    // if the plugin command is unavailable for any reason.
    console.warn("opener plugin unavailable, falling back to window.open", err);
    window.open(url, "_blank", "noopener,noreferrer");
  }
}

async function signInWithCode(button: HTMLElement): Promise<void> {
  // Narrow to the pending variants — code + url only exist there. If
  // the button somehow fires from another state, no-op.
  const status = currentAuthStatus;
  if (
    !status
    || (status.state !== "device_code_issued" && status.state !== "polling")
  ) {
    return;
  }
  const code = status.user_code;
  const url = status.verification_uri;

  const label = button.querySelector<HTMLElement>(".device-code-button__label");
  const original = label?.innerHTML ?? null;

  let copied = false;
  try {
    await navigator.clipboard.writeText(code);
    copied = true;
  } catch (err) {
    // Insecure context, denied permission, or no clipboard API. Surface
    // the code on the button so the user can still copy it manually.
    console.error("clipboard write failed", err);
    if (label) {
      label.textContent = `Copy ${code} manually — opening GitHub…`;
    }
  }

  if (copied && label) {
    label.textContent = "Copied · Opening GitHub…";
  }

  await openExternalUrl(url);

  if (label && original !== null) {
    window.setTimeout(() => {
      // Only restore if the pending state is still rendered (label still
      // in the DOM). Otherwise we'd flash text into a torn-down node.
      if (document.body.contains(label)) {
        label.innerHTML = original;
      }
    }, SIGN_IN_FLASH_MS);
  }
}

function wireAccount(): void {
  const section = document.querySelector('[data-section="account"]');
  if (!section) return;
  section.addEventListener("click", (ev) => {
    const target = ev.target;
    if (!(target instanceof HTMLElement)) return;
    const button = target.closest<HTMLElement>("[data-action]");
    if (!button) return;
    const action = button.dataset.action;
    switch (action) {
      case "auth-start":
        void startAuth();
        break;
      case "sign-out":
        void signOut();
        break;
      case "switch-account":
        void switchAccount();
        break;
      case "sign-in-with-code":
        void signInWithCode(button);
        break;
      case "cancel-auth":
        void cancelAuth();
        break;
      case "gh-use":
        void useGhAccount(button);
        break;
      case "gh-refresh":
        if (button instanceof HTMLButtonElement) refreshGhAccounts(button);
        break;
      case "account-switch":
        void switchToAccount(button);
        break;
      case "account-remove":
        void forgetAccount(button);
        break;
      default:
        break;
    }
  });
}

window.addEventListener("DOMContentLoaded", () => {
  applyTheme();
  wireLogs();
  wireDiagnostics();
  wireAccount();
  wireEndpoint();
  wireUninstall();
  mountApiClients();
  mountApps();
  mountModels();
  wireNav();
  syncFromHash();
  void loadDiagnostics();
  if (readHashSection() === "account") {
    void loadAuthStatus();
    openAuthEvents();
  }
});

window.addEventListener("hashchange", () => {
  syncFromHash();
  const section = readHashSection();
  if (section === "diagnostics") void loadDiagnostics();
  if (section === "apps") {
    window.dispatchEvent(new CustomEvent("maximal:apps-refresh"));
  }
  if (section === "models") {
    window.dispatchEvent(new CustomEvent("maximal:models-refresh"));
  }
  if (section === "account") {
    void loadAuthStatus();
    openAuthEvents();
  } else {
    // Leaving the Account section: drop any in-flight polling, the live
    // event stream, and the uptime ticker (all re-established on return).
    stopAuthPolling();
    closeAuthEvents();
    stopConnUptimeTicker();
  }
});

// Refresh on returning to the window. The common flow is: open the Account
// section here, switch to a terminal, `gh auth login` (or out) of an account,
// then switch back — re-loading auth status on focus re-runs gh discovery so
// the new account appears without leaving + re-entering the section. We do NOT
// poll (gh auth status touches the OS keyring); focus/visibility is the right
// "moment of attention" to refresh.
function refreshAccountOnAttention(): void {
  if (readHashSection() === "account") void loadAuthStatus();
}
window.addEventListener("focus", refreshAccountOnAttention);
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") refreshAccountOnAttention();
});
