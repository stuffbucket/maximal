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
  readonly #connections = new Map<string, Promise<UpstreamConnection>>()
  readonly #lifetime = new AbortController()
  readonly #timer: ReturnType<typeof setInterval>

  constructor(options: PoolOptions) {
    this.#options = options
    this.#idleMs = options.idleMs ?? 10 * 60_000
    this.#maxSessions = options.maxSessions ?? 16
    this.#timer = setInterval(
      () => void this.sweep(),
      Math.max(10, Math.min(this.#idleMs / 2, 60_000)),
    )
    this.#timer.unref()
  }

  /** Number of open (or opening) upstream sessions. */
  get size(): number {
    return this.#connections.size
  }

  async listTools(signal?: AbortSignal): Promise<Array<UpstreamTool>> {
    return await this.#with(undefined, signal, (connection) =>
      connection.listTools(signal),
    )
  }

  async callTool(
    name: string,
    input: Record<string, unknown>,
    call: ToolCallContext,
  ): Promise<ToolResult> {
    return await this.#with(call.sessionId, call.signal, (connection) =>
      connection.callTool(name, input, call),
    )
  }

  /** Close idle sessions; evict the least recently used idle ones over the cap. */
  async sweep(now = Date.now()): Promise<void> {
    const settled: Array<[string, UpstreamConnection]> = []
    for (const [key, pending] of this.#connections) {
      const connection = await pending.catch(() => undefined)
      if (connection && this.#connections.get(key) === pending)
        settled.push([key, connection])
    }
    const idle = settled
      .filter(([, connection]) => !connection.busy)
      .sort(([, a], [, b]) => a.lastUsed - b.lastUsed)
    let excess = this.#connections.size - (this.#maxSessions + 1)
    for (const [key, connection] of idle) {
      if (now - connection.lastUsed >= this.#idleMs || excess > 0) {
        excess--
        await this.#drop(key, connection)
      }
    }
  }

  /** Close every upstream session (sign-out, unload). The pool stays usable unless `dispose` was called. */
  async closeAll(): Promise<void> {
    const pending = [...this.#connections.values()]
    this.#connections.clear()
    await Promise.all(
      pending.map(async (entry) =>
        (await entry.catch(() => undefined))?.close(),
      ),
    )
  }

  async dispose(): Promise<void> {
    clearInterval(this.#timer)
    this.#lifetime.abort()
    await this.closeAll()
  }

  async #acquire(
    key: string,
    signal: AbortSignal | undefined,
  ): Promise<UpstreamConnection> {
    let pending = this.#connections.get(key)
    if (!pending) {
      this.#lifetime.signal.throwIfAborted()
      pending = this.#options.connect(this.#lifetime.signal)
      this.#connections.set(key, pending)
      pending.catch(() => {
        if (this.#connections.get(key) === pending)
          this.#connections.delete(key)
      })
      if (this.#connections.size > this.#maxSessions + 1) void this.sweep()
    }
    return await abortable(pending, signal)
  }

  async #drop(key: string, connection: UpstreamConnection): Promise<void> {
    const pending = this.#connections.get(key)
    if (pending && (await pending.catch(() => undefined)) === connection)
      this.#connections.delete(key)
    await connection.close()
  }

  async #with<T>(
    sessionId: string | undefined,
    signal: AbortSignal | undefined,
    use: (connection: UpstreamConnection) => Promise<T>,
  ): Promise<T> {
    const key = sessionId ?? SHARED
    for (let attempt = 0; ; attempt++) {
      const connection = await this.#acquire(key, signal)
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
  }
}
