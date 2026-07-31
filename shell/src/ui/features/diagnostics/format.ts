// Pure diagnostics formatters — ported verbatim from the imperative renderers
// in main.ts so behaviour (and the `diagnostics-*` catalog keys) is unchanged.
// Each takes the translate fn explicitly (rather than importing `t`) so it is
// trivially testable and so the component controls locale re-rendering via
// useT().
import type {
  DiagnosticsResponse,
  UpdateStatusResponse,
} from "../../../../../src/lib/config/settings-types"

export type TranslateFn = (
  key: string,
  values?: Record<string, unknown>,
) => string

export function formatUptime(t: TranslateFn, ms: number): string {
  const totalSeconds = Math.floor(ms / 1000)
  const h = Math.floor(totalSeconds / 3600)
  const m = Math.floor((totalSeconds % 3600) / 60)
  const s = totalSeconds % 60
  if (h > 0) return t("diagnostics-uptime-hours", { h, m })
  if (m > 0) return t("diagnostics-uptime-minutes", { m, s })
  return t("diagnostics-uptime-seconds", { s })
}

export function formatRateLimit(
  t: TranslateFn,
  rl: DiagnosticsResponse["rate_limit"],
): string {
  if (rl.interval_seconds === null) return t("diagnostics-rate-unlimited")
  const tail =
    rl.last_request_at ?
      t("diagnostics-rate-last-request", {
        time: new Date(rl.last_request_at).toLocaleTimeString(),
      })
    : ""
  const mode =
    rl.wait_when_throttled ?
      t("diagnostics-rate-mode-wait")
    : t("diagnostics-rate-mode-reject")
  return t("diagnostics-rate-limited", {
    seconds: rl.interval_seconds,
    mode,
    tail,
  })
}

export function formatWebSearch(
  t: TranslateFn,
  ws: DiagnosticsResponse["web_search"],
): string {
  const labels: Record<string, string> = {
    CopilotResponsesExecutor: t("diagnostics-web-search-copilot"),
    OllamaWebExecutor: t("diagnostics-web-search-ollama"),
    InProcessFetchExecutor: t("diagnostics-web-search-builtin"),
  }
  const label = labels[ws.kind] ?? ws.kind
  return ws.detail ?
      t("diagnostics-web-search-detail", { label, detail: ws.detail })
    : label
}

export function formatLaunchSource(
  t: TranslateFn,
  data: DiagnosticsResponse,
): string {
  const labels: Record<DiagnosticsResponse["launch_kind"], string> = {
    "dmg-app": t("diagnostics-launch-dmg"),
    homebrew: t("diagnostics-launch-homebrew"),
    "user-bin": t("diagnostics-launch-user-bin"),
    dev: t("diagnostics-launch-dev"),
    other: t("diagnostics-launch-other"),
  }
  const label = labels[data.launch_kind]
  return t("diagnostics-launch-source", { label, path: data.launch_path })
}

/**
 * Collapse the two token booleans into one human status.
 *   github | copilot → status
 *   true   | true    → ready
 *   true   | false   → will refresh
 *   false  | false   → not signed in
 *   false  | true    → inconsistent
 */
export function deriveGithubCopilotStatus(
  t: TranslateFn,
  tokens: DiagnosticsResponse["tokens"],
): string {
  const gh = tokens.github_token_present
  const cop = tokens.copilot_token_present
  if (gh && cop) return t("diagnostics-copilot-ready")
  if (gh && !cop) return t("diagnostics-copilot-refresh")
  if (!gh && !cop) return t("diagnostics-copilot-not-signed-in")
  return t("diagnostics-copilot-inconsistent")
}

/** Human "3m ago" from an ISO timestamp; falls back to the raw string. */
export function relativeTime(t: TranslateFn, iso: string): string {
  const then = new Date(iso).getTime()
  if (Number.isNaN(then)) return iso
  const secs = Math.max(0, Math.round((Date.now() - then) / 1000))
  if (secs < 60) return t("diagnostics-relative-just-now")
  const mins = Math.round(secs / 60)
  if (mins < 60) return t("diagnostics-relative-minutes", { m: mins })
  const hours = Math.round(mins / 60)
  if (hours < 24) return t("diagnostics-relative-hours", { h: hours })
  return t("diagnostics-relative-days", { d: Math.round(hours / 24) })
}

/** The "Update check" health row text (mechanism working / disabled / failing). */
export function formatUpdateHealth(
  t: TranslateFn,
  data: UpdateStatusResponse,
): string {
  if (!data.enabled) return t("diagnostics-update-check-disabled")
  if (data.last_error) {
    const when =
      data.checked_at ?
        t("diagnostics-update-check-last-ok", {
          relative: relativeTime(t, data.checked_at),
        })
      : t("diagnostics-update-check-never")
    return t("diagnostics-update-check-failed", {
      error: data.last_error,
      when,
    })
  }
  if (data.checked_at) {
    return t("diagnostics-update-check-ok", {
      relative: relativeTime(t, data.checked_at),
    })
  }
  return t("diagnostics-update-check-checking")
}
