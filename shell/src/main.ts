import { invoke } from "@tauri-apps/api/core";

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
  const pane = document.getElementById("pane");
  if (pane) pane.scrollTo({ top: 0 });
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

window.addEventListener("DOMContentLoaded", () => {
  applyTheme();
  wireFooter();
  syncFromHash();
});

window.addEventListener("hashchange", () => {
  syncFromHash();
});
