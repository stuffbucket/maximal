/**
 * Leak signals that work in Bun. `process.getActiveResourcesInfo()` exists
 * but always returns `[]` there, so the tracker instead wraps the timer
 * globals, `Bun.serve` and `listen` on node's `net` / `http` servers while
 * it runs, and reports what was created in that window and is still live:
 * intervals, timeouts that have not fired, and servers still listening.
 */
import http from "node:http"
import net from "node:net"

export type LiveHandleKind = "interval" | "timeout" | "server"

export interface LiveHandle {
  kind: LiveHandleKind
  /** Timer delay (ms); the bound address for servers. */
  detail: string
  /** Where it was created (top stack frames, test runner frames dropped). */
  stack: Array<string>
}

export interface HandleTracker {
  /**
   * Handles created since `start` that are still live. Timeouts shorter
   * than `minTimeoutMs` (default 1000) are left out: they fire on their own.
   */
  live(options?: { minTimeoutMs?: number }): Array<LiveHandle>
  /** Restore the globals. Idempotent. */
  stop(): void
}

interface Entry {
  kind: LiveHandleKind
  delay: number
  stack: Array<string>
  isLive: () => boolean
  detail: () => string
}

type TimerFn = (
  callback: (...args: Array<unknown>) => void,
  ms?: number,
  ...args: Array<unknown>
) => unknown

let active: HandleTracker | undefined

function captureStack(): Array<string> {
  const stack = new Error("handle").stack ?? ""
  return stack
    .split("\n")
    .slice(1)
    .map((line) => line.trim())
    .filter(
      (line) =>
        line.startsWith("at ")
        && !line.includes("/testing/leaks.ts")
        && !line.includes("node:"),
    )
    .slice(0, 6)
}

type Entries = Map<unknown, Entry>
type Restore = () => void
type AnyFunction = (...args: Array<unknown>) => unknown

/** Wrap the timer globals; timeouts leave the map when they fire or are cleared. */
function patchTimers(entries: Entries): Restore {
  const g = globalThis as unknown as Record<string, unknown>
  const original = {
    setTimeout: g.setTimeout as TimerFn,
    setInterval: g.setInterval as TimerFn,
    clearTimeout: g.clearTimeout as (handle: unknown) => void,
    clearInterval: g.clearInterval as (handle: unknown) => void,
  }
  const entry = (
    handle: unknown,
    kind: "timeout" | "interval",
    ms: number | undefined,
  ): Entry => {
    const delay = ms ?? 0
    return {
      kind,
      delay,
      stack: captureStack(),
      isLive: () => entries.has(handle),
      detail: () => `${delay} ms`,
    }
  }
  const forget = (handle: unknown) => {
    if (entries.delete(handle) || typeof handle !== "number") return
    for (const key of entries.keys()) {
      if (Number(key) === handle) {
        entries.delete(key)
        return
      }
    }
  }
  g.setTimeout = (callback: unknown, ms?: number, ...args: Array<unknown>) => {
    if (typeof callback !== "function")
      return original.setTimeout(callback as never, ms, ...args)
    const box: { handle?: unknown } = {}
    const fire = (...callArgs: Array<unknown>) => {
      entries.delete(box.handle)
      ;(callback as AnyFunction)(...callArgs)
    }
    box.handle = original.setTimeout(fire, ms, ...args)
    entries.set(box.handle, entry(box.handle, "timeout", ms))
    return box.handle
  }
  g.setInterval = (callback: unknown, ms?: number, ...args: Array<unknown>) => {
    const handle = original.setInterval(callback as never, ms, ...args)
    entries.set(handle, entry(handle, "interval", ms))
    return handle
  }
  g.clearTimeout = (handle: unknown) => {
    forget(handle)
    original.clearTimeout(handle)
  }
  g.clearInterval = (handle: unknown) => {
    forget(handle)
    original.clearInterval(handle)
  }
  return () => {
    Object.assign(g, original)
  }
}

/** Wrap `Bun.serve`; a server is live until its `stop()`. */
function patchBunServe(entries: Entries): Restore {
  const bun = Bun as unknown as { serve: typeof Bun.serve }
  const original = bun.serve
  bun.serve = ((...args: Parameters<typeof Bun.serve>) => {
    const server = original.apply(Bun, args)
    let stopped = false
    const stop = server.stop.bind(server)
    Object.defineProperty(server, "stop", {
      configurable: true,
      value: (closeActiveConnections?: boolean) => {
        stopped = true
        return stop(closeActiveConnections)
      },
    })
    entries.set(server, {
      kind: "server",
      delay: 0,
      stack: captureStack(),
      isLive: () => !stopped,
      detail: () => `Bun.serve ${server.url.href}`,
    })
    return server
  }) as typeof Bun.serve
  return () => {
    bun.serve = original
  }
}

/** Wrap `listen` on a node server prototype; a server is live while `listening`. */
function patchListen(
  entries: Entries,
  prototype: { listen: AnyFunction },
): Restore {
  const original = prototype.listen
  prototype.listen = function listen(
    this: net.Server,
    ...args: Array<unknown>
  ) {
    entries.set(this, {
      kind: "server",
      delay: 0,
      stack: captureStack(),
      isLive: () => this.listening,
      detail: () => {
        const address = this.address()
        return typeof address === "object" && address ?
            `listen ${address.address}:${address.port}`
          : `listen ${String(address)}`
      },
    })
    return original.apply(this, args)
  }
  return () => {
    prototype.listen = original
  }
}

/**
 * Start tracking. One tracker at a time (a second `trackHandles` throws until
 * the first is stopped). Call `stop()` in a `finally`.
 */
export function trackHandles(): HandleTracker {
  if (active) throw new Error("trackHandles: a tracker is already running.")
  const entries: Entries = new Map()
  const restores = [
    patchTimers(entries),
    patchBunServe(entries),
    patchListen(
      entries,
      net.Server.prototype as unknown as { listen: AnyFunction },
    ),
    patchListen(
      entries,
      http.Server.prototype as unknown as { listen: AnyFunction },
    ),
  ]
  let stopped = false
  const tracker: HandleTracker = {
    live({ minTimeoutMs = 1000 } = {}) {
      return [...entries.values()]
        .filter((entry) => entry.isLive())
        .filter(
          (entry) => entry.kind !== "timeout" || entry.delay >= minTimeoutMs,
        )
        .map((entry) => ({
          kind: entry.kind,
          detail: entry.detail(),
          stack: entry.stack,
        }))
    },
    stop() {
      if (stopped) return
      stopped = true
      active = undefined
      for (const restore of restores.reverse()) restore()
    },
  }
  active = tracker
  return tracker
}
