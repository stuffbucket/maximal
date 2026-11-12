/* eslint-disable complexity, default-case, max-lines, max-params, no-nested-ternary, require-atomic-updates, @typescript-eslint/use-unknown-in-catch-callback-variable -- one exhaustive duplex state machine keeps frame races centralized */
import {
  errorToWireError,
  ProtocolError,
  wireErrorToError,
  type JsonValue,
  type ProtocolFrame,
  type WireErrorDto,
} from "@stuffbucket/maximal-plugin-protocol"

import type {
  BunIpcTransport,
  FrameDraft,
  IpcRole,
} from "~/lib/plugins/transport/ipc"

const TERMINAL_HISTORY_LIMIT = 4_096

export type RpcKind = "request" | "provider" | "host"

export interface RpcProgress {
  progress: number
  total?: number
  message?: string
}

export interface ElicitationReply {
  action: "accept" | "decline" | "cancel"
  content?: JsonValue
}

export interface RpcCallOptions {
  signal?: AbortSignal
  onProgress?: (progress: RpcProgress) => void
  onElicit?: (
    message: string,
    requestedSchema: JsonValue,
  ) => Promise<ElicitationReply>
}

export interface RpcContext {
  callId: string
  signal: AbortSignal
  progress(progress: RpcProgress): Promise<void>
  elicit(message: string, requestedSchema: JsonValue): Promise<ElicitationReply>
  reportSpend(
    invocationId: string,
    providerCallId: string,
    amount: number,
    evidence?: JsonValue,
  ): Promise<void>
  callProvider(method: string, params: JsonValue): Promise<JsonValue>
  callHost(method: string, params: JsonValue): Promise<JsonValue>
}

export type RpcHandler = (params: JsonValue, context: RpcContext) => unknown

interface OutboundCall {
  kind: RpcKind | "elicitation"
  correlationId?: string
  state: "open" | "cancelled" | "terminal"
  resolve: (value: JsonValue | ElicitationReply) => void
  reject: (error: Error) => void
  onProgress?: (progress: RpcProgress) => void
  onElicit?: RpcCallOptions["onElicit"]
  removeAbort?: () => void
}

type CancelledCall = Pick<OutboundCall, "kind" | "correlationId">

interface InboundCall {
  kind: RpcKind | "elicitation"
  correlationId?: string
  controller: AbortController
  terminalSent: boolean
  terminalPromise?: Promise<void>
  cancelled: boolean
  spends: Set<Promise<void>>
  nested: Set<Promise<unknown>>
}

export interface DispatcherEvents {
  onStateEvent?: (event: JsonValue, revision: number) => void
  onSnapshot?: (
    snapshot: JsonValue,
    revision: number,
    controlEpoch: number,
  ) => void
  onReady?: (frame: Extract<ProtocolFrame, { type: "ready" }>) => void
  onResync?: (expectedRevision: number, reason: string) => void
  onDrain?: (deadlineMs: number, reason: string) => void
  onShutdown?: (graceful: boolean, reason?: string) => void
  onSpend?: (
    callId: string,
    invocationId: string,
    providerCallId: string,
    amount: number,
    evidence?: JsonValue,
  ) => void | Promise<void>
}

function isJsonValue(value: unknown): value is JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean")
    return true
  if (typeof value === "number") return Number.isFinite(value)
  if (Array.isArray(value)) return value.every((item) => isJsonValue(item))
  if (!value || typeof value !== "object") return false
  if (Object.getPrototypeOf(value) !== Object.prototype) return false
  return Object.values(value).every((item) => isJsonValue(item))
}

function abortError(reason?: unknown): Error {
  const error = new Error(
    typeof reason === "string" && reason.length > 0 ? reason : "Aborted",
  )
  error.name = "AbortError"
  return error
}

function fallbackWireError(error: unknown): WireErrorDto {
  const aborted = error instanceof Error && error.name === "AbortError"
  return errorToWireError(error, {
    kind: aborted ? "aborted" : "internal",
    code: aborted ? "aborted" : "handler_failed",
    retry: aborted ? "never" : "unknown",
  })
}

/** Fully duplex dispatcher. One subscription drives all forward and reverse RPC. */
export class DuplexRpcDispatcher {
  readonly #transport: BunIpcTransport
  readonly #role: IpcRole
  readonly #events: DispatcherEvents
  readonly #handlers: Record<RpcKind, Map<string, RpcHandler>> = {
    request: new Map(),
    provider: new Map(),
    host: new Map(),
  }
  readonly #outbound = new Map<string, OutboundCall>()
  readonly #cancelled = new Map<string, CancelledCall>()
  readonly #cancelledOrder: Array<string> = []
  readonly #inbound = new Map<string, InboundCall>()
  readonly #spendAcks = new Map<
    string,
    { resolve: () => void; reject: (error: Error) => void }
  >()
  readonly #receivedSpends = new Map<string, Promise<void>>()
  readonly #completedSpends = new Set<string>()
  readonly #completedSpendOrder: Array<string> = []
  readonly #terminalHistory = new Set<string>()
  readonly #terminalOrder: Array<string> = []
  #unsubscribe: () => void = () => undefined
  #unsubscribeClose: () => void = () => undefined
  #nextCall = 0
  #closedError: Error | undefined

  constructor(
    transport: BunIpcTransport,
    role: IpcRole,
    events: DispatcherEvents = {},
  ) {
    this.#transport = transport
    this.#role = role
    this.#events = events
    this.#unsubscribe = transport.subscribe((frame) => this.#receive(frame))
    this.#unsubscribeClose = transport.onClose((error) => this.#close(error))
  }

  get inflight(): number {
    return this.#outbound.size + this.#inbound.size
  }

  register(kind: RpcKind, method: string, handler: RpcHandler): () => void {
    const handlers = this.#handlers[kind]
    if (handlers.has(method)) {
      throw new Error(`RPC handler already registered: ${kind}:${method}`)
    }
    handlers.set(method, handler)
    return () => {
      if (handlers.get(method) === handler) handlers.delete(method)
    }
  }

  call(
    method: string,
    params: JsonValue,
    options: RpcCallOptions = {},
  ): Promise<JsonValue> {
    return this.#startCall("request", method, params, options)
  }

  callProvider(
    method: string,
    params: JsonValue,
    options: RpcCallOptions = {},
  ): Promise<JsonValue> {
    return this.#startCall("provider", method, params, options)
  }

  callHost(method: string, params: JsonValue): Promise<JsonValue> {
    return this.#startCall("host", method, params)
  }

  dispose(reason = "Dispatcher disposed."): void {
    this.#close(new ProtocolError("closed", reason))
    this.#transport.close(reason)
  }

  async #startCall(
    kind: RpcKind,
    method: string,
    params: JsonValue,
    options: RpcCallOptions = {},
  ): Promise<JsonValue> {
    if (this.#closedError) throw this.#closedError
    if (options.signal?.aborted) throw abortError(options.signal.reason)
    const callId = `${this.#role}:${this.#nextCall++}`
    const correlationId =
      kind === "provider" || kind === "host" ? callId : undefined
    const result = new Promise<JsonValue | ElicitationReply>(
      (resolve, reject) => {
        const call: OutboundCall = {
          kind,
          correlationId,
          state: "open",
          resolve,
          reject,
          onProgress: options.onProgress,
          onElicit: options.onElicit,
        }
        if (options.signal) {
          const onAbort = (): void => {
            if (call.state !== "open") return
            call.state = "cancelled"
            this.#outbound.delete(callId)
            call.removeAbort?.()
            this.#rememberCancelled(callId, call)
            reject(abortError(options.signal?.reason))
            void this.#transport
              .send({
                type: "cancel",
                callId,
                payload: {
                  ...(typeof options.signal?.reason === "string" ?
                    { reason: options.signal.reason }
                  : {}),
                },
              })
              .catch(() => undefined)
          }
          options.signal.addEventListener("abort", onAbort, { once: true })
          call.removeAbort = () =>
            options.signal?.removeEventListener("abort", onAbort)
        }
        this.#outbound.set(callId, call)
      },
    )
    const type =
      kind === "request" ? "request"
      : kind === "provider" ? "provider-request"
      : "host-request"
    let payload: unknown
    if (kind === "provider") {
      payload = { providerCallId: correlationId ?? callId, method, params }
    } else if (kind === "host") {
      payload = { hostCallId: correlationId ?? callId, method, params }
    } else {
      payload = { method, params }
    }
    try {
      await this.#transport.send({ type, callId, payload })
    } catch (error) {
      this.#settleSendFailure(callId, error)
    }
    return result.then((value) => {
      if (!isJsonValue(value)) {
        throw new ProtocolError("malformed", "RPC result is not JSON.")
      }
      return value
    })
  }

  #receive(frame: ProtocolFrame): void {
    try {
      switch (frame.type) {
        case "request":
        case "provider-request":
        case "host-request": {
          this.#dispatchInbound(frame)
          return
        }
        case "result":
        case "error":
        case "provider-result":
        case "host-result":
        case "elicitation-reply": {
          this.#receiveTerminal(frame)
          return
        }
        case "cancel": {
          this.#receiveCancel(frame.callId)
          return
        }
        case "progress": {
          this.#receiveProgress(frame)
          return
        }
        case "elicitation": {
          this.#receiveElicitation(frame)
          return
        }
        case "spend": {
          void this.#receiveSpend(frame).catch((error) =>
            this.#transport.close(
              error instanceof Error ? error.message : "Spend handling failed.",
            ),
          )
          return
        }
        case "spend-ack": {
          this.#receiveSpendAck(frame)
          return
        }
        case "state-event": {
          if (frame.revision === undefined)
            throw new ProtocolError("malformed", "State event has no revision.")
          this.#events.onStateEvent?.(frame.payload.event, frame.revision)
          return
        }
        case "snapshot": {
          if (frame.revision === undefined)
            throw new ProtocolError("malformed", "Snapshot has no revision.")
          this.#events.onSnapshot?.(
            frame.payload.snapshot,
            frame.revision,
            frame.payload.controlEpoch,
          )
          return
        }
        case "ready": {
          this.#events.onReady?.(frame)
          return
        }
        case "resync": {
          this.#events.onResync?.(
            frame.payload.expectedRevision,
            frame.payload.reason,
          )
          return
        }
        case "drain": {
          this.#events.onDrain?.(frame.payload.deadlineMs, frame.payload.reason)
          return
        }
        case "shutdown": {
          this.#events.onShutdown?.(
            frame.payload.graceful,
            frame.payload.reason,
          )
          return
        }
        case "heartbeat": {
          return
        }
      }
    } catch (error) {
      this.#transport.close(
        error instanceof Error ? error.message : "Dispatcher protocol failure.",
      )
    }
  }

  #dispatchInbound(
    frame: Extract<
      ProtocolFrame,
      { type: "request" | "provider-request" | "host-request" }
    >,
  ): void {
    const callId = frame.callId
    if (
      !callId
      || this.#inbound.has(callId)
      || this.#terminalHistory.has(callId)
    ) {
      throw new ProtocolError(
        "out-of-order",
        "Inbound call identity is not unique.",
      )
    }
    const kind: RpcKind =
      frame.type === "request" ? "request"
      : frame.type === "provider-request" ? "provider"
      : "host"
    const method = frame.payload.method
    const correlationId =
      frame.type === "provider-request" ? frame.payload.providerCallId
      : frame.type === "host-request" ? frame.payload.hostCallId
      : undefined
    const controller = new AbortController()
    const call: InboundCall = {
      kind,
      correlationId,
      controller,
      terminalSent: false,
      cancelled: false,
      spends: new Set(),
      nested: new Set(),
    }
    this.#inbound.set(callId, call)
    const handler = this.#handlers[kind].get(method)
    void this.#runInbound(callId, frame.payload.params, call, handler).catch(
      (error) =>
        this.#transport.close(
          error instanceof Error ? error.message : "Inbound RPC failed.",
        ),
    )
  }

  async #runInbound(
    callId: string,
    params: JsonValue,
    call: InboundCall,
    handler: RpcHandler | undefined,
  ): Promise<void> {
    try {
      if (!handler) throw new Error(`No RPC handler for ${call.kind}.`)
      const value = await handler(params, this.#context(callId, call))
      await Promise.all(call.nested)
      await Promise.all(call.spends)
      if (call.cancelled) throw abortError(call.controller.signal.reason)
      await this.#sendInboundTerminal(callId, call, value)
    } catch (error) {
      await Promise.allSettled(call.spends)
      await this.#sendInboundError(callId, call, error)
    } finally {
      this.#inbound.delete(callId)
      this.#rememberTerminal(callId)
    }
  }

  #context(callId: string, call: InboundCall): RpcContext {
    return {
      callId,
      signal: call.controller.signal,
      progress: async (progress) => {
        if (call.cancelled || call.terminalSent) return
        await this.#transport.send({
          type: "progress",
          callId,
          payload: progress,
        })
      },
      elicit: (message, requestedSchema) =>
        this.#trackNested(
          call,
          this.#startElicitation(
            callId,
            message,
            requestedSchema,
            call.controller.signal,
          ),
        ),
      reportSpend: (invocationId, providerCallId, amount, evidence) => {
        if (call.cancelled || call.terminalSent) {
          return Promise.reject(abortError(call.controller.signal.reason))
        }
        const pending = this.#reportSpend(
          callId,
          invocationId,
          providerCallId,
          amount,
          evidence,
        )
        call.spends.add(pending)
        void pending.then(
          () => call.spends.delete(pending),
          () => call.spends.delete(pending),
        )
        return pending
      },
      callProvider: (method, params) =>
        this.#trackNested(
          call,
          this.#startCall("provider", method, params, {
            signal: call.controller.signal,
          }),
        ),
      callHost: (method, params) =>
        this.#trackNested(
          call,
          this.#startCall("host", method, params, {
            signal: call.controller.signal,
          }),
        ),
    }
  }

  #trackNested<T>(call: InboundCall, pending: Promise<T>): Promise<T> {
    call.nested.add(pending)
    void pending.then(
      () => call.nested.delete(pending),
      () => call.nested.delete(pending),
    )
    return pending
  }

  async #startElicitation(
    parentCallId: string,
    message: string,
    requestedSchema: JsonValue,
    signal: AbortSignal,
  ): Promise<ElicitationReply> {
    if (signal.aborted) throw abortError(signal.reason)
    const callId = `${this.#role}:elicitation:${this.#nextCall++}`
    const result = new Promise<JsonValue | ElicitationReply>(
      (resolve, reject) => {
        const call: OutboundCall = {
          kind: "elicitation",
          state: "open",
          resolve,
          reject,
        }
        const onAbort = (): void => {
          if (call.state !== "open") return
          call.state = "cancelled"
          this.#outbound.delete(callId)
          call.removeAbort?.()
          this.#rememberCancelled(callId, call)
          reject(abortError(signal.reason))
          void this.#transport
            .send({ type: "cancel", callId, payload: {} })
            .catch(() => undefined)
        }
        signal.addEventListener("abort", onAbort, { once: true })
        call.removeAbort = () => signal.removeEventListener("abort", onAbort)
        this.#outbound.set(callId, call)
      },
    )
    try {
      await this.#transport.send({
        type: "elicitation",
        callId,
        payload: { parentCallId, message, requestedSchema },
      })
    } catch (error) {
      this.#settleSendFailure(callId, error)
    }
    return result.then((value) => this.#elicitationReply(value))
  }

  #receiveElicitation(
    frame: Extract<ProtocolFrame, { type: "elicitation" }>,
  ): void {
    const callId = frame.callId
    if (!callId)
      throw new ProtocolError("malformed", "Elicitation has no call identity.")
    const parent = this.#outbound.get(frame.payload.parentCallId)
    const direct = parent?.onElicit
    if (direct) {
      void direct(frame.payload.message, frame.payload.requestedSchema)
        .then((reply) => this.#elicitationReply(reply))
        .then((reply) =>
          this.#transport.send({
            type: "elicitation-reply",
            callId,
            payload: reply,
          }),
        )
        .catch(() =>
          this.#transport.send({
            type: "elicitation-reply",
            callId,
            payload: { action: "cancel" },
          }),
        )
      return
    }
    const handler = this.#handlers.host.get("elicitation")
    if (!handler) {
      void this.#transport.send({
        type: "elicitation-reply",
        callId,
        payload: { action: "decline" },
      })
      return
    }
    const controller = new AbortController()
    const call: InboundCall = {
      kind: "elicitation",
      controller,
      terminalSent: false,
      cancelled: false,
      spends: new Set(),
      nested: new Set(),
    }
    this.#inbound.set(callId, call)
    void (async () => {
      try {
        const value = await handler(
          {
            parentCallId: frame.payload.parentCallId,
            message: frame.payload.message,
            requestedSchema: frame.payload.requestedSchema,
          },
          this.#context(callId, call),
        )
        const reply = this.#elicitationReply(value)
        await this.#sendTerminal(call, {
          type: "elicitation-reply",
          callId,
          payload: reply,
        })
      } catch {
        await this.#sendTerminal(call, {
          type: "elicitation-reply",
          callId,
          payload: { action: "cancel" },
        })
      } finally {
        this.#inbound.delete(callId)
        this.#rememberTerminal(callId)
      }
    })()
  }

  #elicitationReply(value: unknown): ElicitationReply {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error("Elicitation handler returned an invalid reply.")
    }
    if (!("action" in value)) {
      throw new Error("Elicitation handler returned no action.")
    }
    const action = value.action
    if (action !== "accept" && action !== "decline" && action !== "cancel") {
      throw new Error("Elicitation handler returned an invalid action.")
    }
    const content = "content" in value ? value.content : undefined
    if (content !== undefined && !isJsonValue(content)) {
      throw new Error("Elicitation handler returned non-JSON content.")
    }
    return {
      action,
      ...(content === undefined ? {} : { content }),
    }
  }

  async #sendInboundTerminal(
    callId: string,
    call: InboundCall,
    value: unknown,
  ): Promise<void> {
    if (!isJsonValue(value)) {
      throw new TypeError("RPC handler returned a non-JSON result.")
    }
    let draft: FrameDraft
    if (call.kind === "provider") {
      draft = {
        type: "provider-result",
        callId,
        payload: { providerCallId: this.#correlation(call), value },
      }
    } else if (call.kind === "host") {
      draft = {
        type: "host-result",
        callId,
        payload: { hostCallId: this.#correlation(call), value },
      }
    } else {
      draft = { type: "result", callId, payload: { value } }
    }
    await this.#sendTerminal(call, draft)
  }

  async #sendInboundError(
    callId: string,
    call: InboundCall,
    error: unknown,
  ): Promise<void> {
    if (call.terminalSent || call.terminalPromise) {
      await call.terminalPromise
      return
    }
    const wire = fallbackWireError(error)
    let draft: FrameDraft
    switch (call.kind) {
      case "elicitation": {
        draft = {
          type: "elicitation-reply",
          callId,
          payload: { action: "cancel" },
        }

        break
      }
      case "provider": {
        draft = {
          type: "provider-result",
          callId,
          payload: { providerCallId: this.#correlation(call), error: wire },
        }

        break
      }
      case "host": {
        draft = {
          type: "host-result",
          callId,
          payload: { hostCallId: this.#correlation(call), error: wire },
        }

        break
      }
      default: {
        draft = { type: "error", callId, payload: { error: wire } }
      }
    }
    await this.#sendTerminal(call, draft)
  }

  async #sendTerminal(call: InboundCall, draft: FrameDraft): Promise<void> {
    if (call.terminalSent)
      throw new ProtocolError("duplicate-terminal", "Terminal already sent.")
    if (call.terminalPromise) return call.terminalPromise
    const pending = this.#transport.send(draft).then(() => {
      call.terminalSent = true
    })
    call.terminalPromise = pending
    try {
      await pending
    } finally {
      call.terminalPromise = undefined
    }
  }

  #receiveTerminal(
    frame: Extract<
      ProtocolFrame,
      {
        type:
          | "result"
          | "error"
          | "provider-result"
          | "host-result"
          | "elicitation-reply"
      }
    >,
  ): void {
    const callId = frame.callId
    if (!callId)
      throw new ProtocolError("malformed", "Terminal has no call identity.")
    if (this.#terminalHistory.has(callId)) {
      throw new ProtocolError(
        "duplicate-terminal",
        `Duplicate terminal for ${callId}.`,
      )
    }
    const call = this.#outbound.get(callId)
    if (!call) {
      const cancelled = this.#cancelled.get(callId)
      if (!cancelled)
        throw new ProtocolError("unknown-call", `Unknown call ${callId}.`)
      this.#validateTerminal(cancelled, frame)
      this.#forgetCancelled(callId)
      this.#rememberTerminal(callId)
      return
    }
    this.#validateTerminal(call, frame)
    this.#outbound.delete(callId)
    call.removeAbort?.()
    call.state = "terminal"
    this.#rememberTerminal(callId)
    switch (frame.type) {
      case "error": {
        call.reject(wireErrorToError(frame.payload.error))

        break
      }
      case "provider-result":
      case "host-result": {
        if (frame.payload.error)
          call.reject(wireErrorToError(frame.payload.error))
        else call.resolve(frame.payload.value ?? null)

        break
      }
      case "elicitation-reply": {
        call.resolve(frame.payload)

        break
      }
      default: {
        call.resolve(frame.payload.value)
      }
    }
  }

  #correlation(call: InboundCall): string {
    if (!call.correlationId) {
      throw new ProtocolError("malformed", "Reverse RPC has no correlation ID.")
    }
    return call.correlationId
  }

  #validateTerminal(
    call: Pick<OutboundCall, "kind" | "correlationId">,
    frame: Extract<
      ProtocolFrame,
      {
        type:
          | "result"
          | "error"
          | "provider-result"
          | "host-result"
          | "elicitation-reply"
      }
    >,
  ): void {
    const valid =
      (call.kind === "request"
        && (frame.type === "result" || frame.type === "error"))
      || (call.kind === "provider" && frame.type === "provider-result")
      || (call.kind === "host" && frame.type === "host-result")
      || (call.kind === "elicitation" && frame.type === "elicitation-reply")
    if (!valid)
      throw new ProtocolError(
        "out-of-order",
        "Terminal kind does not match opener.",
      )
    if (
      frame.type === "provider-result"
      && frame.payload.providerCallId !== call.correlationId
    ) {
      throw new ProtocolError(
        "out-of-order",
        "Provider correlation identity changed.",
      )
    }
    if (
      frame.type === "host-result"
      && frame.payload.hostCallId !== call.correlationId
    ) {
      throw new ProtocolError(
        "out-of-order",
        "Host correlation identity changed.",
      )
    }
  }

  #receiveCancel(callId: string | undefined): void {
    if (!callId)
      throw new ProtocolError("malformed", "Cancel has no call identity.")
    const call = this.#inbound.get(callId)
    if (!call) {
      if (this.#terminalHistory.has(callId)) return
      throw new ProtocolError(
        "unknown-call",
        `Cancel targets unknown call ${callId}.`,
      )
    }
    if (call.terminalSent || call.cancelled) return
    call.cancelled = true
    call.controller.abort("Peer cancelled the call.")
    void this.#completeCancellation(callId, call).catch((error) =>
      this.#transport.close(
        error instanceof Error ? error.message : "Cancellation failed.",
      ),
    )
  }

  async #completeCancellation(
    callId: string,
    call: InboundCall,
  ): Promise<void> {
    await Promise.allSettled(call.nested)
    await Promise.allSettled(call.spends)
    await this.#sendInboundError(
      callId,
      call,
      abortError(call.controller.signal.reason),
    )
    if (this.#inbound.get(callId) === call) this.#inbound.delete(callId)
    this.#rememberTerminal(callId)
  }

  #receiveProgress(frame: Extract<ProtocolFrame, { type: "progress" }>): void {
    const callId = frame.callId
    const call = callId ? this.#outbound.get(callId) : undefined
    if (!call) {
      if (callId && this.#cancelled.has(callId)) return
      throw new ProtocolError("unknown-call", "Progress targets unknown call.")
    }
    if (call.state === "open") call.onProgress?.(frame.payload)
  }

  async #reportSpend(
    callId: string,
    invocationId: string,
    providerCallId: string,
    amount: number,
    evidence?: JsonValue,
  ): Promise<void> {
    const key = `${callId}\u0000${invocationId}\u0000${providerCallId}`
    if (this.#completedSpends.has(key)) return
    if (this.#spendAcks.has(key))
      throw new Error("Provider spend already pending.")
    const result = new Promise<void>((resolve, reject) => {
      this.#spendAcks.set(key, { resolve, reject })
    })
    try {
      await this.#transport.send({
        type: "spend",
        callId,
        payload: {
          invocationId,
          providerCallId,
          amount,
          unit: "nano_aiu",
          ...(evidence === undefined ? {} : { evidence }),
        },
      })
    } catch (error) {
      this.#spendAcks.delete(key)
      throw error
    }
    return result
  }

  async #receiveSpend(
    frame: Extract<ProtocolFrame, { type: "spend" }>,
  ): Promise<void> {
    const callId = frame.callId
    if (
      !callId
      || (!this.#outbound.has(callId) && !this.#cancelled.has(callId))
    ) {
      throw new ProtocolError("unknown-call", "Spend targets unknown call.")
    }
    const key = `${callId}\u0000${frame.payload.invocationId}\u0000${frame.payload.providerCallId}`
    const existing = this.#receivedSpends.get(key)
    if (existing) {
      await existing
    } else if (!this.#completedSpends.has(key)) {
      if (!this.#events.onSpend) {
        throw new ProtocolError(
          "closed",
          "Spend accounting handler is not configured.",
        )
      }
      const recording = Promise.resolve(
        this.#events.onSpend(
          callId,
          frame.payload.invocationId,
          frame.payload.providerCallId,
          frame.payload.amount,
          frame.payload.evidence,
        ),
      )
      this.#receivedSpends.set(key, recording)
      try {
        await recording
        this.#rememberSpend(key)
      } finally {
        this.#receivedSpends.delete(key)
      }
    }
    await this.#transport.send({
      type: "spend-ack",
      callId,
      payload: {
        invocationId: frame.payload.invocationId,
        providerCallId: frame.payload.providerCallId,
      },
    })
  }

  #receiveSpendAck(frame: Extract<ProtocolFrame, { type: "spend-ack" }>): void {
    const callId = frame.callId
    const key = `${callId ?? ""}\u0000${frame.payload.invocationId}\u0000${frame.payload.providerCallId}`
    const pending = this.#spendAcks.get(key)
    if (!pending) {
      if (this.#completedSpends.has(key)) return
      throw new ProtocolError("out-of-order", "Unknown spend acknowledgment.")
    }
    this.#spendAcks.delete(key)
    this.#rememberSpend(key)
    pending.resolve()
  }

  #rememberSpend(key: string): void {
    if (this.#completedSpends.has(key)) return
    this.#completedSpends.add(key)
    this.#completedSpendOrder.push(key)
    while (this.#completedSpendOrder.length > TERMINAL_HISTORY_LIMIT) {
      const oldest = this.#completedSpendOrder.shift()
      if (oldest) this.#completedSpends.delete(oldest)
    }
  }

  #settleSendFailure(callId: string, error: unknown): void {
    const call = this.#outbound.get(callId)
    if (!call) return
    this.#outbound.delete(callId)
    call.removeAbort?.()
    call.reject(error instanceof Error ? error : new Error(String(error)))
  }

  #rememberCancelled(callId: string, call: CancelledCall): void {
    this.#cancelled.set(callId, call)
    this.#cancelledOrder.push(callId)
    while (this.#cancelledOrder.length > TERMINAL_HISTORY_LIMIT) {
      const oldest = this.#cancelledOrder.shift()
      if (oldest) this.#cancelled.delete(oldest)
    }
  }

  #forgetCancelled(callId: string): void {
    this.#cancelled.delete(callId)
    const index = this.#cancelledOrder.indexOf(callId)
    if (index !== -1) this.#cancelledOrder.splice(index, 1)
  }

  #rememberTerminal(callId: string): void {
    if (this.#terminalHistory.has(callId)) return
    this.#terminalHistory.add(callId)
    this.#terminalOrder.push(callId)
    while (this.#terminalOrder.length > TERMINAL_HISTORY_LIMIT) {
      const oldest = this.#terminalOrder.shift()
      if (oldest) this.#terminalHistory.delete(oldest)
    }
  }

  #close(error: Error): void {
    if (this.#closedError) return
    this.#closedError = error
    this.#unsubscribe()
    this.#unsubscribeClose()
    for (const call of this.#outbound.values()) {
      call.removeAbort?.()
      if (call.state === "open") call.reject(error)
    }
    this.#outbound.clear()
    this.#cancelled.clear()
    this.#cancelledOrder.length = 0
    for (const call of this.#inbound.values())
      call.controller.abort(error.message)
    this.#inbound.clear()
    for (const pending of this.#spendAcks.values()) pending.reject(error)
    this.#spendAcks.clear()
  }
}
