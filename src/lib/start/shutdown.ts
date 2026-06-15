/**
 * Shutdown plumbing: SIGTERM / SIGINT handlers + optional parent-death
 * watchdog (Tauri spawns the sidecar with MAXIMAL_SIDECAR_PARENT_PID
 * so the sidecar self-terminates if the shell crashes without sending
 * SIGTERM). Drain order, including the Claude Code revert step, is
 * documented inline in initiateShutdown().
 */

import type { serve } from "srvx"

import consola from "consola"

import { reconcileClaudeCodeOnShutdown } from "~/lib/claude-code-reconcile"
import { removePidfile } from "~/lib/replace-running"

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

  clearTimeout(watchdog)
  process.exit(0)
}

/** Wire SIGTERM + optional parent-death watchdog. The watchdog only
 *  runs when MAXIMAL_SIDECAR_PARENT_PID is set (Tauri shell spawn);
 *  bare CLI users own their own lifecycle. */
export function installShutdownHandlers(
  httpServer: ReturnType<typeof serve>,
): void {
  process.on("SIGTERM", () => {
    void initiateShutdown(httpServer, "received SIGTERM")
  })
  process.on("SIGINT", () => {
    void initiateShutdown(httpServer, "received SIGINT")
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
