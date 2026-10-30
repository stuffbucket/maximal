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
 * The sentinel also records the port the running instance listens on, so
 * another process (e.g. the CLI) can address it: see `runningSessionPort`.
 *
 * This doesn't auto-recover the inter-session window — only an
 * external watchdog (launchd, the Tauri shell observing sidecar
 * death) can do that without the sidecar's cooperation. But it
 * diagnoses the symptom on the next run instead of leaving the user
 * confused.
 */

import fs from "node:fs"
import path from "node:path"

import { PATHS } from "~/lib/platform/paths"

const SENTINEL_FILENAME = "session-running"
const SENTINEL_SCHEMA_VERSION = 2

function sentinelPath(): string {
  return path.join(PATHS.APP_DIR, SENTINEL_FILENAME)
}

/** Write the sentinel file. Idempotent (overwrites). Best-effort —
 *  a failed write here must not abort boot. */
export function markSessionRunning(port?: number): void {
  try {
    fs.mkdirSync(PATHS.APP_DIR, { recursive: true })
    fs.writeFileSync(
      sentinelPath(),
      JSON.stringify({
        schemaVersion: SENTINEL_SCHEMA_VERSION,
        pid: process.pid,
        port: port ?? null,
        instanceId: process.env.MAXIMAL_INSTANCE_ID ?? null,
        parentPid: sidecarParentPid(),
        started_at: new Date().toISOString(),
      }),
    )
  } catch {
    /* best-effort */
  }
}

function sidecarParentPid(): number | null {
  const value = Number(process.env.MAXIMAL_SIDECAR_PARENT_PID)
  return Number.isSafeInteger(value) && value > 0 ? value : null
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

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    // EPERM: it exists but belongs to someone else.
    return (error as NodeJS.ErrnoException).code === "EPERM"
  }
}

interface SessionSentinelRecord {
  schemaVersion?: unknown
  pid?: unknown
  port?: unknown
}

/** Read both the original unversioned record and versioned records. Unknown
 * future schemas fail closed so their fields are not accidentally misread. */
function readSessionSentinel(): SessionSentinelRecord | undefined {
  // eslint-disable-next-line unicorn/prefer-json-parse-buffer -- JSON.parse's type only accepts string
  const parsed: unknown = JSON.parse(fs.readFileSync(sentinelPath(), "utf8"))
  if (typeof parsed !== "object" || parsed === null) return undefined

  const record = parsed as SessionSentinelRecord
  if (
    record.schemaVersion !== undefined
    && record.schemaVersion !== 1
    && record.schemaVersion !== SENTINEL_SCHEMA_VERSION
  ) {
    return undefined
  }
  return record
}

/** The port of the Maximal instance that wrote the sentinel, when that
 *  process is still alive; undefined when none is running (or a crashed
 *  run left the sentinel behind). */
export function runningSessionPort(): number | undefined {
  try {
    const { pid, port } = readSessionSentinel() ?? {}
    if (typeof pid !== "number" || typeof port !== "number") return undefined
    if (!Number.isInteger(port) || port < 1 || port > 65_535) return undefined
    return processAlive(pid) ? port : undefined
  } catch {
    return undefined
  }
}
