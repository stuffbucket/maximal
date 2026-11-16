/* eslint-disable unicorn/prefer-add-event-listener -- MCP Transport exposes callback properties, not EventTarget. */
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

export const DEFAULT_RECONNECT_WINDOW_MS = 30_000
const REINITIALIZE_TIMEOUT_MS = 45_000
const FIRST_RETRY_MS = 250
const MAX_RETRY_MS = 2_000
const REFUSED_CODES = new Set(["ECONNREFUSED", "ConnectionRefused"])

function* causes(error: unknown): Generator {
  let current = error
  for (let depth = 0; current !== undefined && depth < 8; depth += 1) {
    yield current
    current =
      typeof current === "object" && current !== null ?
        (current as { cause?: unknown }).cause
      : undefined
  }
}

function statusOf(error: unknown): number | undefined {
  const status = (error as { status?: unknown } | null)?.status
  return typeof status === "number" ? status : undefined
}

/** A failure that proves an MCP request did not reach a usable server. */
export function isUnreachable(error: unknown): boolean {
  for (const cause of causes(error)) {
    const code = (cause as { code?: unknown } | null)?.code
    if (typeof code === "string" && REFUSED_CODES.has(code)) return true
    const status = statusOf(cause)
    if (status === 502 || status === 503) return true
  }
  return false
}

function isSessionLost(error: unknown): boolean {
  return (
    isUnreachable(error)
    || [...causes(error)].some((cause) => statusOf(cause) === 404)
  )
}

/** Retry only requests known not to have reached a usable MCP server. */
export async function retryWhileUnreachable<T>(
  attempt: () => Promise<T>,
  deadline: number,
): Promise<T> {
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
>
  & Pick<Transport, "onclose" | "onerror" | "onmessage">

/**
 * A transport that keeps the stdio peer stable across a Maximal restart. It
 * replays only the MCP handshake, then retries a request only after a failure
 * that proves the old session no longer exists or never received it.
 */
export class ResumableTransport implements Transport {
  onclose?: () => void
  onerror?: (error: Error) => void
  onmessage?: (message: JSONRPCMessage, extra?: MessageExtraInfo) => void

  readonly hasPerRequestStream = true
  readonly #create: () => HttpTransport
  readonly #reconnectWindowMs: number
  #inner: HttpTransport
  #initialize: JSONRPCRequest | undefined
  #protocolVersion: string | undefined
  #replacing: Promise<void> | undefined
  #replays = 0

  constructor(
    create: () => HttpTransport,
    reconnectWindowMs: number = DEFAULT_RECONNECT_WINDOW_MS,
  ) {
    this.#create = create
    this.#reconnectWindowMs = reconnectWindowMs
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
      await this.#sendInitial(message, options)
      return
    }
    const inner = this.#inner
    try {
      await inner.send(message, options)
    } catch (error) {
      if (
        this.#initialize === undefined
        || inner.sessionId === undefined
        || !isSessionLost(error)
      ) {
        throw error
      }
      if (this.#inner === inner) await this.#replaceSession()
      await this.#inner.send(message, options)
    }
  }

  async #sendInitial(
    message: JSONRPCMessage,
    options?: TransportSendOptions,
  ): Promise<void> {
    const deadline = Date.now() + this.#reconnectWindowMs
    await retryWhileUnreachable(async () => {
      const inner = this.#inner
      try {
        await inner.send(message, options)
      } catch (error) {
        if (isUnreachable(error) && this.#inner === inner) {
          await this.#replaceUninitialized(inner)
        }
        throw error
      }
    }, deadline)
  }

  async #replaceUninitialized(previous: HttpTransport): Promise<void> {
    this.#detach(previous)
    await previous.close().catch(() => undefined)
    const next = this.#create()
    this.#inner = next
    this.#attach(next)
    await next.start()
  }

  #attach(
    inner: HttpTransport,
    onReply?: (message: JSONRPCMessage) => boolean,
  ): void {
    inner.onmessage = (message, extra) => {
      if (onReply?.(message)) return
      this.onmessage?.(message, extra)
    }
    inner.onerror = (error) => this.onerror?.(error)
    inner.onclose = () => {
      if (inner === this.#inner) this.onclose?.()
    }
  }

  #detach(inner: HttpTransport): void {
    inner.onclose = undefined
    inner.onerror = undefined
    inner.onmessage = undefined
  }

  #replaceSession(): Promise<void> {
    this.#replacing ??= this.#openSession().finally(() => {
      this.#replacing = undefined
    })
    return this.#replacing
  }

  async #openSession(): Promise<void> {
    const previous = this.#inner
    this.#detach(previous)
    void previous.close().catch(() => undefined)
    const deadline = Date.now() + this.#reconnectWindowMs
    this.#inner = await retryWhileUnreachable(() => this.#handshake(), deadline)
  }

  async #handshake(): Promise<HttpTransport> {
    const initialize = this.#initialize
    if (!initialize) throw new Error("ADAPTER_NOT_INITIALIZED")
    this.#replays += 1
    const id = `maximal-adapter-reinitialize-${this.#replays}`
    const next = this.#create()
    const {
      promise: reply,
      resolve: answered,
      reject,
    } = Promise.withResolvers<JSONRPCMessage>()
    const timer = setTimeout(() => {
      reject(new Error("ADAPTER_REINITIALIZE_TIMEOUT"))
    }, REINITIALIZE_TIMEOUT_MS)
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
        throw new Error(
          `ADAPTER_REINITIALIZE_FAILED: ${response.error.message}`,
        )
      }
      if (this.#protocolVersion) next.setProtocolVersion(this.#protocolVersion)
      await next.send({ jsonrpc: "2.0", method: "notifications/initialized" })
      return next
    } catch (error) {
      this.#detach(next)
      await next.close().catch(() => undefined)
      throw error
    } finally {
      clearTimeout(timer)
    }
  }
}
