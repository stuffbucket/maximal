import { spawn, type ChildProcess } from 'node:child_process'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'

import { awaitReadyLine, parseBootStatus, sidecarSpawnEnv } from '@stuffbucket/maximal-core/supervisor'
import { app } from 'electron'

let child: ChildProcess | null = null
let controlBase = ''
let proxyBase = ''

/** Private JSON-RPC/HTTP+SSE origin used only by Electron main. */
export function controlOrigin(): string {
  return controlBase
}

/** Base URL where `/v1` is served for external programs. */
export function proxyUrl(): string {
  return proxyBase
}

/**
 * Resolve once the sidecar has an origin, rather than answering with `''`.
 *
 * `main/index.ts` creates the window BEFORE awaiting `spawnCore()`, so a
 * renderer reliably asks for the origin while `controlBase` is still empty.
 * Returning `''` made every cold launch build a client against an empty base
 * URL and emit a `net::ERR_FILE_NOT_FOUND` + `TypeError: Failed to fetch`
 * pair. It self-healed when `onCoreStatus` delivered the real origin, so it was
 * never user-visible — but "recovers" is not "correct", and a deterministic
 * error on every launch is noise that hides real ones.
 *
 * Deliberately NOT an unbounded wait. It settles on all three terminal phases:
 * `ready` resolves; `failed` rejects (the restart budget is spent, or the first
 * start threw); and `stopped` rejects, because `killCore()` never emits
 * `failed` — a deliberate quit is not a failure — so waiting only on `ready` or
 * `failed` left this promise unsettled forever when the user quit mid-startup.
 * An earlier version of this comment claimed the wait was bounded while the
 * code omitted `stopped`, which is the worst combination: a reader trusts the
 * comment and never checks. Hanging forever is the one outcome not allowed.
 */
function awaitOrigin(pick: () => string): Promise<string> {
  const current = pick()
  if (current) return Promise.resolve(current)
  if (lastStatus.phase === 'failed') {
    return Promise.reject(
      new Error(`maximal-core is not available: ${lastStatus.reason}`),
    )
  }
  if (lastStatus.phase === 'stopped') {
    return Promise.reject(
      new Error('maximal-core was stopped before it became available'),
    )
  }

  return new Promise<string>((resolve, reject) => {
    const stop = onCoreStatus((status) => {
      if (status.phase === 'ready') {
        stop()
        resolve(pick())
      } else if (status.phase === 'failed') {
        stop()
        reject(new Error(`maximal-core is not available: ${status.reason}`))
      } else if (status.phase === 'stopped') {
        stop()
        reject(new Error('maximal-core was stopped before it became available'))
      }
    })
  })
}

/** `controlOrigin()`, but waits for a real origin instead of returning `''`. */
export function awaitControlOrigin(): Promise<string> {
  return awaitOrigin(controlOrigin)
}

/** `proxyUrl()`, but waits for a real URL instead of returning `''`. */
export function awaitProxyUrl(): Promise<string> {
  return awaitOrigin(proxyUrl)
}

function binaryName(): string {
  return process.platform === 'win32' ? 'maximal-core.exe' : 'maximal-core'
}

function coreBinaryPath(): string {
  return app.isPackaged
    ? join(process.resourcesPath, 'bin', binaryName())
    : join(app.getAppPath(), 'resources', 'bin', binaryName())
}


/** Bounded so a sidecar that can never come up (bad binary, port permanently
 *  taken, etc.) does not spin the app forever. */
const MAX_RESTART_ATTEMPTS = 5
/** Backoff per attempt, indexed by `attempt - 1` and clamped to the last
 *  entry beyond that — capped rather than unbounded exponential growth. */
const RESTART_BACKOFF_MS = [1_000, 2_000, 5_000, 10_000, 20_000]

function backoffFor(attempt: number): number {
  return RESTART_BACKOFF_MS[Math.min(attempt - 1, RESTART_BACKOFF_MS.length - 1)] ?? 20_000
}

/**
 * Lifecycle state the main process can observe without polling.
 *
 * `boot-status` is a live relay of the sidecar's own boot narration.
 * `crashed`/`restarting`/`failed` cover the case this module previously had
 * no answer for: the sidecar dying *after* a successful start. `willRetry` on
 * `crashed` tells a listener whether a `restarting` event should be expected
 * next, or whether this crash was the one that hit the bound.
 */
export type CoreStatus =
  | { phase: 'starting' }
  | { phase: 'boot-status'; message: string }
  | { phase: 'ready'; controlOrigin: string; proxyUrl: string; pid: number }
  | {
      phase: 'crashed'
      code: number | null
      signal: NodeJS.Signals | null
      attempt: number
      willRetry: boolean
    }
  | { phase: 'restarting'; attempt: number; delayMs: number }
  | { phase: 'failed'; reason: string }
  | { phase: 'stopped' }

const statusListeners = new Set<(status: CoreStatus) => void>()
let lastStatus: CoreStatus = { phase: 'starting' }

/** Subscribe to lifecycle status. Returns an unsubscribe function. This
 *  module only narrates — a splash/status surface elsewhere decides what, if
 *  anything, to render. */
export function onCoreStatus(listener: (status: CoreStatus) => void): () => void {
  statusListeners.add(listener)
  return () => statusListeners.delete(listener)
}

/** The most recent status, for a late subscriber (e.g. a window created after
 *  boot) that needs the current state rather than only future transitions. */
export function currentCoreStatus(): CoreStatus {
  return lastStatus
}

function emitStatus(status: CoreStatus): void {
  lastStatus = status
  for (const listener of statusListeners) listener(status)
}

/** Route one line of sidecar stdout: boot-status markers become status
 *  events, everything else is just logged as before. */
function handleSidecarLine(line: string): void {
  const bootMessage = parseBootStatus(line)
  if (bootMessage !== null) {
    console.log('[core] boot:', bootMessage)
    emitStatus({ phase: 'boot-status', message: bootMessage })
    return
  }
  console.log('[core]', line)
}

/** Feed a stdout data stream through `handleSidecarLine` one whole line at a
 *  time. `awaitReadyLine` does its own line reassembly internally (and hands
 *  us already-split lines via `onLine`); this is the equivalent for the
 *  continued draining after readiness, so a marker straddling two `data`
 *  chunks is still recognised instead of only ever seen as raw chunk noise. */
function attachLineLogger(stdout: NonNullable<ChildProcess['stdout']>): void {
  let buffer = ''
  stdout.on('data', (chunk: Buffer) => {
    buffer += chunk.toString()
    let newline = buffer.indexOf('\n')
    while (newline >= 0) {
      const line = buffer.slice(0, newline)
      buffer = buffer.slice(newline + 1)
      if (line.trim()) handleSidecarLine(line)
      newline = buffer.indexOf('\n')
    }
  })
}

/** Set by `killCore()` so a post-ready exit it caused is never mistaken for a
 *  crash. Cleared at the start of a fresh `spawnCore()` call. */
let intentionalShutdown = false
let restartAttempts = 0
let restartTimer: ReturnType<typeof setTimeout> | null = null

function clearRestartTimer(): void {
  if (restartTimer) {
    clearTimeout(restartTimer)
    restartTimer = null
  }
}

/** How long a restarted sidecar must stay up before its `ready` is treated as
 *  proof the *process* recovered, not just that it can print a ready line.
 *  `useFirstRun`'s poll (3s, `useFirstRun.ts`) is the fastest thing that can
 *  provoke a crash right after boot, and `POLL_MS` is 3000 — so a stability
 *  window at that scale would still let a "dies on the first poll" sidecar
 *  reset its budget every cycle (review finding M2's actual failure). 30s is
 *  an order of magnitude past that: long enough that a crash tied to the
 *  first few control-plane requests never resets the counter, short enough
 *  that a genuinely-recovered sidecar (the case the reset exists for) isn't
 *  stuck on a depleted budget for long after a real transient blip. */
const RESTART_STABILITY_MS = 30_000
let stabilityTimer: ReturnType<typeof setTimeout> | null = null

function clearStabilityTimer(): void {
  if (stabilityTimer) {
    clearTimeout(stabilityTimer)
    stabilityTimer = null
  }
}

function scheduleRestart(attempt: number): void {
  const delayMs = backoffFor(attempt)
  emitStatus({ phase: 'restarting', attempt, delayMs })
  restartTimer = setTimeout(() => {
    restartTimer = null
    void attemptRestart()
  }, delayMs)
}

/** Re-run the same spawn+ready flow used for the initial start. Failures here
 *  (the restart itself never reaching readiness) count against the same
 *  bound as a post-ready crash — they do not get an independent retry budget. */
async function attemptRestart(): Promise<void> {
  try {
    await launchCore()
  } catch (error) {
    if (intentionalShutdown) return
    console.error('[core] restart attempt failed:', error)
    restartAttempts += 1
    if (restartAttempts > MAX_RESTART_ATTEMPTS) {
      emitStatus({
        phase: 'failed',
        reason: error instanceof Error ? error.message : String(error),
      })
      return
    }
    scheduleRestart(restartAttempts)
  }
}

/** Called when a previously-ready sidecar's process exits on its own — the gap
 *  this module used to have no answer for. Never fires for a `killCore()`-
 *  initiated exit (`intentionalShutdown` short-circuits it), and never
 *  restarts past `MAX_RESTART_ATTEMPTS`. */
function onUnexpectedExit(proc: ChildProcess, code: number | null, signal: NodeJS.Signals | null): void {
  if (intentionalShutdown) return
  // A newer launch may already have superseded this process; only the
  // currently-tracked child's death should trigger recovery.
  if (child !== proc) return

  child = null
  controlBase = ''
  proxyBase = ''
  clearStabilityTimer()

  restartAttempts += 1
  const attempt = restartAttempts
  const willRetry = attempt <= MAX_RESTART_ATTEMPTS
  emitStatus({ phase: 'crashed', code, signal, attempt, willRetry })

  if (!willRetry) {
    emitStatus({ phase: 'failed', reason: `sidecar crashed ${attempt} times; giving up` })
    return
  }
  scheduleRestart(attempt)
}

/** Spawn one isolated sidecar on an OS-assigned port and wait for its ready
 *  line. Shared by the initial start and every restart attempt, so both go
 *  through identical readiness/pid-check/drain/monitor wiring. */
async function launchCore(): Promise<{ controlOrigin: string; proxyUrl: string; port: number; pid: number }> {
  const dataHome = join(app.getPath('userData'), 'core-home')
  await mkdir(dataHome, { recursive: true })

  // `--port` is the PUBLIC PROXY port, not the control port. Passing `--port 0`
  // made the proxy ephemeral, which is why the UI advertised a random port to
  // point external programs at. Leave it unset: core prefers 4141 and, under the
  // default `next` port policy, moves to the following free port rather than
  // evicting anything — so a proxy already running on 4141 is left alone.
  // The private control port is separately ephemeral by default
  // (`resolveControlPort(undefined)` returns 0), which is what we want.
  const proc = spawn(coreBinaryPath(), ['start'], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      COPILOT_API_HOME: dataHome,
      ...sidecarSpawnEnv(),
    },
  })
  child = proc

  let isReady = false

  proc.stderr?.on('data', (chunk: Buffer) => console.error('[core]', chunk.toString().trimEnd()))
  proc.on('error', (error) => console.error('[core] process error:', error))
  proc.on('exit', (code, signal) => {
    console.log('[core] exited', { code, signal })
    if (isReady) onUnexpectedExit(proc, code, signal)
  })

  if (!proc.stdout) {
    proc.kill('SIGTERM')
    if (child === proc) child = null
    throw new Error('maximal-core stdout pipe was not created')
  }

  let removeReadinessFailureListeners = () => {}
  const failedBeforeReady = new Promise<never>((_resolve, reject) => {
    const onError = (error: Error) => reject(error)
    const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
      reject(new Error(`maximal-core exited before readiness (code=${String(code)}, signal=${String(signal)})`))
    }
    proc.once('error', onError)
    proc.once('exit', onExit)
    removeReadinessFailureListeners = () => {
      proc.off('error', onError)
      proc.off('exit', onExit)
    }
  })

  try {
    const ready = await Promise.race([
      awaitReadyLine(proc.stdout, {
        onLine: handleSidecarLine,
      }),
      failedBeforeReady,
    ])
    removeReadinessFailureListeners()

    if (proc.pid === undefined || ready.pid !== proc.pid) {
      throw new Error(`maximal-core ready-line pid ${ready.pid} did not match spawned pid ${String(proc.pid)}`)
    }

    // `killCore()` (or a newer launch superseding this one — see the
    // `child !== proc` guard `onUnexpectedExit` already applies) can land
    // while this function was awaiting the ready line. Neither can cancel the
    // in-flight await, so without this check a `killCore()` mid-startup would
    // be followed by a `ready` for a process already torn down: `controlBase`
    // pinned to a dead port, `restartAttempts` reset, and a `ready` emitted
    // after the `stopped` that already told everyone the app was shutting
    // down (review finding M3).
    if (intentionalShutdown || child !== proc) {
      throw new Error('maximal-core became ready after shutdown was requested; discarding')
    }

    isReady = true

    // awaitReadyLine deliberately leaves stdout open. Keep draining it for the
    // process lifetime or the pipe can fill and block the sidecar on a later log.
    attachLineLogger(proc.stdout)

    controlBase = `http://127.0.0.1:${ready.controlPort}`
    proxyBase = `http://127.0.0.1:${ready.proxyPort}`
    // A restart that reaches readiness has only proven the sidecar CAN come
    // up again — not that it stays up. Resetting the budget immediately here
    // let a sidecar that dies right after every ready line restart forever,
    // once per boot cycle, without ever reaching `failed` (review finding
    // M2). Reset only once this process has stayed alive for
    // `RESTART_STABILITY_MS`; the `child === proc` check in the callback
    // guards against a stale timer from a launch already superseded by a
    // later one firing after the fact.
    clearStabilityTimer()
    stabilityTimer = setTimeout(() => {
      stabilityTimer = null
      if (child === proc) restartAttempts = 0
    }, RESTART_STABILITY_MS)
    emitStatus({ phase: 'ready', controlOrigin: controlBase, proxyUrl: proxyBase, pid: ready.pid })
    return {
      controlOrigin: controlBase,
      proxyUrl: proxyBase,
      port: ready.proxyPort,
      pid: ready.pid,
    }
  } catch (error) {
    removeReadinessFailureListeners()
    if (!proc.killed) proc.kill('SIGTERM')
    if (child === proc) child = null
    throw error
  }
}

/** Spawn the sidecar for the first time this app run. Resets restart/shutdown
 *  bookkeeping so a fresh call (e.g. the app relaunching) is not haunted by a
 *  previous run's crash count. Recovery after a successful start is handled
 *  internally from here on — a caller only needs to await the first start. */
export async function spawnCore(): Promise<{ controlOrigin: string; proxyUrl: string; port: number; pid: number }> {
  intentionalShutdown = false
  restartAttempts = 0
  clearRestartTimer()
  clearStabilityTimer()
  emitStatus({ phase: 'starting' })
  try {
    return await launchCore()
  } catch (error) {
    // The FIRST start failing emitted nothing, so no listener ever learned —
    // not the renderer (whose first-run flow has a screen for exactly this),
    // and not `awaitControlOrigin()`, which waits for `ready` or `failed` and
    // would otherwise never settle. Post-ready crashes already emit `failed`
    // once the restart budget is spent; this makes the initial failure behave
    // the same way. Rethrown as well, so a caller that wants to react directly
    // still can.
    //
    // NOT when the shutdown was intentional. `killCore()` mid-startup makes
    // `launchCore()` reject too, but that is the user getting what they asked
    // for — `killCore()` has already emitted `stopped`, and overwriting it with
    // `failed` would put an error screen in front of someone who chose to quit.
    // Same distinction `attemptRestart()` and `onUnexpectedExit()` already make.
    if (!intentionalShutdown) {
      emitStatus({ phase: 'failed', reason: error instanceof Error ? error.message : String(error) })
    }
    throw error
  }
}

export function killCore(): void {
  intentionalShutdown = true
  clearRestartTimer()
  clearStabilityTimer()
  if (child && !child.killed) child.kill('SIGTERM')
  child = null
  controlBase = ''
  proxyBase = ''
  emitStatus({ phase: 'stopped' })
}
