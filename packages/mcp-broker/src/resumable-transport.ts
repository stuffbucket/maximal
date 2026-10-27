import {
  isInitializeRequest,
  isJSONRPCErrorResponse,
  isJSONRPCRequest,
  isJSONRPCResponse,
  type JSONRPCMessage,
  type JSONRPCRequest,
  type MessageExtraInfo,
  type StreamableHTTPClientTransport,
  type Transport,
  type TransportSendOptions,
} from "@modelcontextprotocol/client"
import { setTimeout as delay } from "node:timers/promises"

/** How long to keep trying to reach Maximal and its broker: long enough for
 *  Maximal to start, or for its broker to restart and probe its servers. */
export const RECONNECT_WINDOW_MS = 60_000
/** How long a replayed initialize may take: the broker starts the session's
 *  own server instance first, and Work IQ's startup can take 30s. */
const REINITIALIZE_TIMEOUT_MS = 45_000
const FIRST_RETRY_MS = 250
const MAX_RETRY_MS = 2_000

/** Error codes that say nothing listened on the port (Node, then Bun). */
const REFUSED_CODES = new Set(["ECONNREFUSED", "ConnectionRefused"])

/** Each error in a cause chain, outermost first. */
const causes = function* (error: unknown): Generator<unknown> {
  let current = error
  for (let depth = 0; current !== undefined && depth < 8; depth += 1) {
    yield current
    current =
      typeof current === "object" && current !== null ?
        (current as { cause?: unknown }).cause
      : undefined
  }
}

const statusOf = (error: unknown): number | undefined => {
  const status = (error as { status?: unknown } | null)?.status
  return typeof status === "number" ? status : undefined
}

/**
 * Whether the request certainly never reached an MCP server, and Maximal or
 * its broker may just be starting: nothing listened on the port, or Maximal
 * answered 502/503 (its broker is down or still probing). Safe to retry.
 */
export const isUnreachable = (error: unknown): boolean => {
  for (const cause of causes(error)) {
    const code = (cause as { code?: unknown } | null)?.code
    if (typeof code === "string" && REFUSED_CODES.has(code)) return true
    const status = statusOf(cause)
    if (status === 502 || status === 503) return true
  }
  return false
}

/** Whether a request on an existing session failed because the session no
 *  longer exists: the broker answers 404 for a session it doesn't know,
 *  which is every session after it restarts. */
const isSessionLost = (error: unknown): boolean =>
  isUnreachable(error) || [...causes(error)].some((e) => statusOf(e) === 404)

/** Retry `attempt` with backoff while it fails with an unreachable error,
 *  until `deadline`; then (or on any other error) throw. */
export const retryWhileUnreachable = async <T>(
  attempt: () => Promise<T>,
  deadline: number,
): Promise<T> => {
  let wait = FIRST_RETRY_MS
  for (;;) {
    try {
      return await attempt()
    } catch (error) {
      if (!isUnreachable(error) || Date.now() + wait > deadline) throw error
      await delay(wait)
      wait = Math.min(wait * 2, MAX_RETRY_MS)
    }
  }
}

type HttpTransport = Pick<
  StreamableHTTPClientTransport,
  | "start"
  | "send"
  | "close"
  | "sessionId"
  | "setProtocolVersion"
  | "terminateSession"
  | "hasPerRequestStream"
> &
  Pick<Transport, "onclose" | "onerror" | "onmessage">

/**
 * A client transport that outlives its HTTP session. When the broker
 * restarts, every session it had is gone, and a request on one gets 404 (or
 * 503 while the broker comes back). This replays the `initialize` handshake
 * the client made on a fresh session and sends the request again there, so
 * the client above never notices. Only requests that certainly never reached
 * a server are sent again.
 */
export class ResumableTransport implements Transport {
  onclose?: () => void
  onerror?: (error: Error) => void
  onmessage?: (message: JSONRPCMessage, extra?: MessageExtraInfo) => void

  readonly hasPerRequestStream = true
  readonly #create: () => HttpTransport
  #inner: HttpTransport
  #initialize: JSONRPCRequest | undefined
  #protocolVersion: string | undefined
  #replacing: Promise<void> | undefined
  #replays = 0

  constructor(create: () => HttpTransport) {
    this.#create = create
    this.#inner = create()
    this.#attach(this.#inner)
  }

  get sessionId(): string | undefined {
    return this.#inner.sessionId
  }

  start(): Promise<void> {
    return this.#inner.start()
  }

  setProtocolVersion(version: string): void {
    this.#protocolVersion = version
    this.#inner.setProtocolVersion(version)
  }

  terminateSession(): Promise<void> {
    return this.#inner.terminateSession()
  }

  close(): Promise<void> {
    return this.#inner.close()
  }

  async send(
    message: JSONRPCMessage,
    options?: TransportSendOptions,
  ): Promise<void> {
    if (isJSONRPCRequest(message) && isInitializeRequest(message)) {
      this.#initialize = message
    }
    const inner = this.#inner
    try {
      await inner.send(message, options)
    } catch (error) {
      if (
        this.#initialize === undefined
        || isInitializeRequest(message)
        || inner.sessionId === undefined
        || !isSessionLost(error)
      ) {
        throw error
      }
      // Another request may have replaced the session already.
      if (this.#inner === inner) await this.#replaceSession()
      await this.#inner.send(message, options)
    }
  }

  #attach(inner: HttpTransport, onReply?: (message: JSONRPCMessage) => boolean): void {
    inner.onmessage = (message, extra) => {
      if (onReply?.(message)) return
      this.onmessage?.(message, extra)
    }
    inner.onerror = (error) => this.onerror?.(error)
    inner.onclose = () => {
      if (inner === this.#inner) this.onclose?.()
    }
  }

  #replaceSession(): Promise<void> {
    this.#replacing ??= this.#openSession().finally(() => {
      this.#replacing = undefined
    })
    return this.#replacing
  }

  async #openSession(): Promise<void> {
    const previous = this.#inner
    previous.onclose = undefined
    previous.onerror = undefined
    previous.onmessage = undefined
    // Its session is gone; closing only stops its event stream.
    void previous.close().catch(() => undefined)
    const deadline = Date.now() + RECONNECT_WINDOW_MS
    this.#inner = await retryWhileUnreachable(
      () => this.#handshake(),
      deadline,
    )
  }

  /** Initialize a fresh session the way the client did the first one. */
  async #handshake(): Promise<HttpTransport> {
    const initialize = this.#initialize
    if (!initialize) throw new Error("ADAPTER_NOT_INITIALIZED")
    this.#replays += 1
    const id = `maximal-adapter-reinitialize-${this.#replays}`
    const next = this.#create()
    let answered: (message: JSONRPCMessage) => void = () => undefined
    let timer: ReturnType<typeof setTimeout> | undefined
    const reply = new Promise<JSONRPCMessage>((resolve, reject) => {
      answered = resolve
      timer = setTimeout(() => {
        reject(new Error("ADAPTER_REINITIALIZE_TIMEOUT"))
      }, REINITIALIZE_TIMEOUT_MS)
    })
    // Awaited below; this only keeps an early failure from leaving it unhandled.
    reply.catch(() => undefined)
    this.#attach(next, (message) => {
      if (!isJSONRPCResponse(message) || message.id !== id) return false
      answered(message)
      return true
    })
    try {
      await next.start()
      await next.send({ ...initialize, id })
      const response = await reply
      if (isJSONRPCErrorResponse(response)) {
        throw new Error(`ADAPTER_REINITIALIZE_FAILED: ${response.error.message}`)
      }
      if (this.#protocolVersion) next.setProtocolVersion(this.#protocolVersion)
      await next.send({ jsonrpc: "2.0", method: "notifications/initialized" })
      return next
    } catch (error) {
      next.onclose = undefined
      await next.close().catch(() => undefined)
      throw error
    } finally {
      clearTimeout(timer)
    }
  }
}
