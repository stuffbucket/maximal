/**
 * Shutdown plumbing: SIGTERM / SIGINT handlers + an `exit`-event
 * safety-net reverter + optional parent-death watchdog. Tauri spawns
 * the sidecar with MAXIMAL_SIDECAR_PARENT_PID so the sidecar self-
 * terminates if the shell crashes without sending SIGTERM. Drain
 * order, including the Claude Code revert step, is documented inline
 * in initiateShutdown().
 *
 * Coverage matrix for the Claude Code base-URL revert:
 *   - SIGTERM / SIGINT          → initiateShutdown ✓
 *   - process.exit(n) anywhere  → `exit` event safety net ✓
 *   - uncaught exception        → `exit` event safety net ✓
 *   - Tauri parent died         → parent-pid watchdog → initiateShutdown ✓
 *   - SIGKILL / OS-level kill   → ✗ no userspace runs. Sentinel-based
 *                                  warning on next boot (run-server.ts)
 *                                  diagnoses but can't auto-recover.
 */

import type { serve } from "srvx"

import consola from "consola"

import { reconcileClaudeCodeOnShutdown } from "~/lib/claude-code-reconcile"
import { removePidfile } from "~/lib/replace-running"

import { clearSessionRunning } from "./session-sentinel"

// Idempotency guard so SIGTERM racing with the parent-death watchdog
// (or being delivered twice) doesn't double-stop the server.
let shuttingDown = false

/** Stop the HTTP server, then exit 0. Capped at ~2.5s by an unref'd
 *  watchdog timer so a hung close() can't keep the process alive. */
export async function initiateShutdown(
  httpServer: ReturnType<typeof serve>,
  reason: string,
): Promise<void> {
  if (shuttingDown) return
  shuttingDown = true

  consola.info(`shutdown: ${reason}, draining`)

  // Take Claude Code off the proxy before we stop accepting connections,
  // so `claude` isn't stranded over a dead base URL. Ownership-guarded and
  // intent-gated (no-op when routing is off); the intent flag persists, so
  // the next boot re-applies it. Synchronous + best-effort — a slow/failed
  // file write must not delay or block the drain.
  reconcileClaudeCodeOnShutdown()

  // Fail-safe: if close() hangs, hard-exit after 2.5s. .unref() so the
  // timer itself never holds the loop open in the happy path.
  const watchdog = setTimeout(() => {
    consola.warn("shutdown: watchdog tripped, forcing exit")
    process.exit(1)
  }, 2500)
  watchdog.unref()

  try {
    // srvx Server exposes close(); pass true to drop in-flight conns.
    await httpServer.close(true)
  } catch (error) {
    consola.warn("shutdown: server.close() threw", error)
  }

  // Pidfile is a hint, not a lock — best-effort cleanup.
  await removePidfile()

  // Drop the "session running" sentinel so the NEXT boot doesn't
  // misread a clean shutdown as a crash.
  clearSessionRunning()

  clearTimeout(watchdog)
  process.exit(0)
}

/** Wire SIGTERM + an `exit`-event safety net + optional parent-death
 *  watchdog. The watchdog only runs when MAXIMAL_SIDECAR_PARENT_PID
 *  is set (Tauri shell spawn); bare CLI users own their own lifecycle.
 *
 *  The `exit` listener is a last-chance synchronous reverter for the
 *  Claude Code base URL. Node fires `exit` on:
 *    - any process.exit(n) call (from anywhere in the codebase)
 *    - the default-throw behaviour of unhandledRejection
 *    - an uncaughtException reaching the top-level handler
 *  …none of which currently route through initiateShutdown(). The
 *  reverter is idempotent (no-op when the URL is absent or foreign),
 *  so it's safe even when initiateShutdown ALSO runs first. */
export function installShutdownHandlers(
  httpServer: ReturnType<typeof serve>,
): void {
  process.on("SIGTERM", () => {
    void initiateShutdown(httpServer, "received SIGTERM")
  })
  process.on("SIGINT", () => {
    void initiateShutdown(httpServer, "received SIGINT")
  })

  // Safety net: synchronous revert on any Node-controlled exit path,
  // including process.exit() and uncaughtException. Doesn't run on
  // SIGKILL or OS-level termination — those need an external watchdog
  // (the boot-time stale-session warning surfaces them after the fact).
  process.on("exit", () => {
    try {
      reconcileClaudeCodeOnShutdown()
    } catch {
      // exit handlers can't throw — and we're exiting anyway.
    }
    try {
      clearSessionRunning()
    } catch {
      // same — best-effort.
    }
  })

  const parentPidStr = process.env.MAXIMAL_SIDECAR_PARENT_PID
  const parentPid = parentPidStr ? Number(parentPidStr) : null

  if (parentPid && Number.isInteger(parentPid) && parentPid > 0) {
    consola.info(`shutdown: watching parent pid ${parentPid}`)
    const interval = setInterval(() => {
      try {
        // kill(pid, 0) is the POSIX "is this process alive" probe —
        // sends no signal, throws ESRCH if the parent is gone.
        process.kill(parentPid, 0)
      } catch {
        clearInterval(interval)
        consola.warn(`shutdown: parent ${parentPid} gone`)
        void initiateShutdown(httpServer, `parent ${parentPid} exited`)
      }
    }, 3000)
    interval.unref()
  }
}
