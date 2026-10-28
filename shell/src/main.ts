import { invoke } from "@tauri-apps/api/core";

import { t } from "./i18n";
import { applyI18n, wireLocalePicker } from "./i18n/apply";
import {
  getDockVisibility,
  getShellApiKey,
  installUpdate,
  openUrl,
  safeInvoke,
  setDockVisibility,
  updateInstallsInPlace,
} from "./tauri/shell";
import { osKind } from "./ui/platform";


import type {
  DiagnosticsResponse,
  UpdateStatusResponse,
} from "../../src/lib/config/settings-types";
import type { AuthStatus, EventSubscription, UpstreamRejection } from "./proxy/client";
import { apiCall, subscribeAuthEvents } from "./proxy/client";
import { mountApiClients } from "./ui/islands/api-clients-island";
import { mountApps } from "./ui/islands/apps-island";
import { mountMcp } from "./ui/islands/mcp-island";
import { mountModels } from "./ui/islands/models-island";
import { mountRequests } from "./ui/islands/requests-island";
import { waitForSidecarBack } from "./ui/restart";

type SectionId =
  | "account"
  | "integrations"
  | "models-keys"
  | "appearance"
  | "system"
  | "dashboard"
  | "apps"
  | "mcp"
  | "requests"
  | "endpoint"
  | "api-clients"
  | "models"
  | "logs"
  | "diagnostics";

type TopTabId =
  | "account"
  | "integrations"
  | "models-keys"
  | "appearance"
  | "system"
  | "dashboard";

const SECTIONS: ReadonlyArray<SectionId> = [
  "account",
  "integrations",
  "models-keys",
  "appearance",
  "system",
  "dashboard",
  "apps",
  "mcp",
  "requests",
  "endpoint",
  "api-clients",
  "models",
  "logs",
  "diagnostics",
];

const TAB_SECTIONS: Record<TopTabId, ReadonlyArray<string>> = {
  account: ["account"],
  integrations: ["apps", "mcp", "requests"],
  "models-keys": ["models", "endpoint", "api-clients"],
  appearance: ["appearance"],
  system: ["diagnostics", "logs"],
  dashboard: ["dashboard"],
};

const LAST_TAB_STORAGE_KEY = "maximal.lastTab";
const LAST_SETTINGS_TAB_STORAGE_KEY = "maximal.lastSettingsTab";
const DEFAULT_SECTION: SectionId = "account";
let userExplicitlySelectedTab = false;

function isSectionId(value: string): value is SectionId {
  return (SECTIONS as ReadonlyArray<string>).includes(value);
}

function tabForSection(id: SectionId): TopTabId {
  switch (id) {
    case "account":
      return "account";
    case "integrations":
    case "apps":
    case "mcp":
    case "requests":
      return "integrations";
    case "models-keys":
    case "models":
    case "endpoint":
    case "api-clients":
      return "models-keys";
    case "appearance":
      return "appearance";
    case "system":
    case "diagnostics":
    case "logs":
      return "system";
    case "dashboard":
      return "dashboard";
  }
}

function getStoredTab(key: string): SectionId | null {
  try {
    const val = window.localStorage.getItem(key);
    if (val && isSectionId(val)) return val;
  } catch {
    // ignore storage errors
  }
  return null;
}

function persistTabSelection(tab: TopTabId): void {
  try {
    window.localStorage.setItem(LAST_TAB_STORAGE_KEY, tab);
    if (tab !== "dashboard") {
      window.localStorage.setItem(LAST_SETTINGS_TAB_STORAGE_KEY, tab);
    }
  } catch {
    // ignore storage errors
  }
}

function hasAccountProblem(status: AuthStatus | null = currentAuthStatus): boolean {
  if (!status) return false;
  return (
    status.state !== "authenticated"
    || status.last_upstream_rejection !== undefined
  );
}

function updateSurfaceModeButton(isDashboard: boolean): void {
  const btn = document.querySelector<HTMLButtonElement>(
    "[data-surface-mode-btn]",
  );
  const dashIcon = document.querySelector<Element>(
    '[data-mode-icon="dashboard"]',
  );
  const settingsIcon = document.querySelector<Element>(
    '[data-mode-icon="settings"]',
  );
  dashIcon?.toggleAttribute("hidden", isDashboard);
  settingsIcon?.toggleAttribute("hidden", !isDashboard);
  if (btn) {
    btn.dataset.surfaceMode = isDashboard ? "dashboard" : "settings";
    const isMac = osKind() === "macos";
    const label =
      isDashboard ?
        t("nav-switch-to-settings", { shortcut: isMac ? "⌘," : "Ctrl+," })
      : t("nav-switch-to-dashboard", { shortcut: isMac ? "⌘D" : "Ctrl+D" });
    btn.title = label;
    btn.setAttribute("aria-label", label);
  }
  const localeSelect = document.getElementById(
    "locale-select",
  ) as HTMLSelectElement | null;
  if (localeSelect) {
    localeSelect.title = localeSelect.selectedOptions[0]?.textContent ?? "";
  }
}

function showSection(
  id: SectionId,
  options: { persist?: boolean } = {},
): void {
  const tab = tabForSection(id);
  const visibleSections = new Set(TAB_SECTIONS[tab]);
  const isDashboard = tab === "dashboard";

  if (options.persist !== false) {
    persistTabSelection(tab);
  }

  const frame = document.querySelector<HTMLIFrameElement>(
    "[data-dashboard-frame]",
  );
  frame?.contentWindow?.postMessage(
    { type: "maximal:dashboard-visibility", visible: isDashboard },
    window.location.origin,
  );

  const settingsNav = document.querySelector<HTMLElement>("[data-settings-nav]");
  const dashControls = document.querySelector<HTMLElement>(
    "[data-dashboard-controls]",
  );
  if (settingsNav) settingsNav.hidden = isDashboard;
  if (dashControls) dashControls.hidden = !isDashboard;
  updateSurfaceModeButton(isDashboard);

  for (const sec of document.querySelectorAll<HTMLElement>("[data-section]")) {
    const secId = sec.dataset.section ?? "";
    sec.hidden = !visibleSections.has(secId);
  }
  for (const link of document.querySelectorAll<HTMLAnchorElement>(
    "[data-nav]",
  )) {
    const active = link.dataset.nav === tab;
    link.setAttribute("aria-current", active ? "page" : "false");
    link.classList.toggle("nav__item--active", active);
  }

  const pane = document.getElementById("pane");
  if (pane) {
    pane.classList.toggle("pane--dashboard", isDashboard);
    if (id !== tab && visibleSections.has(id)) {
      const targetEl = document.querySelector<HTMLElement>(
        `[data-section="${id}"]`,
      );
      if (targetEl) {
        targetEl.scrollIntoView({ block: "start" });
        return;
      }
    }
    pane.scrollTop = 0;
  }
}

function readHashSection(): SectionId {
  const raw = window.location.hash.replace(/^#/, "");
  if (isSectionId(raw)) return raw;
  if (hasAccountProblem()) return "account";
  return getStoredTab(LAST_TAB_STORAGE_KEY) ?? DEFAULT_SECTION;
}

function syncFromHash(options: { persist?: boolean } = {}): void {
  showSection(readHashSection(), options);
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
      userExplicitlySelectedTab = true;
      if (window.location.hash !== `#${id}`) {
        window.location.hash = id;
      } else {
        showSection(id);
      }
    });
  }

  const modeBtn = document.querySelector<HTMLButtonElement>(
    "[data-surface-mode-btn]",
  );
  modeBtn?.addEventListener("click", () => {
    userExplicitlySelectedTab = true;
    const currentTab = tabForSection(readHashSection());
    if (currentTab === "dashboard") {
      const target: SectionId =
        hasAccountProblem() ?
          "account"
        : (getStoredTab(LAST_SETTINGS_TAB_STORAGE_KEY) ?? "account");
      window.location.hash = target;
      showSection(target);
    } else {
      window.location.hash = "dashboard";
      showSection("dashboard");
    }
  });

  for (const btn of document.querySelectorAll<HTMLButtonElement>(
    "[data-dashboard-period]",
  )) {
    btn.addEventListener("click", () => {
      const period = btn.dataset.dashboardPeriod;
      if (!period) return;
      for (const peer of document.querySelectorAll<HTMLButtonElement>(
        "[data-dashboard-period]",
      )) {
        const active = peer === btn;
        peer.setAttribute("aria-pressed", active ? "true" : "false");
        peer.classList.toggle("nav__item--active", active);
      }
      const frame = document.querySelector<HTMLIFrameElement>(
        "[data-dashboard-frame]",
      );
      frame?.contentWindow?.postMessage(
        { type: "maximal:set-period", period },
        window.location.origin,
      );
    });
  }

  window.addEventListener("message", (event: MessageEvent) => {
    if (event.origin !== window.location.origin) return;
    const data = event.data as {
      type?: string;
      period?: string;
      rangeText?: string;
      rangeTitle?: string;
      key?: string;
    } | null;
    if (!data || typeof data !== "object") return;
    if (data.type === "maximal:shortcut") {
      if (data.key === ",") {
        userExplicitlySelectedTab = true;
        const target: SectionId =
          hasAccountProblem() ?
            "account"
          : (getStoredTab(LAST_SETTINGS_TAB_STORAGE_KEY) ?? "account");
        window.location.hash = target;
        showSection(target);
      } else if (data.key?.toLowerCase() === "d") {
        userExplicitlySelectedTab = true;
        window.location.hash = "dashboard";
        showSection("dashboard");
      }
      return;
    }
    if (data.type !== "maximal:dashboard-state") return;
    const rangeEl = document.querySelector<HTMLElement>(
      "[data-dashboard-range]",
    );
    if (rangeEl) {
      rangeEl.textContent = data.rangeText ?? "";
      rangeEl.title = data.rangeTitle ?? "";
    }
    if (data.period) {
      for (const peer of document.querySelectorAll<HTMLButtonElement>(
        "[data-dashboard-period]",
      )) {
        const active = peer.dataset.dashboardPeriod === data.period;
        peer.setAttribute("aria-pressed", active ? "true" : "false");
        peer.classList.toggle("nav__item--active", active);
      }
    }
  });

  window.addEventListener("maximal:open-settings", () => {
    const currentTab = tabForSection(readHashSection());
    if (currentTab === "dashboard") {
      const target: SectionId =
        hasAccountProblem() ?
          "account"
        : (getStoredTab(LAST_SETTINGS_TAB_STORAGE_KEY) ?? "account");
      window.location.hash = target;
      showSection(target);
    }
  });

  window.addEventListener("keydown", (ev: KeyboardEvent) => {
    if (!(ev.metaKey || ev.ctrlKey) || ev.altKey || ev.shiftKey) return;
    if (ev.key === ",") {
      ev.preventDefault();
      userExplicitlySelectedTab = true;
      const target: SectionId =
        hasAccountProblem() ?
          "account"
        : (getStoredTab(LAST_SETTINGS_TAB_STORAGE_KEY) ?? "account");
      window.location.hash = target;
      showSection(target);
    } else if (ev.key.toLowerCase() === "d") {
      ev.preventDefault();
      userExplicitlySelectedTab = true;
      window.location.hash = "dashboard";
      showSection("dashboard");
    }
  });
}

function wireAppearance(): void {
  const toggle = document.querySelector<HTMLInputElement>(
    "[data-dock-visibility-toggle]",
  );
  if (!toggle) return;
  void getDockVisibility().then((mode) => {
    toggle.checked = mode === "always";
  });
  toggle.addEventListener("change", () => {
    void setDockVisibility(toggle.checked ? "always" : "when-window-open");
  });
}


let busyCount = 0;

/**
 * Toggle the ambient "work in progress" indicator (the accent bar across the
 * top of the window). Ref-counted so overlapping transient operations compose
 * correctly — the bar shows while >=1 op is in flight, hides when all settle.
 * Wrap each transient op in setBusy(true, "…") … setBusy(false) (try/finally)
 * so an early return/throw can't leak a stuck bar.
 */
function setBusy(on: boolean, label = t("common-working")): void {
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

/**
 * Re-render the strings that are composed in JS (not filled by applyI18n's
 * attribute sweep) so a live locale switch updates them too: the link/token
 * sentences and any currently-rendered dynamic account state.
 */
function repaintDynamicI18n(): void {
  renderStaticComposites();
  updateSurfaceModeButton(tabForSection(readHashSection()) === "dashboard");
  const frame = document.querySelector<HTMLIFrameElement>(
    "[data-dashboard-frame]",
  );
  frame?.contentWindow?.postMessage(
    { type: "maximal:set-locale" },
    window.location.origin,
  );
  if (currentAuthStatus) renderAccount(currentAuthStatus);
  if (lastDiagnostics) renderDiagnostics(lastDiagnostics);
  if (lastUpdateStatus) renderUpdateStatus(lastUpdateStatus);
}

/**
 * Render the handful of sentences that embed a non-translatable token (a link
 * to another section, a CLI command) — passed as an ICU argument so word order
 * stays translatable, never concatenated (docs/dev/i18n.md). Each formats the
 * message with a private placeholder, then swaps that placeholder for a real
 * DOM node so the token can be a live <a>/<code> rather than flat text.
 */
function renderStaticComposites(): void {
  renderRequirementCallout();
  renderEndpointHint();
  renderLogsCopy();
  renderGhReuseSub();
}

/**
 * Fill an element from an ICU message that carries a single placeholder,
 * substituting a DOM node for that placeholder. The message is formatted with a
 * sentinel string for the placeholder, then split on the sentinel so the two
 * text halves surround the live node — word order comes from the catalog, so a
 * translation that moves the token still renders correctly.
 */
function fillWithNode(
  el: HTMLElement | null,
  key: string,
  placeholder: string,
  node: Node,
  values: Record<string, unknown> = {},
): void {
  if (!el) return;
  // A private-use sentinel unlikely to occur in any translated string.
  const SENTINEL = "";
  const text = t(key, { ...values, [placeholder]: SENTINEL });
  const [before, after = ""] = text.split(SENTINEL);
  el.replaceChildren(
    document.createTextNode(before ?? ""),
    node,
    document.createTextNode(after),
  );
}

function externalLink(href: string, textKey: string): HTMLAnchorElement {
  const a = document.createElement("a");
  a.href = href;
  a.target = "_blank";
  a.rel = "noopener";
  a.textContent = t(textKey);
  return a;
}

function navLink(section: SectionId, textKey: string): HTMLAnchorElement {
  const a = document.createElement("a");
  a.href = `#${section}`;
  a.dataset.nav = section;
  a.textContent = t(textKey);
  // The delegated wireNav() handler binds after this node exists on re-render;
  // for the initial boot the hashchange listener still drives navigation.
  a.addEventListener("click", (ev) => {
    ev.preventDefault();
    if (window.location.hash !== `#${section}`) window.location.hash = section;
    else showSection(section);
  });
  return a;
}

function monoCode(text: string): HTMLElement {
  const code = document.createElement("code");
  code.className = "mono";
  code.textContent = text;
  return code;
}

/** "Maximal forwards requests … {plansLink}." with a live "See plans" link. */
function renderRequirementCallout(): void {
  const el = document.querySelector<HTMLElement>('[data-field="requirement_sub"]');
  fillWithNode(
    el,
    "account-requirement-sub",
    "plansLink",
    externalLink("https://github.com/features/copilot", "account-requirement-plans-link"),
  );
}

/** Endpoint key hint with a live "API keys" link into that section. */
function renderEndpointHint(): void {
  const el = document.querySelector<HTMLElement>('[data-field="endpoint_hint"]');
  fillWithNode(
    el,
    "endpoint-hint",
    "apiKeysLink",
    navLink("api-clients", "endpoint-hint-api-keys-link"),
  );
}

/** gh-reuse sub with a live `gh` <code> token. */
function renderGhReuseSub(): void {
  const el = document.querySelector<HTMLElement>('[data-field="gh_reuse_sub"]');
  fillWithNode(el, "account-gh-reuse-sub", "ghCode", monoCode("gh"));
}

/**
 * "Copy {code} and open GitHub" — the {code} slot is the live user_code span
 * (already in the DOM, populated by renderAccount). We keep that node and
 * rebuild the surrounding text from the catalog so word order stays
 * translatable. Idempotent: re-locates the span (or leaves the label be if the
 * pending state isn't currently mounted).
 */
function renderDeviceCodeLabel(): void {
  const label = document.querySelector<HTMLElement>("[data-device-code-label]");
  const code = document.querySelector<HTMLElement>('[data-field="user_code"]');
  if (!label || !code) return;
  fillWithNode(label, "account-copy-and-open", "code", code);
}

/** Logs section copy: the plural "7-day retention" sub, the `tail -F` hint,
 *  and the "7 days, then deleted…" retention value. */
function renderLogsCopy(): void {
  const sub = document.querySelector<HTMLElement>('[data-field="logs_sub"]');
  if (sub) sub.textContent = t("logs-sub", { n: LOG_RETENTION_DAYS });
  const retention = document.querySelector<HTMLElement>(
    '[data-field="logs_retention_value"]',
  );
  if (retention) {
    retention.textContent = t("logs-retention-value", { n: LOG_RETENTION_DAYS });
  }
  const hint = document.querySelector<HTMLElement>('[data-field="logs_where_hint"]');
  fillWithNode(hint, "logs-where-hint", "tailCmd", monoCode("tail -F"));
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

/** Where clients reach Maximal. The proxy serves this page, so its port is
 *  the one to show: 4141 normally, another one for a dev build started
 *  with MAXIMAL_DEV_PORT. */
const ENDPOINT_BASE_URL = `http://127.0.0.1:${window.location.port || "4141"}`;
/** Log retention window (days). Drives the plural copy in the Logs section. */
const LOG_RETENTION_DAYS = 7;
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
      btn.textContent = t("common-copied");
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
  const purge =
    document.querySelector<HTMLInputElement>("[data-uninstall-purge]")
      ?.checked ?? false;

  // The in-app uninstall always runs with --force (the Rust command adds it):
  // it can't surface the CLI's refuse-while-apps-enabled prompt, so it disables
  // + reverts every app integration through the registry. So "reverts app
  // integrations" is always part of the summary, not an opt-in.
  const clauses = [t("uninstall-clause-integrations")];
  if (purge) clauses.push(t("uninstall-clause-purge"));
  // The connector ("…, and X") is a catalog term, not a hardcoded ", and " —
  // so a language that joins lists differently can override it.
  const tail =
    clauses.length > 1
      ? t("uninstall-summary-tail", { last: clauses.pop() ?? "" })
      : "";
  const summary = `${clauses.join(", ")}${tail}`;
  const confirmed = window.confirm(t("uninstall-confirm", { summary }));
  if (!confirmed) return;

  setUninstallError(null);
  setBusy(true, t("common-working"));
  try {
    await invoke("uninstall_maximal", { purge });
    showUninstallComplete();
  } catch (err) {
    // Tauri rejects with the Err(String) reason from the Rust command, or a
    // generic message in plain-browser (app:ui, no Tauri host). Surface it
    // inline rather than leaving the user with no feedback.
    console.warn("invoke(uninstall_maximal) failed:", err);
    setUninstallError(String(err));
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
  done.textContent = t("uninstall-complete");
  body.replaceChildren(done);
}

function wireEndpoint(): void {
  const section = document.querySelector('[data-section="endpoint"]');
  if (!section) return;

  const baseUrl = section.querySelector('[data-field="endpoint-base-url"]');
  if (baseUrl) baseUrl.textContent = ENDPOINT_BASE_URL;

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
        (ev.currentTarget as HTMLElement).textContent = t("common-reveal");
      } else {
        el.dataset.revealed = "true";
        el.textContent = endpointApiKey ?? t("endpoint-key-not-available");
        (ev.currentTarget as HTMLElement).textContent = t("common-hide");
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

// ---- Diagnostics section ---------------------------------------------------

function formatUptime(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const s = totalSeconds % 60;
  if (h > 0) return t("diagnostics-uptime-hours", { h, m });
  if (m > 0) return t("diagnostics-uptime-minutes", { m, s });
  return t("diagnostics-uptime-seconds", { s });
}

function formatRateLimit(rl: DiagnosticsResponse["rate_limit"]): string {
  if (rl.interval_seconds === null) return t("diagnostics-rate-unlimited");
  const tail = rl.last_request_at
    ? t("diagnostics-rate-last-request", {
        time: new Date(rl.last_request_at).toLocaleTimeString(),
      })
    : "";
  const mode = rl.wait_when_throttled
    ? t("diagnostics-rate-mode-wait")
    : t("diagnostics-rate-mode-reject");
  return t("diagnostics-rate-limited", {
    seconds: rl.interval_seconds,
    mode,
    tail,
  });
}

function setField(name: string, value: string): void {
  const el = document.querySelector<HTMLElement>(`[data-field="${name}"]`);
  if (el) el.textContent = value;
}

function renderDiagnostics(data: DiagnosticsResponse): void {
  setField("version", data.version);
  setField("source_revision", data.source_revision ?? t("diagnostics-unknown"));
  setField("launch_source", formatLaunchSource(data));
  setField("pid", String(data.pid));
  setField("uptime", formatUptime(data.uptime_ms));
  setField("account_type", data.account_type ?? t("diagnostics-unknown"));
  setField("models_cached", String(data.models_cached));
  setField("web_search", formatWebSearch(data.web_search));
  setField("github_copilot_status", deriveGithubCopilotStatus(data.tokens));
  setField("rate_limit", formatRateLimit(data.rate_limit));
}

/**
 * Human-readable label for which executor resolves web_search / web_fetch.
 * Maps the executor class to plain language, appending the detail (the
 * /responses model, Ollama host, or no-key note) when present.
 */
function formatWebSearch(ws: DiagnosticsResponse["web_search"]): string {
  const labels: Record<string, string> = {
    CopilotResponsesExecutor: t("diagnostics-web-search-copilot"),
    OllamaWebExecutor: t("diagnostics-web-search-ollama"),
    InProcessFetchExecutor: t("diagnostics-web-search-builtin"),
  };
  const label = labels[ws.kind] ?? ws.kind;
  return ws.detail
    ? t("diagnostics-web-search-detail", { label, detail: ws.detail })
    : label;
}

/**
 * Human-readable launch origin: a short label for the install kind plus
 * the absolute path it ran from. Lets a bug report distinguish a DMG
 * launch from a stray Homebrew or dev-build one at a glance.
 */
function formatLaunchSource(data: DiagnosticsResponse): string {
  const labels: Record<DiagnosticsResponse["launch_kind"], string> = {
    "dmg-app": t("diagnostics-launch-dmg"),
    homebrew: t("diagnostics-launch-homebrew"),
    "user-bin": t("diagnostics-launch-user-bin"),
    dev: t("diagnostics-launch-dev"),
    other: t("diagnostics-launch-other"),
  };
  const label = labels[data.launch_kind] ?? t("diagnostics-launch-other");
  return t("diagnostics-launch-source", { label, path: data.launch_path });
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
  if (gh && cop) return t("diagnostics-copilot-ready");
  if (gh && !cop) return t("diagnostics-copilot-refresh");
  if (!gh && !cop) return t("diagnostics-copilot-not-signed-in");
  return t("diagnostics-copilot-inconsistent");
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
let lastUpdateStatus: UpdateStatusResponse | null = null;

async function loadDiagnostics(): Promise<void> {
  const root = document.querySelector<HTMLElement>("[data-diagnostics-root]");
  if (!root) return;
  root.setAttribute("aria-busy", "true");
  setDiagnosticsError(null);
  // Independent of the diagnostics fetch (it also drives the topbar update
  // button): the proxy caches the manifest check for hours, so re-running on
  // each section open is cheap.
  void loadUpdateStatus();
  const result = await apiCall({
    kind: "diagnostics",
    method: "GET",
    path: "/settings/api/diagnostics",
  });
  root.setAttribute("aria-busy", "false");
  if (!result.ok) {
    setDiagnosticsError(t("diagnostics-err-load", { error: apiErrorMessage(result.error) }));
    return;
  }
  lastDiagnostics = result.data;
  renderDiagnostics(result.data);
}

/** Human "3m ago"-style age from an ISO timestamp; falls back to the raw
 *  string if it can't parse. */
function relativeTime(iso: string): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return iso;
  const secs = Math.max(0, Math.round((Date.now() - then) / 1000));
  if (secs < 60) return t("diagnostics-relative-just-now");
  const mins = Math.round(secs / 60);
  if (mins < 60) return t("diagnostics-relative-minutes", { m: mins });
  const hours = Math.round(mins / 60);
  if (hours < 24) return t("diagnostics-relative-hours", { h: hours });
  return t("diagnostics-relative-days", { d: Math.round(hours / 24) });
}

/**
 * Render every update surface from GET /settings/api/update-status: the
 * topbar "Update to X.Y.Z" button, the Diagnostics "Updates" outcome (what it
 * reports) and the "Update check" health (whether the mechanism is working).
 */
function renderUpdateStatus(data: UpdateStatusResponse): void {
  renderUpdateAction(data);
  renderUpdateOutcome(data);
  renderUpdateHealth(data);
}

/**
 * The version to offer the user, or null when there is nothing to offer: no
 * newer release, checks disabled, or the version couldn't be resolved. The
 * topbar button and the Diagnostics "Updates" row both read this, so they
 * always agree.
 */
function offeredUpdate(data: UpdateStatusResponse | null): string | null {
  if (!data?.enabled || !data.update_available || !data.latest) return null;
  return data.latest;
}

/**
 * Where the topbar update is: `idle`, waiting on the shell's native confirm
 * (`confirming`), or downloading after the user said yes (`downloading`).
 * The button is disabled while busy so a second click can't start another.
 */
let updatePhase: "idle" | "confirming" | "downloading" = "idle";

/** Whether the button installs in place (the Windows and macOS apps) rather
 *  than opening the download page. Read once from the shell at boot. */
let updateInPlace = false;

/**
 * The topbar "Update to X.Y.Z" button. Hidden unless a newer release is
 * offered (or an update is already running). In the Windows and macOS apps
 * clicking installs in place after a native confirm; elsewhere it opens the
 * download page in the system browser.
 */
function renderUpdateAction(data: UpdateStatusResponse | null): void {
  const wrap = document.querySelector<HTMLElement>("[data-update-action]");
  const button = wrap?.querySelector<HTMLButtonElement>(
    '[data-action="open-update"]',
  );
  if (!wrap || !button) return;
  const version = offeredUpdate(data);
  const busy = updatePhase !== "idle";
  wrap.hidden = version === null && !busy;
  button.disabled = busy;
  if (updatePhase === "downloading") {
    button.textContent = t("nav-update-downloading");
    button.title = "";
    return;
  }
  if (version === null) return;
  button.textContent = t("nav-update-to", { version });
  button.title = updateInPlace ? "" : t("diagnostics-update-get-it");
}

async function startUpdate(): Promise<void> {
  const status = lastUpdateStatus;
  if (!status || !offeredUpdate(status) || updatePhase !== "idle") return;
  updatePhase = "confirming";
  renderUpdateAction(lastUpdateStatus);
  // The shell confirms, installs and relaunches, or on failure tells the
  // user and opens the download page itself. "unavailable" means this build
  // doesn't install in place (a plain browser, a Linux build).
  const outcome = await installUpdate(() => {
    updatePhase = "downloading";
    renderUpdateAction(lastUpdateStatus);
  });
  updatePhase = "idle";
  renderUpdateAction(lastUpdateStatus);
  if (outcome === "unavailable") void openExternalUrl(status.url);
}

function wireUpdateAction(): void {
  void updateInstallsInPlace().then((inPlace) => {
    updateInPlace = inPlace;
    renderUpdateAction(lastUpdateStatus);
  });
  document
    .querySelector<HTMLButtonElement>('[data-action="open-update"]')
    ?.addEventListener("click", () => {
      void startUpdate();
    });
}

/**
 * The "Updates" outcome row. Three shapes: a newer release (offer the mxml.sh
 * link), up to date, or unknown (couldn't resolve a version — the "Update
 * check" row explains why; never claim "up to date" when we couldn't check).
 * The link opens in the system browser via the opener plugin.
 */
function renderUpdateOutcome(data: UpdateStatusResponse): void {
  const dd = document.querySelector<HTMLElement>(
    '[data-field="update_status"]',
  );
  if (!dd) return;
  dd.replaceChildren();

  const version = offeredUpdate(data);
  if (version) {
    const label = document.createElement("span");
    label.className = "mono";
    label.textContent = t("diagnostics-update-newer", { version });
    const link = document.createElement("a");
    link.href = data.url;
    link.textContent = t("diagnostics-update-get-it");
    link.addEventListener("click", (ev) => {
      ev.preventDefault();
      void openExternalUrl(data.url);
    });
    dd.append(label, link);
    return;
  }

  const span = document.createElement("span");
  span.className = "mono";
  // `latest` known but not newer → genuinely current. Otherwise we couldn't
  // resolve a version; say "Unknown" rather than imply everything's fine.
  span.textContent = data.latest
    ? t("diagnostics-update-up-to-date")
    : t("diagnostics-update-unknown");
  dd.append(span);
}

/**
 * The "Update check" health row — surfaces whether the mechanism is actually
 * working: enabled state, when it last reached the manifest, and the reason for
 * the most recent failure. Makes a silent breakage visible at a glance.
 */
function renderUpdateHealth(data: UpdateStatusResponse): void {
  let text: string;
  if (!data.enabled) {
    text = t("diagnostics-update-check-disabled");
  } else if (data.last_error) {
    const when = data.checked_at
      ? t("diagnostics-update-check-last-ok", {
          relative: relativeTime(data.checked_at),
        })
      : t("diagnostics-update-check-never");
    text = t("diagnostics-update-check-failed", {
      error: data.last_error,
      when,
    });
  } else if (data.checked_at) {
    text = t("diagnostics-update-check-ok", {
      relative: relativeTime(data.checked_at),
    });
  } else {
    text = t("diagnostics-update-check-checking");
  }
  setField("update_check", text);
}

async function loadUpdateStatus(): Promise<void> {
  const result = await apiCall({
    kind: "update-status",
    method: "GET",
    path: "/settings/api/update-status",
  });
  if (!result.ok) {
    // Sidecar unreachable — stay quiet, not alarming. The proxy already keeps
    // the last known result across manifest errors, so an error here means we
    // know nothing: hide the button, like the "Unknown" row says.
    lastUpdateStatus = null;
    renderUpdateAction(null);
    setField("update_status", t("diagnostics-update-unknown"));
    setField("update_check", t("diagnostics-update-check-unavailable"));
    return;
  }
  lastUpdateStatus = result.data;
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
 * Account-section update contract:
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
 * Live updates. While the Account section is open we hold one
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
  // Exhaustive over AuthStatus["state"]. A new variant added
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
  // `account_login` is required on the authenticated variant
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
  img.alt = t("account-avatar-alt", { login });
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
  if (!connectedSince) return t("account-connected");
  const sinceMs = Date.parse(connectedSince);
  if (Number.isNaN(sinceMs)) return t("account-connected");
  const elapsed = Date.now() - sinceMs;
  if (elapsed < 60_000) return t("account-connected-just-now");
  const minutes = Math.floor(elapsed / 60_000);
  if (minutes < 60) return t("account-connected-minutes", { minutes });
  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    const rem = minutes % 60;
    return rem
      ? t("account-connected-hours-minutes", { hours, minutes: rem })
      : t("account-connected-hours", { hours });
  }
  const days = Math.floor(hours / 24);
  return t("account-connected-days", { days });
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
      degraded
        ? t("account-conn-aria-degraded")
        : t("account-conn-aria-connected"),
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
  if (status === 402) return t("account-rejection-title-402");
  if (status === 403) return t("account-rejection-title-403");
  if (status === 404) return t("account-rejection-title-404");
  if (status === 408 || status === 504) return t("account-rejection-title-timeout");
  if (status === 429) return t("account-rejection-title-429");
  if (status >= 500) return t("account-rejection-title-5xx");
  if (status >= 400) return t("account-rejection-title-4xx");
  return t("account-rejection-title-other");
}

/** Actionable next step keyed off the status, used when the upstream message
 *  itself is missing or the generic fallback. */
function rejectionExplanation(status: number): string {
  if (status === 402) return t("account-rejection-explain-402");
  if (status === 403) return t("account-rejection-explain-403");
  if (status === 408 || status === 504) return t("account-rejection-explain-timeout");
  if (status === 429) return t("account-rejection-explain-429");
  if (status >= 500) return t("account-rejection-explain-5xx");
  return t("account-rejection-explain-other");
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
    titleEl.textContent = t("account-rejection-title-line", {
      title: rejectionTitle(status),
      status,
    });

  // Show the real upstream message when we have one; otherwise the generic
  // fallback tells the user nothing, so swap in a status-derived next step.
  // The compared literal is GHCP's own wire fallback, not our UI copy.
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
  if (/\/settings\/copilot/i.test(url)) return t("account-remediation-copilot-settings");
  if (/\/copilot\/signup/i.test(url)) return t("account-remediation-accept-terms");
  if (/\/site\/terms|\/terms-of-service/i.test(url)) return t("account-remediation-review-terms");
  return t("account-remediation-generic");
}

function formatExpiresAt(iso: string | undefined): string {
  if (!iso) return t("account-expires-soon");
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

  // Switch on the discriminator so the compiler narrows per
  // branch. Each variant declares exactly the fields it carries; the
  // previous `?? "(unknown)"` / `?? "…"` / `?? "https://…"` fallbacks
  // are gone because the union guarantees presence.
  switch (status.state) {
    case "device_code_issued":
    case "polling": {
      setAccountField("user_code", status.user_code);
      renderDeviceCodeLabel();
      setAccountField(
        "waiting_authorization",
        t("account-waiting-authorization", {
          expiresAt: formatExpiresAt(status.expires_at),
        }),
      );
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
      error: t("account-err-load-status", { error: result.error }),
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
    // Fill the templated [data-i18n] labels ("Use this account") on the clone;
    // applyI18n only sweeps the live DOM, and the template content isn't in it.
    applyI18n(row);

    const loginEl = row.querySelector<HTMLElement>('[data-field="gh_login"]');
    if (loginEl) loginEl.textContent = account.login;
    const hostEl = row.querySelector<HTMLElement>('[data-field="gh_host"]');
    if (hostEl) hostEl.textContent = account.host;

    if (account.active) {
      row.querySelector(".gh-account__dot")?.classList.add("status--ok");
      const sr = document.createElement("span");
      sr.className = "sr-only";
      sr.textContent = t("account-active-suffix");
      row.querySelector(".gh-account__id")?.appendChild(sr);
    }

    const button = row.querySelector<HTMLButtonElement>(
      '[data-action="gh-use"]',
    );
    if (button) {
      button.dataset.ghLogin = account.login;
      button.dataset.ghHost = account.host;
      button.setAttribute(
        "aria-label",
        t("account-gh-use-aria", { login: account.login }),
      );
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
  button.textContent = t("account-refreshing");
  // loadGhAccounts is best-effort and resolves even on failure (it just hides
  // the section), so `finally` is the single settle point either way.
  void loadGhAccounts().finally(() => {
    button.disabled = false;
    button.classList.add("btn--confirmed");
    button.textContent = t("account-updated");
    window.setTimeout(() => {
      button.classList.remove("btn--confirmed");
      button.textContent = t("common-refresh");
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
  buttonEl.textContent = t("account-signing-in");
  row?.setAttribute("aria-busy", "true");
  for (const b of signInButtons) b.disabled = true;
  setBusy(true, t("account-busy-signing-in")); // ambient top-of-window indicator

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
      apiErrorMessage(result.error) || t("account-err-gh-use-generic"),
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
        sawDown
          ? t("account-err-gh-use-authless", { login })
          : t("account-err-gh-use-no-restart"),
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
    // Fill the templated [data-i18n] labels ("Switch" / "Remove") on the clone.
    applyI18n(row);

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
      const ariaKey =
        action === "account-switch" ? "account-switch-aria" : "account-remove-aria";
      btn.setAttribute("aria-label", t(ariaKey, { login: account.login }));
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
  buttonEl.textContent = t("account-switching");
  row?.setAttribute("aria-busy", "true");
  for (const b of buttons) b.disabled = true;
  setBusy(true, t("account-busy-switching"));

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
      apiErrorMessage(result.error) || t("account-err-switch-generic"),
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
        sawDown
          ? t("account-err-switch-authless")
          : t("account-err-switch-no-restart"),
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
    t("account-confirm-remove", { login }),
  );
  if (!confirmed) return;

  const buttons = document.querySelectorAll<HTMLButtonElement>(
    '[data-section="account"] [data-action="account-switch"], [data-section="account"] [data-action="account-remove"]',
  );
  for (const b of buttons) b.disabled = true;
  setBusy(true, t("account-busy-removing"));

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
      apiErrorMessage(result.error) || t("account-err-remove-generic"),
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
      error: t("account-err-poll-failed", { error: result.error }),
    });
    return;
  }
  renderAccount(result.data);
}

async function startAuth(): Promise<void> {
  stopAuthPolling();
  // Show the ambient busy bar while the device-code request is in flight —
  // matches signOut/useGhAccount, so no action fires without feedback.
  setBusy(true, t("account-busy-starting-sign-in"));
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
      error: t("account-err-start-failed", { error: result.error }),
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
      error: t("account-err-cancel-failed", { error: result.error }),
    });
    return;
  }
  renderAccount(result.data);
}

async function signOut(): Promise<void> {
  const confirmed = window.confirm(t("account-confirm-sign-out"));
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
  setBusy(true, t("account-busy-signing-out"));
  try {
    await safeInvoke("restart_sidecar");
    // Keep the indicator up until the sidecar is back (briefly down mid-reboot)
    // so the bar reflects the real "restarting" window, not just the IPC call.
    await waitForSidecarBack(8_000);
  } finally {
    setBusy(false);
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
      error: t("account-err-sign-out-failed", { error: result.error }),
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
      label.textContent = t("account-code-copy-manually", { code });
    }
  }

  if (copied && label) {
    label.textContent = t("account-code-copied-opening");
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

async function checkInitialAccountHealth(): Promise<void> {
  const result = await apiCall({
    kind: "auth-status",
    method: "GET",
    path: "/settings/api/auth/github/status",
  });
  if (!result.ok || hasAccountProblem(result.data)) {
    if (!userExplicitlySelectedTab) {
      showSection("account", { persist: false });
      if (result.ok) {
        renderAccount(result.data);
      } else {
        renderAccount({
          state: "error",
          error: t("account-err-load-status", { error: result.error }),
        });
      }
      openAuthEvents();
    }
  } else {
    currentAuthStatus = result.data;
  }
}

window.addEventListener("DOMContentLoaded", () => {
  document.documentElement.dataset.os = osKind();
  const initialHash = window.location.hash.replace(/^#/, "");
  const hadExplicitHash = isSectionId(initialHash);
  applyI18n();
  // Sentences that embed a link/CLI token or a plural count aren't [data-i18n]
  // (they carry live DOM children); render them explicitly after the sweep.
  renderStaticComposites();
  wireLocalePicker(repaintDynamicI18n);
  wireLogs();
  wireDiagnostics();
  wireUpdateAction();
  wireAccount();
  wireEndpoint();
  wireUninstall();
  wireAppearance();
  mountApiClients();
  mountApps();
  mountMcp();
  mountRequests();
  mountModels();
  wireNav();
  syncFromHash({ persist: hadExplicitHash });
  void loadDiagnostics();
  if (tabForSection(readHashSection()) === "account") {
    void loadAuthStatus();
    openAuthEvents();
  } else if (!hadExplicitHash) {
    void checkInitialAccountHealth();
  }
});

window.addEventListener("hashchange", () => {
  syncFromHash();
  const section = readHashSection();
  const tab = tabForSection(section);
  if (tab === "system") void loadDiagnostics();
  if (tab === "integrations") {
    window.dispatchEvent(new CustomEvent("maximal:apps-refresh"));
    window.dispatchEvent(new CustomEvent("maximal:requests-refresh"));
    window.dispatchEvent(new CustomEvent("maximal:mcp-refresh"));
  }
  if (tab === "models-keys") {
    window.dispatchEvent(new CustomEvent("maximal:models-refresh"));
  }
  if (tab === "account") {
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
  // The window can stay open for days; re-read the (proxy-cached) update
  // status so the topbar button appears without reopening it.
  void loadUpdateStatus();
}
window.addEventListener("focus", refreshAccountOnAttention);
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") refreshAccountOnAttention();
});
