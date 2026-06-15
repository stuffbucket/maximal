/**
 * Crash-detection sentinel for the Claude Code routing lifecycle.
 *
 * Background: maximal writes `env.ANTHROPIC_BASE_URL` into
 * `~/.claude/settings.json` while running (so `claude` invocations
 * route through the proxy). The reverse is performed by
 * `reconcileClaudeCodeOnShutdown`. If the process dies by SIGKILL,
 * OS-level termination, or a power loss, no userspace runs — the
 * base URL is left behind, and the user's next `claude` invocation
 * hits `localhost:4141` with nothing listening, producing
 * "connection refused" errors.
 *
 * This module provides a small evidence trail across maximal
 * restarts:
 *
 *   - On boot (after Claude Code routing has been re-applied), call
 *     `markSessionRunning()` to write a sentinel file.
 *   - On graceful shutdown (initiateShutdown / `exit` event), call
 *     `clearSessionRunning()` to delete it.
 *   - On the NEXT boot, call `detectStaleSession()`. If the sentinel
 *     exists and the Claude Code base URL is currently still ours,
 *     the previous run died ungracefully — log a clear warning so the
 *     user can correlate the symptom they likely just experienced
 *     ("`claude` was broken") with the cause.
 *
 * This doesn't auto-recover the inter-session window — only an
 * external watchdog (launchd, the Tauri shell observing sidecar
 * death) can do that without the sidecar's cooperation. But it
 * diagnoses the symptom on the next run instead of leaving the user
 * confused.
 */

import fs from "node:fs"
import path from "node:path"

import { PATHS } from "~/lib/paths"

const SENTINEL_FILENAME = "session-running"

function sentinelPath(): string {
  return path.join(PATHS.APP_DIR, SENTINEL_FILENAME)
}

/** Write the sentinel file. Idempotent (overwrites). Best-effort —
 *  a failed write here must not abort boot. */
export function markSessionRunning(): void {
  try {
    fs.mkdirSync(PATHS.APP_DIR, { recursive: true })
    fs.writeFileSync(
      sentinelPath(),
      JSON.stringify({
        pid: process.pid,
        started_at: new Date().toISOString(),
      }),
    )
  } catch {
    /* best-effort */
  }
}

/** Delete the sentinel file. Idempotent (no-op when absent). */
export function clearSessionRunning(): void {
  try {
    fs.rmSync(sentinelPath(), { force: true })
  } catch {
    /* best-effort */
  }
}

/** Returns true if a sentinel exists from a prior session (i.e. the
 *  previous run did NOT call clearSessionRunning before exiting). The
 *  caller then decides what to do — typically log a warning + invite
 *  recovery action. Doesn't delete the sentinel; that's the caller's
 *  job after acting on it. */
export function staleSessionMarkerPresent(): boolean {
  try {
    return fs.existsSync(sentinelPath())
  } catch {
    return false
  }
}
