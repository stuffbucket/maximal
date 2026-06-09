import { invoke } from "@tauri-apps/api/core";

import type { DiagnosticsResponse } from "../../src/lib/settings-types";
import type { AuthStatus } from "./api";
import { apiCall } from "./api";
import { mountApiClients } from "./api-clients-island";
import { mountApps } from "./apps-island";

type SectionId =
  | "account"
  | "apps"
  | "endpoint"
  | "api-clients"
  | "logs"
  | "diagnostics";

const SECTIONS: ReadonlyArray<SectionId> = [
  "account",
  "apps",
  "endpoint",
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

// ---- Endpoint section ------------------------------------------------------

const ENDPOINT_BASE_URL = "http://127.0.0.1:4141";
let endpointApiKey: string | null = null;

async function loadEndpointApiKey(): Promise<void> {
  if (endpointApiKey !== null) return;
  try {
    endpointApiKey = await invoke<string>("get_shell_api_key");
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

function wireUninstall(): void {
  const section = document.querySelector('[data-section="diagnostics"]');
  if (!section) return;
  section
    .querySelector('[data-action="copy-uninstall-cmd"]')
    ?.addEventListener("click", (ev) => {
      void copyToClipboard(
        "maximal uninstall --revert-claude",
        ev.currentTarget as Element,
      );
    });
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
  setField("pid", String(data.pid));
  setField("uptime", formatUptime(data.uptime_ms));
  setField("account_type", data.account_type ?? "unknown");
  setField("models_cached", String(data.models_cached));
  setField("github_copilot_status", deriveGithubCopilotStatus(data.tokens));
  setField("rate_limit", formatRateLimit(data.rate_limit));
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

/**
 * Render the GitHub avatar for the signed-in user. GitHub serves
 * a public PNG at https://github.com/<login>.png — no API, no auth.
 * We swap in an <img>; on load-failure (404, offline) we fall back
 * to a typographic placeholder showing the user's first initial,
 * so the layout never collapses.
 */
function renderAccountAvatar(login: string): void {
  const slot = accountSlot("account_avatar");
  if (!slot) return;
  // "(unknown)" is the sentinel renderAccount() substitutes when the proxy
  // reports authenticated without a login. Treat it (and an empty string)
  // as "no real login" so the placeholder shows a neutral "?" rather than
  // the sentinel's first character "(".
  const isPlaceholder = !login || login === "(unknown)";
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
  img.src = `https://github.com/${encodeURIComponent(login)}.png?size=128`;
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
  rejection: AuthStatus["last_upstream_rejection"],
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
    const login = status.account_login ?? "(unknown)";
    setAccountField("account_login", login);
    renderAccountAvatar(login);
    renderUpstreamRejection(status.last_upstream_rejection);
  } else if (active === "error") {
    setAccountField("error", status.error ?? "Unknown error.");
    renderRemediationLink(status.remediation_url);
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
  await performSignOut();
  await loadAuthStatus();
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
 * Sign out + immediately start a fresh device flow. The intent is
 * "let me re-auth with a different account" — no confirm dialog
 * (the user picked the action explicitly), no intermediate empty
 * state (we go straight to the pending code screen).
 */
async function switchAccount(): Promise<void> {
  const ok = await performSignOut();
  if (!ok) return;
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
      case "switch-account":
        void switchAccount();
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
  wireEndpoint();
  wireUninstall();
  mountApiClients();
  mountApps();
  wireNav();
  syncFromHash();
  void loadDiagnostics();
  if (readHashSection() === "account") void loadAuthStatus();
});

window.addEventListener("hashchange", () => {
  syncFromHash();
  const section = readHashSection();
  if (section === "diagnostics") void loadDiagnostics();
  if (section === "apps") {
    window.dispatchEvent(new CustomEvent("maximal:apps-refresh"));
  }
  if (section === "account") {
    void loadAuthStatus();
  } else {
    // Leaving the Account section: drop any in-flight polling.
    stopAuthPolling();
  }
});
