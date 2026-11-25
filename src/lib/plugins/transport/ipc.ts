/* eslint-disable complexity, default-case, @typescript-eslint/use-unknown-in-catch-callback-variable -- frame priority and channel failure paths are exhaustive protocol branches */
import {
  createProtocolCallRegistry,
  decodeFrame,
  PLUGIN_API_VERSION,
  PLUGIN_PROTOCOL_VERSION,
  ProtocolError,
  ProtocolFence,
  PROTOCOL_LIMITS,
  type FrameType,
  type ProtocolFrame,
} from "@stuffbucket/maximal-plugin-protocol"

import {
  FairBoundedQueue,
  type QueueLimits,
  type TransportPriority,
} from "~/lib/plugins/transport/queue"

const HANDSHAKE_TAG = "maximal-plugin-handshake" as const
const HANDSHAKE_KEYS = new Set([
  "tag",
  "kind",
  "role",
  "nonce",
  "generation",
  "protocol",
  "pluginApi",
])
const DEFAULT_QUEUE_LIMITS: QueueLimits = {
  maxMessages: 512,
  maxBytes: 8 * 1024 * 1024,
}

export type IpcRole = "parent" | "runner"

interface HandshakeMessage {
  tag: typeof HANDSHAKE_TAG
  kind: "hello" | "ack"
  role: IpcRole
  nonce: string
  generation: string
  protocol: typeof PLUGIN_PROTOCOL_VERSION
  pluginApi: typeof PLUGIN_API_VERSION
}

interface HandshakeCandidate {
  tag: typeof HANDSHAKE_TAG
  kind?: unknown
  role?: unknown
  nonce?: unknown
  generation?: unknown
  protocol?: unknown
  pluginApi?: unknown
}

export interface IpcPort {
  send(message: unknown): boolean | undefined | Promise<boolean | undefined>
  onMessage(listener: (message: unknown) => void): () => void
  onDisconnect(listener: () => void): () => void
  onDrain?(listener: () => void): () => void
  disconnect?(): void
}

export interface IpcTransportOptions {
  role: IpcRole
  generation: string
  nonce: string
  queueLimits?: Partial<QueueLimits>
  heartbeatIntervalMs?: number
  heartbeatTimeoutMs?: number
  now?: () => number
  onProtocolError?: (error: Error) => void
}

export interface FrameDraft {
  type: FrameType
  callId?: string
  revision?: number
  payload: unknown
}

interface QueuedFrame {
  draft: FrameDraft
  frame?: ProtocolFrame
}

export interface IpcTransportStats {
  inboundMessages: number
  inboundBytes: number
  outboundMessages: number
  outboundBytes: number
  lastReceivedAt: number
  lastHeartbeatAt: number
}

function encodedBytes(value: unknown): number {
  let encoded: string
  try {
    encoded = JSON.stringify(value)
  } catch (error) {
    throw new ProtocolError(
      "malformed",
      "IPC value is not JSON serializable.",
      {
        cause: error,
      },
    )
  }
  return new TextEncoder().encode(encoded).byteLength
}

function handshake(
  kind: HandshakeMessage["kind"],
  role: IpcRole,
  options: Pick<IpcTransportOptions, "nonce" | "generation">,
): HandshakeMessage {
  return {
    tag: HANDSHAKE_TAG,
    kind,
    role,
    nonce: options.nonce,
    generation: options.generation,
    protocol: PLUGIN_PROTOCOL_VERSION,
    pluginApi: PLUGIN_API_VERSION,
  }
}

function isHandshake(value: unknown): value is HandshakeCandidate {
  if (!value || typeof value !== "object") return false
  return "tag" in value && value.tag === HANDSHAKE_TAG
}

function priorityFor(type: FrameType): TransportPriority {
  switch (type) {
    case "cancel":
    case "drain":
    case "heartbeat":
    case "shutdown":
    case "spend-ack": {
      return "control"
    }
    case "error":
    case "elicitation":
    case "elicitation-reply":
    case "host-request":
    case "host-result":
    case "provider-request":
    case "provider-result":
    case "request":
    case "result":
    case "spend": {
      return "interactive"
    }
    case "progress":
    case "ready":
    case "resync":
    case "snapshot":
    case "state-event": {
      return "bulk"
    }
  }
}

function opposite(role: IpcRole): IpcRole {
  return role === "parent" ? "runner" : "parent"
}

/**
 * Authenticated, bounded Bun-IPC channel. Protocol bytes never use stdout/stderr.
 * The caller feeds Bun's `ipc(message)` callback into an IpcPort implementation.
 */
export class BunIpcTransport {
  readonly #port: IpcPort
  readonly #options: Required<
    Pick<
      IpcTransportOptions,
      | "role"
      | "generation"
      | "nonce"
      | "heartbeatIntervalMs"
      | "heartbeatTimeoutMs"
      | "now"
    >
  >
    & Pick<IpcTransportOptions, "onProtocolError">
  readonly #outbound: FairBoundedQueue<QueuedFrame>
  readonly #inbound: FairBoundedQueue<ProtocolFrame>
  readonly #outboundFence: ProtocolFence
  readonly #inboundFence: ProtocolFence
  readonly #closedSignal: Promise<Error>
  readonly #listeners = new Set<(frame: ProtocolFrame) => void>()
  readonly #closeListeners = new Set<(error: Error) => void>()
  readonly #unsubscribers: Array<() => void> = []
  readonly #stats: IpcTransportStats
  #nextOutboundSequence = 0
  #nextId = 0
  #resolveClosed: ((error: Error) => void) | undefined
  #ready = false
  #closedError: Error | undefined
  #outboundPumping = false
  #inboundPumping = false
  #waitingForDrain = false
  #resolveConnected: (() => void) | undefined
  #rejectConnected: ((error: Error) => void) | undefined
  #heartbeatTimer: ReturnType<typeof setInterval> | undefined
  #livenessTimer: ReturnType<typeof setInterval> | undefined

  readonly connected: Promise<void>

  constructor(port: IpcPort, options: IpcTransportOptions) {
    this.#port = port
    const limits = { ...DEFAULT_QUEUE_LIMITS, ...options.queueLimits }
    this.#outbound = new FairBoundedQueue(limits)
    this.#inbound = new FairBoundedQueue(limits)
    const now = options.now ?? Date.now
    this.#options = {
      role: options.role,
      generation: options.generation,
      nonce: options.nonce,
      heartbeatIntervalMs: options.heartbeatIntervalMs ?? 5_000,
      heartbeatTimeoutMs: options.heartbeatTimeoutMs ?? 20_000,
      now,
      onProtocolError: options.onProtocolError,
    }
    const registry = createProtocolCallRegistry()
    this.#outboundFence = new ProtocolFence(
      { generation: options.generation },
      registry,
      options.role,
    )
    this.#inboundFence = new ProtocolFence(
      { generation: options.generation },
      registry,
      opposite(options.role),
    )
    this.#closedSignal = new Promise((resolve) => {
      this.#resolveClosed = resolve
    })
    const started = now()
    this.#stats = {
      inboundMessages: 0,
      inboundBytes: 0,
      outboundMessages: 0,
      outboundBytes: 0,
      lastReceivedAt: started,
      lastHeartbeatAt: started,
    }
    this.connected = new Promise<void>((resolve, reject) => {
      this.#resolveConnected = resolve
      this.#rejectConnected = reject
    })
    this.#unsubscribers.push(
      port.onMessage((message) => this.#receive(message)),
      port.onDisconnect(() =>
        this.#fail(new ProtocolError("closed", "IPC peer disconnected.")),
      ),
    )
    if (port.onDrain) {
      this.#unsubscribers.push(
        port.onDrain(() => {
          this.#waitingForDrain = false
          this.#pumpOutbound()
        }),
      )
    }
    if (options.role === "parent") {
      void this.#sendRaw(handshake("hello", "parent", options)).catch((error) =>
        this.#fail(this.#asError(error)),
      )
    }
  }

  get stats(): Readonly<IpcTransportStats> {
    return { ...this.#stats }
  }

  get closed(): boolean {
    return this.#closedError !== undefined
  }

  subscribe(listener: (frame: ProtocolFrame) => void): () => void {
    this.#listeners.add(listener)
    return () => this.#listeners.delete(listener)
  }

  onClose(listener: (error: Error) => void): () => void {
    if (this.#closedError) {
      listener(this.#closedError)
      return () => undefined
    }
    this.#closeListeners.add(listener)
    return () => this.#closeListeners.delete(listener)
  }

  async send(draft: FrameDraft): Promise<ProtocolFrame> {
    await this.connected
    if (this.#closedError) throw this.#closedError
    const preflight = decodeFrame(
      this.#candidate(draft, Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER),
      { generation: this.#options.generation },
    )
    const item: QueuedFrame = {
      draft: {
        type: preflight.type,
        ...(preflight.callId === undefined ? {} : { callId: preflight.callId }),
        ...(preflight.revision === undefined ?
          {}
        : { revision: preflight.revision }),
        payload: preflight.payload,
      },
    }
    const bytes = encodedBytes(preflight)
    const queued = this.#outbound.enqueue(
      item,
      bytes,
      priorityFor(preflight.type),
    )
    this.#pumpOutbound()
    try {
      await queued
    } catch (error) {
      const failure = this.#asError(error)
      this.#fail(failure)
      throw failure
    }
    if (!item.frame) throw new ProtocolError("closed", "Frame was not sent.")
    return item.frame
  }

  close(reason = "Transport closed."): void {
    this.#fail(new ProtocolError("closed", reason))
    this.#port.disconnect?.()
  }

  #receive(message: unknown): void {
    if (this.#closedError) return
    try {
      const bytes = encodedBytes(message)
      if (bytes > PROTOCOL_LIMITS.envelopeBytes) {
        throw new ProtocolError(
          "oversize",
          "IPC message exceeds envelope limit.",
        )
      }
      if (!this.#ready) {
        this.#acceptHandshake(message)
        return
      }
      if (isHandshake(message)) {
        throw new ProtocolError("malformed", "Unexpected repeated handshake.")
      }
      const frame = this.#inboundFence.accept(message)
      this.#stats.lastReceivedAt = this.#options.now()
      if (frame.type === "heartbeat") {
        this.#stats.lastHeartbeatAt = this.#stats.lastReceivedAt
      }
      const queued = this.#inbound.enqueue(
        frame,
        bytes,
        priorityFor(frame.type),
      )
      this.#pumpInbound()
      void queued.catch((error) => this.#fail(this.#asError(error)))
    } catch (error) {
      this.#fail(this.#asError(error))
    }
  }

  #acceptHandshake(message: unknown): void {
    if (!isHandshake(message)) {
      throw new ProtocolError(
        "malformed",
        "Protocol frame arrived before handshake.",
      )
    }
    const expectedKind = this.#options.role === "parent" ? "ack" : "hello"
    const expectedRole = opposite(this.#options.role)
    const keys = Object.keys(message)
    if (
      keys.length !== HANDSHAKE_KEYS.size
      || keys.some((key) => !HANDSHAKE_KEYS.has(key))
      || message.kind !== expectedKind
      || message.role !== expectedRole
      || message.nonce !== this.#options.nonce
      || message.generation !== this.#options.generation
      || message.protocol !== PLUGIN_PROTOCOL_VERSION
      || message.pluginApi !== PLUGIN_API_VERSION
    ) {
      throw new ProtocolError(
        "version-mismatch",
        "IPC handshake did not match exactly.",
      )
    }
    if (this.#options.role === "runner") {
      void this.#sendRaw(handshake("ack", "runner", this.#options)).catch(
        (error) => this.#fail(this.#asError(error)),
      )
    }
    this.#ready = true
    this.#resolveConnected?.()
    this.#resolveConnected = undefined
    this.#rejectConnected = undefined
    this.#startLiveness()
  }

  #candidate(draft: FrameDraft, sequence: number, id: number): unknown {
    return {
      protocol: PLUGIN_PROTOCOL_VERSION,
      pluginApi: PLUGIN_API_VERSION,
      generation: this.#options.generation,
      id: `${this.#options.role}-${id}`,
      seq: sequence,
      type: draft.type,
      ...(draft.callId === undefined ? {} : { callId: draft.callId }),
      ...(draft.revision === undefined ? {} : { revision: draft.revision }),
      payload: draft.payload,
    }
  }

  #waitForDrain(): void {
    if (!this.#port.onDrain) {
      throw new ProtocolError(
        "closed",
        "IPC backpressure has no drain notification.",
      )
    }
    this.#waitingForDrain = true
  }

  #pumpOutbound(): void {
    if (this.#outboundPumping || this.#waitingForDrain || this.#closedError)
      return
    this.#outboundPumping = true
    void (async () => {
      try {
        while (!this.#waitingForDrain && !this.#closedError) {
          const entry = this.#outbound.shift()
          if (!entry) break
          try {
            const frame = this.#outboundFence.accept(
              this.#candidate(
                entry.value.draft,
                this.#nextOutboundSequence++,
                this.#nextId++,
              ),
            )
            const bytes = encodedBytes(frame)
            const writable = await this.#sendRaw(frame)
            entry.value.frame = frame
            this.#stats.outboundMessages += 1
            this.#stats.outboundBytes += bytes
            entry.delivered()
            if (!writable) this.#waitForDrain()
          } catch (error) {
            entry.failed(this.#asError(error))
            throw error
          }
        }
      } catch (error) {
        this.#fail(this.#asError(error))
      } finally {
        this.#outboundPumping = false
      }
    })()
  }

  #pumpInbound(): void {
    if (this.#inboundPumping || this.#closedError) return
    this.#inboundPumping = true
    queueMicrotask(() => {
      try {
        while (!this.#closedError) {
          const entry = this.#inbound.shift()
          if (!entry) break
          this.#stats.inboundMessages += 1
          this.#stats.inboundBytes += encodedBytes(entry.value)
          entry.delivered()
          for (const listener of this.#listeners) listener(entry.value)
        }
      } catch (error) {
        this.#fail(this.#asError(error))
      } finally {
        this.#inboundPumping = false
        if (this.#inbound.size > 0) this.#pumpInbound()
      }
    })
  }

  #startLiveness(): void {
    const interval = this.#options.heartbeatIntervalMs
    if (interval > 0) {
      this.#heartbeatTimer = setInterval(() => {
        void this.send({
          type: "heartbeat",
          payload: {
            monotonicMs: Math.max(0, Math.floor(performance.now())),
            inflight: 0,
          },
        }).catch((error) => this.#fail(this.#asError(error)))
      }, interval)
      this.#heartbeatTimer.unref()
    }
    const timeout = this.#options.heartbeatTimeoutMs
    if (timeout > 0) {
      this.#livenessTimer = setInterval(
        () => {
          if (this.#options.now() - this.#stats.lastReceivedAt > timeout) {
            this.#fail(new ProtocolError("closed", "IPC heartbeat timed out."))
          }
        },
        Math.max(10, Math.min(timeout / 2, interval || timeout / 2)),
      )
      this.#livenessTimer.unref()
    }
  }

  async #sendRaw(message: unknown): Promise<boolean> {
    const write = Promise.resolve(this.#port.send(message))
    const result = await Promise.race([
      write,
      this.#closedSignal.then((error) => Promise.reject(error)),
    ])
    return result !== false
  }

  #fail(error: Error): void {
    if (this.#closedError) return
    this.#closedError = error
    this.#resolveClosed?.(error)
    this.#resolveClosed = undefined
    try {
      this.#options.onProtocolError?.(error)
    } catch {
      // Diagnostics cannot interrupt channel teardown.
    }
    this.#rejectConnected?.(error)
    this.#resolveConnected = undefined
    this.#rejectConnected = undefined
    if (this.#heartbeatTimer) clearInterval(this.#heartbeatTimer)
    if (this.#livenessTimer) clearInterval(this.#livenessTimer)
    this.#outbound.close(error)
    this.#inbound.close(error)
    for (const unsubscribe of this.#unsubscribers.splice(0)) unsubscribe()
    for (const listener of this.#closeListeners) listener(error)
    this.#closeListeners.clear()
    this.#listeners.clear()
  }

  #asError(error: unknown): Error {
    return error instanceof Error ? error : new Error(String(error))
  }
}
