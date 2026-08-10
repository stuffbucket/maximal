import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'

import { describe, expect, it, vi } from 'vitest'

// core.ts imports `app` from 'electron' at module scope. Outside a real
// Electron process the `electron` package's main export is a synchronous
// side-effecting lookup for the platform binary path (see
// node_modules/electron/index.js), not the { app, BrowserWindow, ... } API —
// requiring it unmocked in a plain Node/Vitest process throws or attempts a
// download. Stub the one export core.ts actually touches.
vi.mock('electron', () => ({
  app: {
    isPackaged: false,
    getAppPath: () => '/tmp/maximal-client-test',
    getPath: () => '/tmp/maximal-client-test/userData',
  },
}))

// core.ts spawns the real `maximal-core` binary via `node:child_process`'s
// `spawn`. Testing the restart/shutdown-race logic in `launchCore()` (M2,
// M3) needs a controllable fake process rather than a real sidecar binary —
// `spawnMock` is hoisted so the mock factory below can reference it.
const { spawnMock } = vi.hoisted(() => ({ spawnMock: vi.fn() }))
vi.mock('node:child_process', () => ({ spawn: (...args: unknown[]) => spawnMock(...args) }))

/** A minimal stand-in for Node's `ChildProcess`: an `EventEmitter` with a
 *  real `stdout`/`stderr` (`PassThrough`, so `awaitReadyLine`'s async-iterator
 *  read and `attachLineLogger`'s `data` listener both work unmodified) and a
 *  `kill()` that marks `killed` and emits `exit` — matching what `core.ts`
 *  reads off a real `ChildProcess`. */
class FakeChildProcess extends EventEmitter {
  static nextPid = 1000
  readonly pid: number
  readonly stdout = new PassThrough()
  readonly stderr = new PassThrough()
  killed = false

  constructor() {
    super()
    this.pid = FakeChildProcess.nextPid++
  }

  kill(signal?: NodeJS.Signals): boolean {
    if (this.killed) return true
    this.killed = true
    queueMicrotask(() => this.emit('exit', null, signal ?? 'SIGTERM'))
    return true
  }
}

/** Writes a `@@MAXIMAL_READY@@` line matching the real sidecar's wire format
 *  (see `@stuffbucket/maximal-core/supervisor`'s `parseReadyLine`), so
 *  `awaitReadyLine` resolves exactly as it would against a real process. */
function writeReadyLine(proc: FakeChildProcess, ports: { controlPort: number; proxyPort: number }): void {
  const line = { v: 1, controlPort: ports.controlPort, proxyPort: ports.proxyPort, pid: proc.pid }
  proc.stdout.write(`@@MAXIMAL_READY@@ ${JSON.stringify(line)}\n`)
}

// core.ts keeps its lifecycle state (child, controlBase/proxyBase, lastStatus)
// in module-scope variables, so each test gets its own fresh instance via
// `vi.resetModules()` + a dynamic re-import rather than sharing state (and
// therefore test order) with its siblings.
async function freshCore() {
  vi.resetModules()
  spawnMock.mockReset()
  return import('./core')
}

describe('core lifecycle status (no sidecar spawned)', () => {
  it('reports "starting" as the initial phase before spawnCore/killCore ever run', async () => {
    const { currentCoreStatus } = await freshCore()

    expect(currentCoreStatus()).toEqual({ phase: 'starting' })
  })

  it('killCore() is safe pre-spawn, resets both origins, and publishes "stopped" to subscribers', async () => {
    const { killCore, controlOrigin, proxyUrl, currentCoreStatus, onCoreStatus } = await freshCore()

    const seen: unknown[] = []
    onCoreStatus((status) => seen.push(status))

    // Guards `if (child && !child.killed)`: without it, killing before any
    // spawnCore() call would dereference a null child.
    expect(() => killCore()).not.toThrow()

    expect(controlOrigin()).toBe('')
    expect(proxyUrl()).toBe('')
    expect(currentCoreStatus()).toEqual({ phase: 'stopped' })
    expect(seen).toEqual([{ phase: 'stopped' }])
  })

  it('rejects origin reads made after the sidecar has already stopped', async () => {
    const { awaitControlOrigin, awaitProxyUrl, killCore } = await freshCore()
    killCore()

    await expect(awaitControlOrigin()).rejects.toThrow(
      'maximal-core was stopped before it became available',
    )
    await expect(awaitProxyUrl()).rejects.toThrow(
      'maximal-core was stopped before it became available',
    )
  })

  it('rejects origin reads made after startup has already failed', async () => {
    const { awaitControlOrigin, spawnCore } = await freshCore()
    spawnMock.mockImplementationOnce(() => {
      throw new Error('cannot spawn sidecar')
    })

    await expect(spawnCore()).rejects.toThrow('cannot spawn sidecar')
    await expect(awaitControlOrigin()).rejects.toThrow(
      'maximal-core is not available: cannot spawn sidecar',
    )
  })

  it('onCoreStatus()\'s unsubscribe function stops further delivery to that listener', async () => {
    const { killCore, onCoreStatus } = await freshCore()

    const seen: unknown[] = []
    const unsubscribe = onCoreStatus((status) => seen.push(status))
    unsubscribe()

    killCore()

    expect(seen).toEqual([])
  })
})

describe('launchCore ready-vs-shutdown race (review finding M3)', () => {
  it('discards a ready line that arrives after killCore() was called mid-startup', async () => {
    const { spawnCore, killCore, currentCoreStatus } = await freshCore()

    const proc = new FakeChildProcess()
    spawnMock.mockReturnValueOnce(proc)

    const spawnPromise = spawnCore()

    // Both calls below are synchronous, with no `await` between them — this
    // reproduces the real race the review flagged: the ready line has been
    // written (so `awaitReadyLine`'s pending read is about to resolve) at the
    // exact moment `killCore()` runs, before `launchCore()` gets a chance to
    // resume and check anything.
    writeReadyLine(proc, { controlPort: 5000, proxyPort: 6000 })
    killCore()

    // killCore() already published "stopped" — the assertion that matters is
    // that nothing later overwrites it with a "ready" for a process that is
    // already gone.
    expect(currentCoreStatus()).toEqual({ phase: 'stopped' })

    await expect(spawnPromise).rejects.toThrow(/became ready after shutdown was requested/)
    expect(currentCoreStatus()).toEqual({ phase: 'stopped' })
  })
})

describe('restart attempt budget (review finding M2)', () => {
  it('does not reset the attempt counter just because a restart reaches ready — only a stability window does', async () => {
    vi.useFakeTimers()
    try {
      const { spawnCore, onCoreStatus } = await freshCore()

      const statuses: Array<{ phase: string; [key: string]: unknown }> = []
      onCoreStatus((status) => statuses.push(status))

      const proc1 = new FakeChildProcess()
      spawnMock.mockReturnValueOnce(proc1)

      const spawnPromise = spawnCore()
      writeReadyLine(proc1, { controlPort: 1001, proxyPort: 2001 })
      await spawnPromise

      // First crash: a fresh boot dying counts as attempt 1.
      const proc2 = new FakeChildProcess()
      spawnMock.mockReturnValueOnce(proc2)
      proc1.emit('exit', 1, null)
      await vi.waitFor(() => {
        expect(statuses.some((s) => s.phase === 'crashed' && s.attempt === 1)).toBe(true)
      })

      // Advance past the attempt-1 backoff so the restart actually spawns —
      // without this, the restart is still sitting in `restartTimer`.
      await vi.advanceTimersByTimeAsync(1_000)
      writeReadyLine(proc2, { controlPort: 1002, proxyPort: 2002 })
      await vi.waitFor(() => {
        expect(statuses.some((s) => s.phase === 'ready' && s.pid === proc2.pid)).toBe(true)
      })

      // The restart reached `ready`, but nowhere near the 30s stability
      // window (review finding M2's fix) — crashing again immediately must
      // count as attempt 2, not reset back to a fresh attempt 1. Before the
      // fix, the reset happened synchronously on `ready`, so this crash would
      // have reported attempt: 1 again, and a sidecar that dies right after
      // every ready line would restart forever without ever reaching
      // `failed`.
      proc2.emit('exit', 1, null)
      await vi.waitFor(() => {
        expect(statuses.some((s) => s.phase === 'crashed' && s.attempt === 2)).toBe(true)
      })
    } finally {
      vi.useRealTimers()
    }
  })
})
