import { spawnSync } from "node:child_process"
import fs from "node:fs/promises"
import net from "node:net"
import path from "node:path"

import { PATHS } from "~/lib/platform/paths"

export const PIDFILE_PATH = path.join(PATHS.APP_DIR, "maximal.pid")

export interface EvictOptions {
  /** API key to send with the shutdown POST. Pass `null` when unknown
   *  — the request will still go out (loopback) without auth and the
   *  endpoint may choose to honor it or not. */
  apiKey: string | null
  /** Port to evict. Defaults to 4141 (the Tauri sidecar's port). */
  port?: number
  /** Polling deadline after sending shutdown, in ms. Default 3000. */
  drainTimeoutMs?: number
  /** SIGTERM → SIGKILL gap, in ms. Default 1500. */
  killEscalationMs?: number
  /** Injectable for tests. */
  now?: () => number
  /** Injectable for tests. */
  sleep?: (ms: number) => Promise<void>
  /** Injectable for tests. */
  kill?: (pid: number, signal: NodeJS.Signals | 0) => void
  /** Injectable for tests. Returns true if connect succeeded (port is
   *  held), false if it was refused. */
  probePort?: (port: number) => Promise<boolean>
  /** Injectable for tests. */
  readPidfile?: () => Promise<number | null>
  /** Injectable for tests. Returns the PID currently listening on `port`,
   *  or null if none/unknown. Used as a fallback when the pidfile is stale. */
  listenerPid?: (port: number) => number | null
  /** Injectable for tests. Drop-in replacement for global fetch. */
  fetchImpl?: typeof fetch
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** TCP connect probe. Resolves true if the port accepts a connection
 *  (something is listening), false otherwise. Bounded by a 100ms timeout
 *  so it never hangs in pathological cases. */
function defaultProbePort(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = new net.Socket()
    let settled = false
    const finish = (held: boolean): void => {
      if (settled) return
      settled = true
      socket.destroy()
      resolve(held)
    }
    socket.setTimeout(100)
    socket.once("connect", () => finish(true))
    socket.once("error", () => finish(false))
    socket.once("timeout", () => finish(false))
    socket.connect(port, "127.0.0.1")
  })
}

async function defaultReadPidfile(): Promise<number | null> {
  try {
    const raw = await fs.readFile(PIDFILE_PATH, "utf8")
    const pid = Number.parseInt(raw.trim(), 10)
    return Number.isInteger(pid) && pid > 0 ? pid : null
  } catch {
    return null
  }
}

/**
 * The security-critical half of the eviction guard, as a pure function so it
 * can be unit/mutation-tested without spawning `ps`. Given a process's command
 * line, decide whether it's a maximal *proxy* we're allowed to SIGKILL.
 *
 * Matches the bare `maximal` binary (CLI: `/…/maximal start …`; the Tauri
 * sidecar: `/…/Maximal.app/Contents/MacOS/maximal start …`) but deliberately
 * NOT `maximal-shell` (the menu-bar app — killing it would be wrong) and not
 * unrelated commands like `maximalist-editor`. A false positive here means we
 * SIGKILL the wrong process, so the boundary cases are covered by tests.
 */
export function looksLikeMaximalCommand(command: string): boolean {
  const cmd = command.trim().toLowerCase()
  return /(?:^|\/)maximal(?:\s|$)/.test(cmd) || cmd.includes("maximal start")
}

/** True if `pid`'s command line looks like a maximal proxy — the guard that
 *  keeps us from ever signalling an unrelated service that happens to hold
 *  the port. Reads the process command via `ps`; absence/failure → false. */
function isMaximalProcess(pid: number): boolean {
  try {
    const r = spawnSync("ps", ["-p", String(pid), "-o", "command="], {
      encoding: "utf8",
      timeout: 1000,
    })
    if (r.status !== 0) return false
    return looksLikeMaximalCommand(r.stdout)
  } catch {
    return false
  }
}

/** Find the PID listening on `port`, but only return it when it's a maximal
 *  process (see isMaximalProcess). Unix: `lsof -nP -iTCP:<port> -sTCP:LISTEN`.
 *  Best-effort — returns null if lsof is missing, the port is free, or the
 *  holder isn't ours. Windows is handled by the pidfile path only (no lsof);
 *  returning null there falls back to the existing behavior. */
function defaultListenerPid(port: number): number | null {
  if (process.platform === "win32") return null
  try {
    const r = spawnSync(
      "lsof",
      ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-t"],
      { encoding: "utf8", timeout: 1000 },
    )
    if (r.status !== 0 || !r.stdout.trim()) return null
    // `-t` yields bare PIDs, one per line. Take the first that is ours.
    for (const line of r.stdout.trim().split("\n")) {
      const pid = Number.parseInt(line.trim(), 10)
      if (Number.isInteger(pid) && pid > 0 && isMaximalProcess(pid)) {
        return pid
      }
    }
    return null
  } catch {
    return null
  }
}

/**
 * Cleanly take over the proxy port from a running instance.
 *
 * 1. Probe `/setup-status`. If unreachable → no-op.
 * 2. POST `/_internal/shutdown` with the API key. Ignore non-2xx.
 * 3. Poll TCP connect every 50ms until refused, capped at `drainTimeoutMs`.
 * 4. If still held, read pidfile → SIGTERM → wait → SIGKILL.
 * 5. Throw if the port is *still* held after kill.
 */
interface ResolvedEvictDeps {
  port: number
  drainTimeoutMs: number
  killEscalationMs: number
  sleep: (ms: number) => Promise<void>
  now: () => number
  kill: (pid: number, signal: NodeJS.Signals | 0) => void
  probePort: (port: number) => Promise<boolean>
  readPidfile: () => Promise<number | null>
  listenerPid: (port: number) => number | null
  fetchImpl: typeof fetch
}

function resolveDeps(opts: EvictOptions): ResolvedEvictDeps {
  return {
    port: opts.port ?? 4141,
    drainTimeoutMs: opts.drainTimeoutMs ?? 3000,
    killEscalationMs: opts.killEscalationMs ?? 1500,
    sleep: opts.sleep ?? defaultSleep,
    now: opts.now ?? Date.now,
    kill: opts.kill ?? ((pid, sig) => process.kill(pid, sig)),
    probePort: opts.probePort ?? defaultProbePort,
    readPidfile: opts.readPidfile ?? defaultReadPidfile,
    listenerPid: opts.listenerPid ?? defaultListenerPid,
    fetchImpl: opts.fetchImpl ?? fetch,
  }
}

/** HTTP probe + POST /_internal/shutdown. Returns false if the peer
 *  was unreachable (nothing to evict), true if the shutdown request
 *  was at least dispatched. The shutdown response status is ignored
 *  — we re-probe the port to decide success. */
async function requestShutdown(
  apiKey: string | null,
  deps: ResolvedEvictDeps,
): Promise<boolean> {
  const base = `http://127.0.0.1:${deps.port}`
  try {
    await deps.fetchImpl(`${base}/setup-status`, {
      signal: AbortSignal.timeout(100),
    })
  } catch {
    return false
  }
  const headers: Record<string, string> = {
    "content-type": "application/json",
  }
  if (apiKey) headers["x-api-key"] = apiKey
  try {
    await deps.fetchImpl(`${base}/_internal/shutdown`, {
      method: "POST",
      headers,
      signal: AbortSignal.timeout(1000),
    })
  } catch {
    // Peer may close the socket mid-response as part of shutting down.
  }
  return true
}

/** Poll the port every 50ms until refused, capped at `drainTimeoutMs`.
 *  Returns true if the port closed, false on deadline. */
async function waitForPortRelease(deps: ResolvedEvictDeps): Promise<boolean> {
  const deadline = deps.now() + deps.drainTimeoutMs
  while (deps.now() < deadline) {
    await deps.sleep(50)
    const held = await deps.probePort(deps.port)
    if (!held) return true
  }
  return false
}

export async function evictRunning(opts: EvictOptions): Promise<void> {
  const deps = resolveDeps(opts)

  const reachable = await requestShutdown(opts.apiKey, deps)

  // Even if the HTTP shutdown was unreachable (e.g. an older instance whose
  // /setup-status 404s, or one wedged before it can serve), the port may
  // still be held. Fall through to the kill path rather than returning — a
  // stuck listener is exactly the case --replace exists to clear.
  if (reachable && (await waitForPortRelease(deps))) return
  if (!reachable && !(await deps.probePort(deps.port))) return

  // First try the pidfile (cheap, no subprocess). Then, if the port is STILL
  // held — pidfile stale/dead, or a different proxy instance holds it — find
  // the actual listening maximal PID and evict that. This is what makes
  // --replace robust against a stale ~/.local/share/maximal/maximal.pid,
  // which otherwise left the real holder running and failed the takeover.
  const pidfilePid = await deps.readPidfile()
  if (pidfilePid !== null) await killEscalate(pidfilePid, deps)

  let lastPid = pidfilePid
  if (await deps.probePort(deps.port)) {
    const livePid = deps.listenerPid(deps.port)
    if (livePid !== null && livePid !== pidfilePid) {
      lastPid = livePid
      await killEscalate(livePid, deps)
    }
  }

  if (await deps.probePort(deps.port)) {
    const pidHint = lastPid !== null ? ` (last known pid ${lastPid})` : ""
    throw new Error(
      `Could not free :${deps.port}${pidHint}. Stop the holding process manually and retry.`,
    )
  }
}

/** SIGTERM → wait → kill(pid, 0) liveness probe → SIGKILL if still alive.
 *  Errors from any signal step are swallowed: ESRCH just means the
 *  process exited between probes, which is exactly what we want. */
async function killEscalate(
  pid: number,
  deps: Pick<ResolvedEvictDeps, "kill" | "sleep" | "killEscalationMs">,
): Promise<void> {
  const { kill, sleep, killEscalationMs } = deps
  try {
    kill(pid, "SIGTERM")
  } catch {
    return
  }
  await sleep(killEscalationMs)
  let stillAlive: boolean
  try {
    kill(pid, 0)
    stillAlive = true
  } catch {
    stillAlive = false
  }
  if (!stillAlive) return
  try {
    kill(pid, "SIGKILL")
  } catch {
    // Already gone between probe and kill — fine.
  }
  await sleep(200)
}

/** Write the current process PID to the pidfile. Called once after
 *  the server is listening. Errors are non-fatal — pidfile is a
 *  best-effort hint, not a correctness primitive. */
export async function writePidfile(pid: number = process.pid): Promise<void> {
  try {
    await fs.writeFile(PIDFILE_PATH, String(pid), { mode: 0o600 })
  } catch {
    // Pidfile is best-effort; ignore.
  }
}

/** Remove the pidfile. Called on graceful shutdown. */
export async function removePidfile(): Promise<void> {
  try {
    await fs.unlink(PIDFILE_PATH)
  } catch {
    // Already gone — fine.
  }
}
