import { invoke } from "@tauri-apps/api/core";

import type { DiagnosticsResponse } from "../../src/lib/settings-types";
import { apiCall } from "./api";

type SectionId =
  | "account"
  | "api-clients"
  | "providers"
  | "secrets"
  | "routing"
  | "per-model"
  | "advanced"
  | "diagnostics";

const SECTIONS: ReadonlyArray<SectionId> = [
  "account",
  "api-clients",
  "providers",
  "secrets",
  "routing",
  "per-model",
  "advanced",
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
  window.scrollTo({ top: 0 });
}

function readHashSection(): SectionId {
  const raw = window.location.hash.replace(/^#/, "");
  return isSectionId(raw) ? raw : DEFAULT_SECTION;
}

function syncFromHash(): void {
  showSection(readHashSection());
}

async function safeInvoke(cmd: string): Promise<void> {
  try {
    await invoke(cmd);
  } catch (err) {
    // Tauri command unavailable (e.g. running in plain browser). Log and continue.
    console.warn(`invoke(${cmd}) failed:`, err);
  }
}

function wireFooter(): void {
  const configBtn = document.getElementById("reveal-config");
  const logsBtn = document.getElementById("reveal-logs");
  const logsBtn2 = document.getElementById("open-logs-2");

  configBtn?.addEventListener("click", () => {
    void safeInvoke("reveal_config_dir");
  });
  const revealLogs = () => {
    void safeInvoke("reveal_logs_dir");
  };
  logsBtn?.addEventListener("click", revealLogs);
  logsBtn2?.addEventListener("click", revealLogs);

  // Restart button is intentionally disabled in v1.
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
    .querySelector('[data-action="open-logs"]')
    ?.addEventListener("click", () => {
      void safeInvoke("reveal_logs_dir");
    });
}

window.addEventListener("DOMContentLoaded", () => {
  applyTheme();
  wireFooter();
  wireDiagnostics();
  syncFromHash();
  void loadDiagnostics();
});

window.addEventListener("hashchange", () => {
  syncFromHash();
  if (readHashSection() === "diagnostics") void loadDiagnostics();
});
