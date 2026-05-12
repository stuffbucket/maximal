// Maximal — Setup window controller.
//
// One window, three states (Welcome / Waiting / Connected) plus an
// exception branch for pre-auth blockers (appDir / config / db).
// See docs/first-run-setup-prd.md §"Setup window — three states,
// one window" and .design-context.md for the design contract.
//
// HTTP contract (proxy side, served on http://127.0.0.1:4142):
//   GET  /setup-status  -> { ready, checks, nextStep }
//   POST /auth/start    -> { verification_uri, verification_uri_complete?,
//                             user_code, expires_in, interval, device_code }
//                          409 { error: "already_authenticated" }
//   GET  /auth/poll     -> { status: "pending" | "ready" | "expired" |
//                             "error", ... } | 404 no_pending_auth

import { openUrl, revealItemInDir } from "@tauri-apps/plugin-opener";
import { getCurrentWindow } from "@tauri-apps/api/window";

const PROXY_BASE = "http://127.0.0.1:4142";
const DEFAULT_POLL_INTERVAL_S = 5;
const COUNTDOWN_URGENT_S = 60;
const COPIED_FADE_MS = 4000;
const CONNECTED_BRIDGE_DELAY_MS = 600;
const CROSSFADE_MS = 200;

// ---------- Types matching the proxy contract ----------

type CheckResult = {
  ok: boolean;
  path?: string;
  reason?: string;
};

type NextStep = "appDir" | "config" | "db" | "githubAuth" | null;

type SetupStatus = {
  ready: boolean;
  checks: Record<string, CheckResult>;
  nextStep: NextStep;
};

type AuthStart = {
  verification_uri: string;
  verification_uri_complete?: string;
  user_code: string;
  expires_in: number;
  interval: number;
  device_code: string;
};

type AuthPoll =
  | { status: "pending"; expires_in: number }
  | { status: "ready"; username: string }
  | { status: "expired" }
  | { status: "error"; reason: string };

// ---------- DOM helpers ----------

const stage = document.getElementById("stage") as HTMLDivElement;

const prefersReducedMotion = window.matchMedia(
  "(prefers-reduced-motion: reduce)",
).matches;

function el<T extends HTMLElement = HTMLElement>(
  tag: string,
  attrs: Record<string, string> = {},
  children: Array<HTMLElement | string> = [],
): T {
  const node = document.createElement(tag) as T;
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "class") node.className = v;
    else if (k === "html") node.innerHTML = v;
    else node.setAttribute(k, v);
  }
  for (const child of children) {
    node.append(typeof child === "string" ? document.createTextNode(child) : child);
  }
  return node;
}

function brandMark(): HTMLDivElement {
  return el("div", { class: "brand-m", "aria-hidden": "true" }, ["m"]);
}

// ---------- State swap with crossfade ----------

let pendingTimers: number[] = [];

function clearTimers() {
  for (const t of pendingTimers) window.clearTimeout(t);
  pendingTimers = [];
}

async function swapStage(render: () => HTMLElement): Promise<void> {
  clearTimers();
  if (prefersReducedMotion) {
    stage.replaceChildren(render());
    return;
  }
  stage.classList.add("is-swapping");
  await new Promise((r) => window.setTimeout(r, CROSSFADE_MS));
  stage.replaceChildren(render());
  // Force reflow before removing the swap class so the fade-in runs.
  void stage.offsetHeight;
  stage.classList.remove("is-swapping");
}

// ---------- HTTP helpers ----------

async function getJSON<T>(path: string): Promise<T> {
  const res = await fetch(`${PROXY_BASE}${path}`, {
    headers: { accept: "application/json" },
  });
  if (!res.ok) {
    throw new HttpError(res.status, await safeText(res));
  }
  return (await res.json()) as T;
}

async function postJSON<T>(path: string): Promise<T> {
  const res = await fetch(`${PROXY_BASE}${path}`, {
    method: "POST",
    headers: { accept: "application/json" },
  });
  if (!res.ok) {
    throw new HttpError(res.status, await safeText(res));
  }
  return (await res.json()) as T;
}

async function safeText(res: Response): Promise<string> {
  try {
    return await res.text();
  } catch {
    return "";
  }
}

class HttpError extends Error {
  constructor(public status: number, public body: string) {
    super(`HTTP ${status}: ${body}`);
  }
}

// ---------- Logs reveal (exception branch) ----------

async function revealLogs(): Promise<void> {
  // Best-effort: open the macOS log dir. On other platforms the
  // user's path will differ; this matches the proxy's daily log
  // location for the shell-installed app.
  const home = await getHomeDir();
  if (!home) return;
  const path = `${home}/Library/Logs/maximal/`;
  try {
    await revealItemInDir(path);
  } catch {
    // Fall back to opening the parent ~/.local/share/maximal/logs
    try {
      await revealItemInDir(`${home}/.local/share/maximal/logs/`);
    } catch {
      /* swallow — no actionable recovery from the setup window */
    }
  }
}

async function getHomeDir(): Promise<string | null> {
  try {
    const path = await import("@tauri-apps/api/path");
    return await path.homeDir();
  } catch {
    return null;
  }
}

// ---------- State 1: Welcome ----------

function renderWelcome(): HTMLElement {
  const wrap = el("div", { class: "stack" });
  wrap.append(brandMark());
  wrap.append(
    el("h1", { class: "setup-headline" }, ["Welcome to Maximal"]),
    el("p", { class: "setup-lede" }, [
      "Route Claude Code, Cursor, or any Anthropic- or OpenAI-compatible client through your GitHub Copilot subscription.",
    ]),
    el("p", { class: "setup-meta" }, ["Two minutes to set up."]),
  );

  const cta = el<HTMLButtonElement>(
    "button",
    { class: "btn btn-primary", type: "button" },
    [
      "Sign in with GitHub",
      el("span", { class: "btn-arrow", "aria-hidden": "true" }, ["→"]),
    ],
  );
  cta.addEventListener("click", () => {
    void handleSignIn(cta);
  });
  wrap.append(cta);

  wrap.append(
    el("p", { class: "setup-secondary" }, [
      "Already signed in via the CLI? Maximal will pick up the existing token — close this window and reopen.",
    ]),
  );

  return wrap;
}

async function handleSignIn(cta: HTMLButtonElement): Promise<void> {
  cta.disabled = true;
  cta.textContent = "Contacting GitHub…";
  try {
    const start = await postJSON<AuthStart>("/auth/start");
    // Browser open is fire-and-forget; the user can also click the
    // "Open browser again" recovery button from State 2.
    void openUrl(start.verification_uri_complete ?? start.verification_uri);
    await swapStage(() => renderWaiting(start));
  } catch (err) {
    if (err instanceof HttpError && err.status === 409) {
      // Already authenticated — re-check setup status and bridge.
      try {
        const status = await getJSON<SetupStatus>("/setup-status");
        if (status.ready) {
          await swapStage(() =>
            renderConnected(extractUsername(status) ?? "you"),
          );
          scheduleBridge();
          return;
        }
      } catch {
        /* fall through to generic error below */
      }
    }
    cta.disabled = false;
    cta.textContent = "Sign in with GitHub";
    await swapStage(() => renderFatalError(humanizeError(err)));
  }
}

function extractUsername(status: SetupStatus): string | null {
  const ga = status.checks.githubAuth;
  if (ga && typeof (ga as unknown as { username?: string }).username === "string") {
    return (ga as unknown as { username: string }).username;
  }
  return null;
}

// ---------- State 2: Waiting ----------

function renderWaiting(start: AuthStart): HTMLElement {
  const wrap = el("div", { class: "stack" });
  wrap.append(brandMark());
  wrap.append(
    el("h1", { class: "setup-headline" }, ["Almost there"]),
    el("p", { class: "setup-lede" }, [
      "We opened github.com/login/device in your browser. Paste this code and approve:",
    ]),
  );

  const codeBlock = el(
    "div",
    {
      class: "code-block",
      role: "group",
      "aria-label": `Device code: ${start.user_code}`,
    },
    [start.user_code],
  );
  const copied = el("span", { class: "copied-flag" }, [
    el("span", { "aria-hidden": "true" }, ["✓"]),
    " copied",
  ]);
  const codeWrap = el("div", { class: "center" }, [codeBlock, copied]);
  wrap.append(codeWrap);

  // Fade the copied flag after 4s.
  pendingTimers.push(
    window.setTimeout(() => copied.classList.add("is-faded"), COPIED_FADE_MS),
  );

  wrap.append(
    el("p", { class: "setup-meta" }, [
      "We'll pick it up the moment you approve.",
    ]),
  );

  wrap.append(el("hr", { class: "divider" }));

  const countdown = el("div", { class: "countdown" }, [""]);
  wrap.append(countdown);

  const reopen = el<HTMLButtonElement>(
    "button",
    { class: "btn btn-secondary", type: "button" },
    ["Open browser again"],
  );
  reopen.addEventListener("click", () => {
    void openUrl(start.verification_uri_complete ?? start.verification_uri);
  });
  wrap.append(reopen);

  // Countdown — recompute against an absolute deadline so the page
  // can be backgrounded without skipping seconds visibly.
  const deadline = Date.now() + start.expires_in * 1000;
  const tickCountdown = () => {
    const remaining = Math.max(0, Math.round((deadline - Date.now()) / 1000));
    renderCountdown(countdown, remaining);
    if (remaining <= 0) {
      void swapStage(() => renderExpired(start));
      return;
    }
    pendingTimers.push(window.setTimeout(tickCountdown, 1000));
  };
  tickCountdown();

  // Poll /auth/poll at the upstream cadence.
  const interval = Math.max(1, start.interval || DEFAULT_POLL_INTERVAL_S);
  const poll = async () => {
    try {
      const res = await getJSON<AuthPoll>("/auth/poll");
      if (res.status === "ready") {
        await swapStage(() => renderConnected(res.username));
        scheduleBridge();
        return;
      }
      if (res.status === "expired") {
        await swapStage(() => renderExpired(start));
        return;
      }
      if (res.status === "error") {
        await swapStage(() => renderFatalError(res.reason));
        return;
      }
      // pending — schedule the next poll
      pendingTimers.push(window.setTimeout(poll, interval * 1000));
    } catch (err) {
      // Transient errors get a retry; the countdown will eventually
      // give up if the proxy never recovers.
      if (err instanceof HttpError && err.status === 404) {
        // Device code is gone — start fresh.
        await swapStage(() => renderExpired(start));
        return;
      }
      pendingTimers.push(window.setTimeout(poll, interval * 1000));
    }
  };
  pendingTimers.push(window.setTimeout(poll, interval * 1000));

  return wrap;
}

function renderCountdown(node: HTMLElement, remainingSeconds: number): void {
  const mm = Math.floor(remainingSeconds / 60).toString();
  const ss = (remainingSeconds % 60).toString().padStart(2, "0");
  const urgent = remainingSeconds <= COUNTDOWN_URGENT_S;
  node.classList.toggle("is-urgent", urgent);
  node.replaceChildren(
    document.createTextNode(`Code expires in ${mm}:${ss}`),
  );
  if (urgent) {
    node.append(
      el("small", { class: "countdown-warning" }, ["Code expires soon"]),
    );
  }
}

function renderExpired(start: AuthStart): HTMLElement {
  const wrap = el("div", { class: "stack" });
  wrap.append(brandMark());
  wrap.append(
    el("h1", { class: "setup-headline" }, ["The code expired"]),
    el("p", { class: "setup-lede" }, [
      "GitHub device codes are short-lived. Generate a fresh one and try again.",
    ]),
  );
  const retry = el<HTMLButtonElement>(
    "button",
    { class: "btn btn-primary", type: "button" },
    [
      "Try again",
      el("span", { class: "btn-arrow", "aria-hidden": "true" }, ["→"]),
    ],
  );
  retry.addEventListener("click", () => {
    void handleSignIn(retry);
  });
  wrap.append(retry);
  // The arg is kept for parity with the State 2 close path (which
  // re-uses `start` if we ever want to fall back to manually
  // reopening the same URL); intentionally unused on the expiry path.
  void start;
  return wrap;
}

// ---------- State 3: Connected ----------

function renderConnected(username: string): HTMLElement {
  const wrap = el("div", { class: "stack" });
  wrap.append(brandMark());
  wrap.append(
    el("h1", { class: "setup-headline" }, ["You're connected"]),
    el("p", { class: "setup-lede" }, [
      `Signed in as @${username}. Maximal is serving on localhost:4142.`,
    ]),
    el("p", { class: "setup-meta" }, ["Next: point a client at it."]),
  );

  const cta = el<HTMLButtonElement>(
    "button",
    { class: "btn btn-primary", type: "button" },
    [
      "Show me how",
      el("span", { class: "btn-arrow", "aria-hidden": "true" }, ["→"]),
    ],
  );
  cta.addEventListener("click", () => {
    void bridgeToDashboard();
  });
  wrap.append(cta);

  return wrap;
}

function scheduleBridge(): void {
  // Brief moment so the user registers success before we bridge.
  pendingTimers.push(
    window.setTimeout(() => {
      // Auto-bridge is intentionally NOT triggered — the PRD says
      // "click 'Show me how' bridges to Dashboard." Auto-close here
      // would skip the moment. The CTA is now wired; the user
      // decides.
    }, CONNECTED_BRIDGE_DELAY_MS),
  );
}

async function bridgeToDashboard(): Promise<void> {
  // TODO: bridge to dashboard #connect when the Dashboard window
  // lands. See docs/dashboard-window-prd.md. For now we just close
  // the Setup window; the tray's "Open Maximal" will become the
  // dashboard entry point once that PRD ships.
  try {
    await getCurrentWindow().close();
  } catch {
    /* if window APIs aren't available, leave the user on State 3 */
  }
}

// ---------- Exception branch: appDir / config / db ----------

function renderBlocker(status: SetupStatus): HTMLElement {
  const wrap = el("div", { class: "stack" });
  wrap.append(brandMark());
  wrap.append(
    el("h1", { class: "setup-headline" }, ["Maximal can't start."]),
    el("p", { class: "setup-lede" }, [
      "A pre-flight check failed before sign-in was reachable. The details below come straight from the proxy.",
    ]),
  );

  const failed =
    status.nextStep && status.checks[status.nextStep]
      ? { key: status.nextStep, check: status.checks[status.nextStep] }
      : findFirstFailing(status);

  const block = el("div", { class: "error-block" });
  block.append(
    el("strong", {}, [labelForCheck(failed?.key ?? "unknown")]),
    el("span", { class: "reason" }, [
      failed?.check?.reason ?? "Internal error.",
    ]),
  );
  if (failed?.check?.path) {
    block.append(
      el("span", { class: "reason" }, [`Path: ${failed.check.path}`]),
    );
  }
  wrap.append(block);

  const logs = el<HTMLButtonElement>(
    "button",
    { class: "btn btn-secondary", type: "button" },
    ["Reveal logs"],
  );
  logs.addEventListener("click", () => {
    void revealLogs();
  });
  wrap.append(logs);

  return wrap;
}

function findFirstFailing(
  status: SetupStatus,
): { key: string; check: CheckResult } | null {
  for (const [key, check] of Object.entries(status.checks)) {
    if (!check.ok) return { key, check };
  }
  return null;
}

function labelForCheck(key: string): string {
  switch (key) {
    case "appDir":
      return "Application directory unavailable";
    case "config":
      return "Configuration file invalid";
    case "db":
      return "Local database can't open";
    case "githubAuth":
      return "GitHub sign-in incomplete";
    default:
      return "Setup check failed";
  }
}

// ---------- Generic error state (fatal) ----------

function renderFatalError(message: string): HTMLElement {
  const wrap = el("div", { class: "stack" });
  wrap.append(brandMark());
  wrap.append(
    el("h1", { class: "setup-headline" }, ["Something went wrong"]),
    el("p", { class: "setup-lede" }, [
      "We couldn't complete that step. The proxy returned:",
    ]),
  );
  const block = el("div", { class: "error-block" });
  block.append(el("span", { class: "reason" }, [message]));
  wrap.append(block);

  const logs = el<HTMLButtonElement>(
    "button",
    { class: "btn btn-secondary", type: "button" },
    ["Reveal logs"],
  );
  logs.addEventListener("click", () => {
    void revealLogs();
  });
  wrap.append(logs);

  return wrap;
}

function humanizeError(err: unknown): string {
  if (err instanceof HttpError) {
    return err.body || `Proxy returned HTTP ${err.status}.`;
  }
  if (err instanceof Error) return err.message;
  return String(err);
}

// ---------- Bootstrap ----------

async function bootstrap(): Promise<void> {
  // Initial render: a quiet placeholder so the swap has somewhere
  // to fade from. Avoids a flash-of-empty-window on slow status fetch.
  stage.replaceChildren(
    (() => {
      const ph = el("div", { class: "stack" });
      ph.append(brandMark());
      ph.append(el("p", { class: "setup-meta" }, ["Checking setup…"]));
      return ph;
    })(),
  );

  try {
    const status = await getJSON<SetupStatus>("/setup-status");
    if (status.ready) {
      const username = extractUsername(status) ?? "you";
      await swapStage(() => renderConnected(username));
      return;
    }
    if (status.nextStep === "githubAuth") {
      await swapStage(() => renderWelcome());
      return;
    }
    // appDir / config / db — exceptional branch.
    await swapStage(() => renderBlocker(status));
  } catch (err) {
    await swapStage(() => renderFatalError(humanizeError(err)));
  }
}

window.addEventListener("DOMContentLoaded", () => {
  void bootstrap();
});
