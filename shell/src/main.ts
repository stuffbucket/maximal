import { invoke } from "@tauri-apps/api/core";

import type { DiagnosticsResponse } from "../../src/lib/settings-types";
import type { AuthStatus } from "./api";
import { apiCall } from "./api";
import { mountApiClients } from "./api-clients-island";
import { mountQuitConfirm } from "./quit-island";

type SectionId =
  | "account"
  | "api-clients"
  | "logs"
  | "diagnostics";

const SECTIONS: ReadonlyArray<SectionId> = [
  "account",
  "api-clients",
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

async function safeInvoke(cmd: string): Promise<void> {
  try {
    await invoke(cmd);
  } catch (err) {
    // Tauri command unavailable (e.g. running in plain browser). Log and continue.
    console.warn(`invoke(${cmd}) failed:`, err);
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
  setField("pid", String(data.pid));
  setField("uptime", formatUptime(data.uptime_ms));
  setField("account_type", data.account_type ?? "unknown");
  setField("models_cached", String(data.models_cached));
  setField("github_token", data.tokens.github_token_present ? "present" : "missing");
  setField("copilot_token", data.tokens.copilot_token_present ? "present" : "missing");
  setField("rate_limit", formatRateLimit(data.rate_limit));
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
 * Polling cleanup contract:
 *  - Only one poll timer runs at a time (`authPollTimer`).
 *  - `stopAuthPolling()` clears the timer; called on terminal states
 *    (authenticated, error, unauthenticated), on sign-out, and on
 *    navigation away from #account.
 *  - `renderAccount` is the single source of truth for visibility;
 *    a non-pending state always stops polling before the next call.
 */
type AccountStateKey = "unauthenticated" | "pending" | "authenticated" | "error";

const POLL_INTERVAL_MS = 2000;

let currentAuthStatus: AuthStatus | null = null;
let authPollTimer: ReturnType<typeof setTimeout> | null = null;

function stopAuthPolling(): void {
  if (authPollTimer !== null) {
    clearTimeout(authPollTimer);
    authPollTimer = null;
  }
}

function schedulePoll(): void {
  stopAuthPolling();
  authPollTimer = setTimeout(() => {
    authPollTimer = null;
    void pollAuthStatus();
  }, POLL_INTERVAL_MS);
}

function accountKeyFor(state: AuthStatus["state"]): AccountStateKey {
  if (state === "device_code_issued" || state === "polling") return "pending";
  if (state === "authenticated") return "authenticated";
  if (state === "error") return "error";
  return "unauthenticated";
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

function formatExpiresAt(iso: string | undefined): string {
  if (!iso) return "soon";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleTimeString();
}

function renderAccount(status: AuthStatus): void {
  currentAuthStatus = status;
  const active = accountKeyFor(status.state);

  for (const card of document.querySelectorAll<HTMLElement>(
    "[data-state-account]",
  )) {
    card.hidden = card.dataset.stateAccount !== active;
  }

  if (active === "pending") {
    setAccountField("user_code", status.user_code ?? "…");
    setAccountField("expires_at", formatExpiresAt(status.expires_at));
    const link = accountSlot("verification_uri");
    if (link instanceof HTMLAnchorElement) {
      const uri = status.verification_uri ?? "https://github.com/login/device";
      link.href = uri;
      link.textContent = uri.replace(/^https?:\/\//, "");
    }
  } else if (active === "authenticated") {
    setAccountField("account_login", status.account_login ?? "(unknown)");
  } else if (active === "error") {
    setAccountField("error", status.error ?? "Unknown error.");
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
  const result = await apiCall({
    kind: "auth-start",
    method: "POST",
    path: "/settings/api/auth/github/start",
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

async function signOut(): Promise<void> {
  const confirmed = window.confirm(
    "Sign out? The proxy will stop forwarding Copilot requests until you sign in again.",
  );
  if (!confirmed) return;
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
    return;
  }
  await loadAuthStatus();
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
    await invoke("plugin:opener|open_url", { url });
  } catch (err) {
    // Plain-browser fallback (e.g. `bun run app:ui` mode) and last resort
    // if the plugin command is unavailable for any reason.
    console.warn("opener plugin unavailable, falling back to window.open", err);
    window.open(url, "_blank", "noopener,noreferrer");
  }
}

async function signInWithCode(button: HTMLElement): Promise<void> {
  const code = currentAuthStatus?.user_code;
  const url = currentAuthStatus?.verification_uri;
  if (!code || !url) return;

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
      case "sign-in-with-code":
        void signInWithCode(button);
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
  mountApiClients();
  mountQuitConfirm();
  wireNav();
  syncFromHash();
  void loadDiagnostics();
  if (readHashSection() === "account") void loadAuthStatus();
});

window.addEventListener("hashchange", () => {
  syncFromHash();
  const section = readHashSection();
  if (section === "diagnostics") void loadDiagnostics();
  if (section === "account") {
    void loadAuthStatus();
  } else {
    // Leaving the Account section: drop any in-flight polling.
    stopAuthPolling();
  }
});
