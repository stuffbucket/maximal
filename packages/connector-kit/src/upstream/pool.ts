import type {
  ToolCallContext,
  ToolResult,
} from "@stuffbucket/maximal-plugin-sdk"

import type { UpstreamConnection, UpstreamTool } from "./connection"

import { abortable } from "../util"

/** Key of the connection used when the caller has no downstream session. */
const SHARED = "\0shared"

export interface PoolOptions {
  /** Create and connect a new upstream session. */
  connect(signal: AbortSignal): Promise<UpstreamConnection>
  /** Close sessions idle for this long. Default 10 minutes. */
  idleMs?: number
  /** Most per-session upstream connections kept open (LRU idle eviction). Default 16. */
  maxSessions?: number
  /** Maximum wait for connection shutdown during pool disposal. Default 2500ms. */
  closeTimeoutMs?: number
  /**
   * A tool call opened a new shared connection after an earlier one closed
   * (an expired session, a reconnect): its `list_changed` subscription is
   * new, so changes in between were missed.
   */
  onSharedReconnect?(): void
}

function status(error: unknown): number | undefined {
  if (error === null || typeof error !== "object") return undefined
  const fields = error as { status?: unknown; data?: { status?: unknown } }
  if (typeof fields.status === "number") return fields.status
  return typeof fields.data?.status === "number" ?
      fields.data.status
    : undefined
}

/**
 * Upstream sessions: one MCP client per downstream session id (so
 * elicitation reaches the right user and upstream session state is not
 * shared between clients), closed after `idleMs` without use, plus a
 * shared connection for calls without a session id and for `tools/list`.
 */
export class UpstreamPool {
  readonly #options: PoolOptions
  readonly #idleMs: number
  readonly #maxSessions: number
  readonly #closeTimeoutMs: number
  readonly #connections = new Map<string, Promise<UpstreamConnection>>()
  readonly #closing = new Map<string, Promise<void>>()
  /** Calls using (or about to use) each key's connection; a sweep leaves those alone. */
  readonly #users = new Map<string, number>()
  /** A shared connection was opened before. */
  #sharedOpened = false
  readonly #lifetime = new AbortController()
  readonly #timer: ReturnType<typeof setInterval>

  constructor(options: PoolOptions) {
    this.#options = options
    this.#idleMs = options.idleMs ?? 10 * 60_000
    this.#maxSessions = options.maxSessions ?? 16
    this.#closeTimeoutMs = options.closeTimeoutMs ?? 2500
    this.#timer = setInterval(
      () => void this.sweep(),
      Math.max(10, Math.min(this.#idleMs / 2, 60_000)),
    )
    this.#timer.unref()
  }

  /** Number of open, opening, or closing upstream sessions still owned. */
  get size(): number {
    return this.#connections.size + this.#closing.size
  }

  async listTools(signal?: AbortSignal): Promise<Array<UpstreamTool>> {
    // Listing is the refresh itself: no `onSharedReconnect` for it.
    return await this.#with({ listing: true }, signal, (connection) =>
      connection.listTools(signal),
    )
  }

  async callTool(
    name: string,
    input: Record<string, unknown>,
    call: ToolCallContext,
  ): Promise<ToolResult> {
    return await this.#with(
      call.sessionId === undefined ? {} : { sessionId: call.sessionId },
      call.signal,
      (connection) => connection.callTool(name, input, call),
    )
  }

  /**
   * Close idle sessions; evict the least recently used idle ones over the
   * cap. The shared connection stays: it carries the `list_changed`
   * subscription the tool list depends on.
   */
  async sweep(now = Date.now()): Promise<void> {
    const settled: Array<[string, UpstreamConnection]> = []
    for (const [key, pending] of this.#connections) {
      if (key === SHARED) continue
      const connection = await pending.catch(() => undefined)
      if (connection && this.#connections.get(key) === pending)
        settled.push([key, connection])
    }
    const idle = settled
      .filter(([key, connection]) => !this.#inUse(key, connection))
      .sort(([, a], [, b]) => a.lastUsed - b.lastUsed)
    let excess = this.#connections.size - (this.#maxSessions + 1)
    for (const [key, connection] of idle) {
      if (now - connection.lastUsed >= this.#idleMs || excess > 0) {
        excess--
        await this.#drop(key, connection, true)
      }
    }
  }

  /** Release one downstream session's upstream state before generation migration. */
  async releaseSession(sessionId: string, signal?: AbortSignal): Promise<void> {
    const releaseSignal = this.#withLifetime(signal)
    const alreadyClosing = this.#closing.get(sessionId)
    if (alreadyClosing) {
      await abortable(alreadyClosing, releaseSignal)
      return
    }
    const pending = this.#connections.get(sessionId)
    if (!pending) return
    const connection = await abortable(pending, releaseSignal).catch(
      (error: unknown) => {
        if (releaseSignal.aborted) throw error
        return undefined
      },
    )
    if (!connection || this.#connections.get(sessionId) !== pending) return
    if (this.#inUse(sessionId, connection)) {
      throw new Error(`Upstream session "${sessionId}" is still in use.`)
    }
    this.#connections.delete(sessionId)
    await abortable(this.#ownClosing(sessionId, connection), releaseSignal)
  }

  /** Close every upstream session (sign-out, unload). The pool stays usable unless `dispose` was called. */
  async closeAll(): Promise<void> {
    const pending = [...this.#connections.entries()]
    this.#connections.clear()
    const starting = pending.map(async ([key, entry]) => {
      const connection = await entry.catch(() => undefined)
      if (connection) await this.#ownClosing(key, connection)
    })
    const all = Promise.allSettled([
      ...starting,
      ...this.#closing.values(),
    ]).then(() => undefined)
    await abortable(all, AbortSignal.timeout(this.#closeTimeoutMs)).catch(
      () => undefined,
    )
  }

  async dispose(): Promise<void> {
    clearInterval(this.#timer)
    this.#lifetime.abort()
    await this.closeAll()
    // The pool is permanently unusable after its lifetime aborts, so timed-out
    // closes no longer need to fence a replacement acquisition.
    this.#closing.clear()
  }

  #withLifetime(signal: AbortSignal | undefined): AbortSignal {
    return signal ?
        AbortSignal.any([signal, this.#lifetime.signal])
      : this.#lifetime.signal
  }

  #inUse(key: string, connection: UpstreamConnection): boolean {
    return connection.busy || (this.#users.get(key) ?? 0) > 0
  }

  async #acquire(
    key: string,
    signal: AbortSignal | undefined,
    announce: boolean,
  ): Promise<UpstreamConnection> {
    const acquisitionSignal = this.#withLifetime(signal)
    const closing = this.#closing.get(key)
    if (closing) await abortable(closing, acquisitionSignal)
    let pending = this.#connections.get(key)
    if (!pending) {
      this.#lifetime.signal.throwIfAborted()
      pending = this.#options.connect(this.#lifetime.signal)
      if (key === SHARED) {
        const reopened = this.#sharedOpened
        this.#sharedOpened = true
        if (reopened && announce)
          pending.then(
            () => this.#options.onSharedReconnect?.(),
            () => {},
          )
      }
      this.#connections.set(key, pending)
      pending.catch(() => {
        if (this.#connections.get(key) === pending)
          this.#connections.delete(key)
      })
      if (this.#connections.size > this.#maxSessions + 1) void this.sweep()
    }
    return await abortable(pending, acquisitionSignal)
  }

  /** Close `connection`; an idle `sweep` leaves it alone if a call picked it up meanwhile. */
  async #drop(
    key: string,
    connection: UpstreamConnection,
    idle = false,
  ): Promise<void> {
    const pending = this.#connections.get(key)
    const current =
      pending !== undefined
      && (await pending.catch(() => undefined)) === connection
    if (idle && this.#inUse(key, connection)) return
    if (current && this.#connections.get(key) === pending)
      this.#connections.delete(key)
    await this.#ownClosing(key, connection)
  }

  #ownClosing(key: string, connection: UpstreamConnection): Promise<void> {
    const existing = this.#closing.get(key)
    if (existing) return existing
    const closing = Promise.resolve()
      .then(() => connection.close())
      .finally(() => {
        if (this.#closing.get(key) === closing) this.#closing.delete(key)
      })
    this.#closing.set(key, closing)
    return closing
  }

  async #with<T>(
    target: { sessionId?: string; listing?: boolean },
    signal: AbortSignal | undefined,
    use: (connection: UpstreamConnection) => Promise<T>,
  ): Promise<T> {
    const key = target.sessionId ?? SHARED
    const announce = target.listing !== true
    this.#users.set(key, (this.#users.get(key) ?? 0) + 1)
    try {
      for (let attempt = 0; ; attempt++) {
        const connection = await this.#acquire(key, signal, announce)
        try {
          return await use(connection)
        } catch (error) {
          // 404: the upstream session expired; reconnect once.
          if (attempt === 0 && status(error) === 404 && !signal?.aborted) {
            await this.#drop(key, connection)
            continue
          }
          throw error
        }
      }
    } finally {
      const users = (this.#users.get(key) ?? 1) - 1
      if (users > 0) this.#users.set(key, users)
      else this.#users.delete(key)
    }
  }
}
