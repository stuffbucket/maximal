/* eslint-disable max-lines -- protocol DTOs, codecs, and fences are one versioned contract */
import { z } from "zod"

export const PLUGIN_PROTOCOL_VERSION = 2 as const
export const PLUGIN_API_VERSION = 1 as const

export const PROTOCOL_LIMITS = Object.freeze({
  envelopeBytes: 1024 * 1024,
  stringBytes: 256 * 1024,
  collectionItems: 1024,
  objectKeys: 1024,
  jsonDepth: 32,
  aggregateBlobBytes: 512 * 1024 * 1024,
})

export type JsonPrimitive = string | number | boolean | null
export type JsonValue =
  | JsonPrimitive
  | { [key: string]: JsonValue }
  | Array<JsonValue>

export interface BlobHandleDto {
  generation: string
  id: string
  byteLength: number
  mediaType?: string
  filename?: string
}

export interface MultipartPartDto {
  name: string
  value: string | BlobHandleDto
}

export interface MultipartDto {
  parts: Array<MultipartPartDto>
  aggregateBytes: number
}

export const FRAME_TYPES = [
  "request",
  "result",
  "error",
  "cancel",
  "progress",
  "elicitation",
  "elicitation-reply",
  "spend",
  "spend-ack",
  "state-event",
  "snapshot",
  "resync",
  "provider-request",
  "provider-result",
  "host-request",
  "host-result",
  "ready",
  "heartbeat",
  "drain",
  "shutdown",
] as const

export type FrameType = (typeof FRAME_TYPES)[number]

export const ERROR_KINDS = [
  "plugin-gateway",
  "operation-unavailable",
  "upstream-http",
  "auth-fatal",
  "aborted",
  "timeout",
  "indeterminate",
  "protocol",
  "internal",
] as const
export type WireErrorKind = (typeof ERROR_KINDS)[number]

export interface WireErrorDto {
  kind: WireErrorKind
  code: string
  message: string
  retry: "safe" | "never" | "unknown"
  pluginId?: string
  operation?: string
  model?: string
  status?: number
  headers?: Record<string, string>
  call?: { provider?: string; endpoint: string; model?: string }
  issues?: Array<{ path: string; message: string }>
  details?: JsonValue
}

interface EnvelopeBase<T extends FrameType, P> {
  protocol: typeof PLUGIN_PROTOCOL_VERSION
  pluginApi: typeof PLUGIN_API_VERSION
  generation: string
  id: string
  seq: number
  type: T
  callId?: string
  revision?: number
  payload: P
}

export type RequestFrame = EnvelopeBase<
  "request",
  { method: string; params: JsonValue }
>
export type ResultFrame = EnvelopeBase<"result", { value: JsonValue }>
export type ErrorFrame = EnvelopeBase<"error", { error: WireErrorDto }>
export type CancelFrame = EnvelopeBase<"cancel", { reason?: string }>
export type ProgressFrame = EnvelopeBase<
  "progress",
  { progress: number; total?: number; message?: string }
>
export type ElicitationFrame = EnvelopeBase<
  "elicitation",
  { parentCallId: string; message: string; requestedSchema: JsonValue }
>
export type ElicitationReplyFrame = EnvelopeBase<
  "elicitation-reply",
  { action: "accept" | "decline" | "cancel"; content?: JsonValue }
>
export type SpendFrame = EnvelopeBase<
  "spend",
  {
    invocationId: string
    providerCallId: string
    amount: number
    unit: "nano_aiu"
    evidence?: JsonValue
  }
>
export type SpendAckFrame = EnvelopeBase<
  "spend-ack",
  { invocationId: string; providerCallId: string }
>
export type StateEventFrame = EnvelopeBase<"state-event", { event: JsonValue }>
export type SnapshotFrame = EnvelopeBase<
  "snapshot",
  { controlEpoch: number; inventory: string; snapshot: JsonValue }
>
export type ResyncFrame = EnvelopeBase<
  "resync",
  { expectedRevision: number; reason: string }
>
export type ProviderRequestFrame = EnvelopeBase<
  "provider-request",
  { providerCallId: string; method: string; params: JsonValue }
>
export type ProviderResultFrame = EnvelopeBase<
  "provider-result",
  { providerCallId: string; value?: JsonValue; error?: WireErrorDto }
>
export type HostRequestFrame = EnvelopeBase<
  "host-request",
  { hostCallId: string; method: string; params: JsonValue }
>
export type HostResultFrame = EnvelopeBase<
  "host-result",
  { hostCallId: string; value?: JsonValue; error?: WireErrorDto }
>
export type ReadyFrame = EnvelopeBase<
  "ready",
  {
    controlEpoch: number
    inventory: string
    health: JsonValue
    snapshot: JsonValue
  }
>
export type HeartbeatFrame = EnvelopeBase<
  "heartbeat",
  { monotonicMs: number; inflight: number }
>
export type DrainFrame = EnvelopeBase<
  "drain",
  { deadlineMs: number; reason: string }
>
export type ShutdownFrame = EnvelopeBase<
  "shutdown",
  { graceful: boolean; reason?: string }
>

export type ProtocolFrame =
  | RequestFrame
  | ResultFrame
  | ErrorFrame
  | CancelFrame
  | ProgressFrame
  | ElicitationFrame
  | ElicitationReplyFrame
  | SpendFrame
  | SpendAckFrame
  | StateEventFrame
  | SnapshotFrame
  | ResyncFrame
  | ProviderRequestFrame
  | ProviderResultFrame
  | HostRequestFrame
  | HostResultFrame
  | ReadyFrame
  | HeartbeatFrame
  | DrainFrame
  | ShutdownFrame

export type ProtocolErrorCode =
  | "oversize"
  | "malformed"
  | "version-mismatch"
  | "stale-generation"
  | "out-of-order"
  | "duplicate-terminal"
  | "unknown-call"
  | "closed"

export class ProtocolError extends Error {
  readonly code: ProtocolErrorCode

  constructor(
    code: ProtocolErrorCode,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options)
    this.name = "ProtocolError"
    this.code = code
  }
}

/** Error rehydrated from an untrusted runner DTO without losing route metadata. */
export class WireRemoteError extends Error {
  readonly wire: Readonly<WireErrorDto>

  constructor(wire: WireErrorDto) {
    super(wire.message)
    this.name = "WireRemoteError"
    this.wire = Object.freeze(structuredClone(wire))
  }
}

export function wireErrorToError(wire: WireErrorDto): WireRemoteError {
  const parsed = errorSchema.safeParse(wire)
  if (!parsed.success) {
    throw new ProtocolError("malformed", "Malformed wire error.")
  }
  assertBoundedJson(parsed.data)
  return new WireRemoteError(parsed.data as WireErrorDto)
}

export function errorToWireError(
  error: unknown,
  fallback: Pick<WireErrorDto, "kind" | "code" | "retry">,
): WireErrorDto {
  if (error instanceof WireRemoteError) return structuredClone(error.wire)
  const message = error instanceof Error ? error.message : String(error)
  return {
    ...fallback,
    message: truncateUtf8(message, PROTOCOL_LIMITS.stringBytes),
  }
}

const idSchema = z.string().min(1).max(128)
const revisionSchema = z
  .number()
  .int()
  .nonnegative()
  .max(Number.MAX_SAFE_INTEGER)
const blobHandleSchema = z
  .object({
    generation: idSchema,
    id: idSchema,
    byteLength: z
      .number()
      .int()
      .nonnegative()
      .max(PROTOCOL_LIMITS.aggregateBlobBytes),
    mediaType: z.string().max(512).optional(),
    filename: z.string().max(4096).optional(),
  })
  .strict()
const multipartSchema = z
  .object({
    parts: z
      .array(
        z
          .object({
            name: z.string().max(4096),
            value: z.union([z.string(), blobHandleSchema]),
          })
          .strict(),
      )
      .max(PROTOCOL_LIMITS.collectionItems),
    aggregateBytes: z
      .number()
      .int()
      .nonnegative()
      .max(PROTOCOL_LIMITS.aggregateBlobBytes),
  })
  .strict()
const errorSchema = z
  .object({
    kind: z.enum(ERROR_KINDS),
    code: z.string().min(1).max(128),
    message: z.string().max(PROTOCOL_LIMITS.stringBytes),
    retry: z.enum(["safe", "never", "unknown"]),
    pluginId: idSchema.optional(),
    operation: z.string().max(128).optional(),
    model: z.string().max(512).optional(),
    status: z.number().int().min(100).max(599).optional(),
    headers: z.record(z.string(), z.string()).optional(),
    call: z
      .object({
        provider: z.string().max(128).optional(),
        endpoint: z.string().max(512),
        model: z.string().max(512).optional(),
      })
      .strict()
      .optional(),
    issues: z
      .array(
        z
          .object({ path: z.string().max(512), message: z.string().max(4096) })
          .strict(),
      )
      .max(256)
      .optional(),
    details: z.unknown().optional(),
  })
  .strict()

const payloadSchemas: Record<FrameType, z.ZodType> = {
  request: z.object({ method: idSchema, params: z.unknown() }).strict(),
  result: z.object({ value: z.unknown() }).strict(),
  error: z.object({ error: errorSchema }).strict(),
  cancel: z.object({ reason: z.string().max(4096).optional() }).strict(),
  progress: z
    .object({
      progress: z.number().nonnegative(),
      total: z.number().nonnegative().optional(),
      message: z.string().max(4096).optional(),
    })
    .strict(),
  elicitation: z
    .object({
      parentCallId: idSchema,
      message: z.string().max(16_384),
      requestedSchema: z.unknown(),
    })
    .strict(),
  "elicitation-reply": z
    .object({
      action: z.enum(["accept", "decline", "cancel"]),
      content: z.unknown().optional(),
    })
    .strict(),
  spend: z
    .object({
      invocationId: idSchema,
      providerCallId: idSchema,
      amount: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
      unit: z.literal("nano_aiu"),
      evidence: z.unknown().optional(),
    })
    .strict(),
  "spend-ack": z
    .object({ invocationId: idSchema, providerCallId: idSchema })
    .strict(),
  "state-event": z.object({ event: z.unknown() }).strict(),
  snapshot: z
    .object({
      controlEpoch: revisionSchema,
      inventory: idSchema,
      snapshot: z.unknown(),
    })
    .strict(),
  resync: z
    .object({ expectedRevision: revisionSchema, reason: z.string().max(4096) })
    .strict(),
  "provider-request": z
    .object({ providerCallId: idSchema, method: idSchema, params: z.unknown() })
    .strict(),
  "provider-result": z
    .object({
      providerCallId: idSchema,
      value: z.unknown().optional(),
      error: errorSchema.optional(),
    })
    .strict()
    .refine(
      (value) => (value.value === undefined) !== (value.error === undefined),
    ),
  "host-request": z
    .object({ hostCallId: idSchema, method: idSchema, params: z.unknown() })
    .strict(),
  "host-result": z
    .object({
      hostCallId: idSchema,
      value: z.unknown().optional(),
      error: errorSchema.optional(),
    })
    .strict()
    .refine(
      (value) => (value.value === undefined) !== (value.error === undefined),
    ),
  ready: z
    .object({
      controlEpoch: revisionSchema,
      inventory: idSchema,
      health: z.unknown(),
      snapshot: z.unknown(),
    })
    .strict(),
  heartbeat: z
    .object({ monotonicMs: revisionSchema, inflight: revisionSchema })
    .strict(),
  drain: z
    .object({ deadlineMs: revisionSchema, reason: z.string().max(4096) })
    .strict(),
  shutdown: z
    .object({ graceful: z.boolean(), reason: z.string().max(4096).optional() })
    .strict(),
}

const envelopeSchema = z
  .object({
    protocol: z.number().int(),
    pluginApi: z.number().int(),
    generation: idSchema,
    id: idSchema,
    seq: revisionSchema,
    type: z.enum(FRAME_TYPES),
    callId: idSchema.optional(),
    revision: revisionSchema.optional(),
    payload: z.unknown(),
  })
  .strict()

function byteLength(text: string): number {
  return new TextEncoder().encode(text).byteLength
}

function truncateUtf8(text: string, maximumBytes: number): string {
  if (byteLength(text) <= maximumBytes) return text
  let low = 0
  let high = text.length
  while (low < high) {
    const middle = Math.ceil((low + high) / 2)
    if (byteLength(text.slice(0, middle)) <= maximumBytes) low = middle
    else high = middle - 1
  }
  let end = low
  const code = text.slice(end - 1, end).codePointAt(0)
  if (code !== undefined && code >= 0xd800 && code <= 0xdbff) end -= 1
  return text.slice(0, end)
}

// JSON validation is intentionally centralized so every DTO gets identical limits.
// eslint-disable-next-line complexity
function assertBoundedJson(
  value: unknown,
  depth = 0,
  ancestors: WeakSet<object> = new WeakSet(),
): asserts value is JsonValue {
  if (depth > PROTOCOL_LIMITS.jsonDepth) {
    throw new ProtocolError("oversize", "Protocol JSON nesting is too deep.")
  }
  if (value === null || typeof value === "boolean") return
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new ProtocolError("malformed", "Protocol numbers must be finite.")
    }
    return
  }
  if (typeof value === "string") {
    if (byteLength(value) > PROTOCOL_LIMITS.stringBytes) {
      throw new ProtocolError("oversize", "Protocol string exceeds its limit.")
    }
    return
  }
  if (typeof value !== "object") {
    throw new ProtocolError("malformed", "Protocol values must be JSON.")
  }
  if (ancestors.has(value)) {
    throw new ProtocolError(
      "malformed",
      "Protocol values cannot contain cycles.",
    )
  }
  ancestors.add(value)
  if (Array.isArray(value)) {
    if (value.length > PROTOCOL_LIMITS.collectionItems) {
      throw new ProtocolError(
        "oversize",
        "Protocol collection exceeds its limit.",
      )
    }
    for (const item of value) assertBoundedJson(item, depth + 1, ancestors)
    ancestors.delete(value)
    return
  }
  if (Object.getPrototypeOf(value) !== Object.prototype) {
    throw new ProtocolError("malformed", "Protocol values must be plain JSON.")
  }
  const entries = Object.entries(value)
  if (entries.length > PROTOCOL_LIMITS.objectKeys) {
    throw new ProtocolError(
      "oversize",
      "Protocol object exceeds its key limit.",
    )
  }
  for (const [key, item] of entries) {
    if (byteLength(key) > 1024) {
      throw new ProtocolError(
        "oversize",
        "Protocol object key exceeds its limit.",
      )
    }
    assertBoundedJson(item, depth + 1, ancestors)
  }
  ancestors.delete(value)
}

export interface DecodeOptions {
  generation: string
  protocol?: number
  pluginApi?: number
}

export function decodeMultipart(
  input: unknown,
  generation: string,
): MultipartDto {
  assertBoundedJson(input)
  const parsed = multipartSchema.safeParse(input)
  if (!parsed.success) {
    throw new ProtocolError("malformed", "Malformed multipart DTO.")
  }
  let measuredBytes = 0
  for (const part of parsed.data.parts) {
    if (typeof part.value === "string") {
      measuredBytes += byteLength(part.value)
      continue
    }
    if (part.value.generation !== generation) {
      throw new ProtocolError(
        "stale-generation",
        "Blob handle belongs to another generation.",
      )
    }
    measuredBytes += part.value.byteLength
  }
  if (measuredBytes !== parsed.data.aggregateBytes) {
    throw new ProtocolError(
      "malformed",
      "Multipart aggregate byte length does not match its parts.",
    )
  }
  return parsed.data
}

/** Validate exact versions, generation fencing, shape, and aggregate limits. */
export function decodeFrame(
  input: unknown,
  options: DecodeOptions,
): ProtocolFrame {
  assertBoundedJson(input)
  let encoded: string
  try {
    encoded = JSON.stringify(input)
  } catch (error) {
    throw new ProtocolError(
      "malformed",
      "Protocol frame is not serializable.",
      {
        cause: error,
      },
    )
  }
  if (byteLength(encoded) > PROTOCOL_LIMITS.envelopeBytes) {
    throw new ProtocolError("oversize", "Protocol envelope exceeds its limit.")
  }
  const parsed = envelopeSchema.safeParse(input)
  if (!parsed.success) {
    throw new ProtocolError(
      "malformed",
      parsed.error.issues[0]?.message ?? "Malformed frame.",
    )
  }
  const expectedProtocol = options.protocol ?? PLUGIN_PROTOCOL_VERSION
  const expectedApi = options.pluginApi ?? PLUGIN_API_VERSION
  if (
    parsed.data.protocol !== expectedProtocol
    || parsed.data.pluginApi !== expectedApi
  ) {
    throw new ProtocolError(
      "version-mismatch",
      `Expected protocol ${expectedProtocol}/API ${expectedApi}; received ${parsed.data.protocol}/${parsed.data.pluginApi}.`,
    )
  }
  if (parsed.data.generation !== options.generation) {
    throw new ProtocolError(
      "stale-generation",
      `Frame belongs to generation "${parsed.data.generation}", not "${options.generation}".`,
    )
  }
  const payload = payloadSchemas[parsed.data.type].safeParse(
    parsed.data.payload,
  )
  if (!payload.success) {
    throw new ProtocolError(
      "malformed",
      payload.error.issues[0]?.message ?? "Malformed payload.",
    )
  }
  return { ...parsed.data, payload: payload.data } as ProtocolFrame
}

const OPEN_CALL_TYPES: ReadonlySet<FrameType> = new Set([
  "request",
  "provider-request",
  "host-request",
  "elicitation",
])
const TERMINAL_TYPES: ReadonlySet<FrameType> = new Set([
  "result",
  "error",
  "provider-result",
  "host-result",
  "elicitation-reply",
])
const CALL_SCOPED_TYPES: ReadonlySet<FrameType> = new Set([
  "cancel",
  "progress",
  "spend",
  "spend-ack",
])

type CallOpener =
  | "request"
  | "provider-request"
  | "host-request"
  | "elicitation"
export type FenceDirection = "single" | "parent" | "runner"

interface CallRecord {
  state: "open" | "terminal"
  opener: CallOpener
  correlationId?: string
}

export interface ProtocolCallRegistry {
  readonly calls: Map<string, CallRecord>
  readonly terminalOrder: Array<string>
  readonly pendingSpend: Set<string>
  readonly completedSpend: Set<string>
  readonly completedSpendOrder: Array<string>
}

export function createProtocolCallRegistry(): ProtocolCallRegistry {
  return {
    calls: new Map(),
    terminalOrder: [],
    pendingSpend: new Set(),
    completedSpend: new Set(),
    completedSpendOrder: [],
  }
}

function oppositeDirection(direction: FenceDirection): FenceDirection {
  if (direction === "parent") return "runner"
  if (direction === "runner") return "parent"
  return "single"
}

/** Stateful sequence, call-terminal and state-revision fences for one direction. */
export class ProtocolFence {
  readonly #options: DecodeOptions
  readonly #registry: ProtocolCallRegistry
  readonly #direction: FenceDirection
  #nextSequence = 0
  #revision: number | undefined
  #controlEpoch: number | undefined

  constructor(
    options: DecodeOptions,
    registry = createProtocolCallRegistry(),
    direction: FenceDirection = "single",
  ) {
    this.#options = options
    this.#registry = registry
    this.#direction = direction
  }

  accept(input: unknown): ProtocolFrame {
    const frame = decodeFrame(input, this.#options)
    if (frame.seq !== this.#nextSequence) {
      throw new ProtocolError(
        "out-of-order",
        `Expected sequence ${this.#nextSequence}; received ${frame.seq}.`,
      )
    }
    this.#nextSequence += 1
    this.#acceptRevision(frame)
    this.#acceptCall(frame)
    return frame
  }

  #acceptRevision(frame: ProtocolFrame): void {
    if (frame.type === "snapshot" || frame.type === "ready") {
      if (frame.revision === undefined) {
        throw new ProtocolError(
          "malformed",
          `${frame.type === "ready" ? "Ready" : "Snapshot"} requires a revision.`,
        )
      }
      const controlEpoch = frame.payload.controlEpoch
      if (
        (this.#revision !== undefined && frame.revision < this.#revision)
        || (this.#controlEpoch !== undefined
          && controlEpoch < this.#controlEpoch)
      ) {
        throw new ProtocolError(
          "out-of-order",
          "Snapshot revision or control-plane epoch moved backwards.",
        )
      }
      this.#revision = frame.revision
      this.#controlEpoch = controlEpoch
      return
    }
    if (frame.type !== "state-event") return
    if (frame.revision === undefined) {
      throw new ProtocolError("malformed", "State event requires a revision.")
    }
    const expected = (this.#revision ?? -1) + 1
    if (frame.revision !== expected) {
      throw new ProtocolError(
        "out-of-order",
        `Expected state revision ${expected}; received ${frame.revision}.`,
      )
    }
    this.#revision = frame.revision
  }

  // Call lifecycle branches stay centralized to enforce one terminal boundary.
  // eslint-disable-next-line complexity, max-lines-per-function
  #acceptCall(frame: ProtocolFrame): void {
    const callId = frame.callId
    const ownKey = callId ? `${this.#direction}\u0000${callId}` : ""
    const peerKey =
      callId ? `${oppositeDirection(this.#direction)}\u0000${callId}` : ""
    if (OPEN_CALL_TYPES.has(frame.type)) {
      if (!callId)
        throw new ProtocolError("malformed", `${frame.type} requires callId.`)
      if (this.#registry.calls.has(ownKey)) {
        throw new ProtocolError(
          "out-of-order",
          `Call "${callId}" is already known in this direction.`,
        )
      }
      const opener = frame.type as CallOpener
      let correlationId: string | undefined
      if (frame.type === "provider-request") {
        correlationId = frame.payload.providerCallId
      } else if (frame.type === "host-request") {
        correlationId = frame.payload.hostCallId
      }
      this.#registry.calls.set(ownKey, {
        state: "open",
        opener,
        correlationId,
      })
      return
    }
    if (TERMINAL_TYPES.has(frame.type)) {
      if (!callId)
        throw new ProtocolError("malformed", `${frame.type} requires callId.`)
      const key = this.#direction === "single" ? ownKey : peerKey
      const record = this.#registry.calls.get(key)
      if (record?.state === "terminal") {
        throw new ProtocolError(
          "duplicate-terminal",
          `Call "${callId}" already terminated.`,
        )
      }
      if (!record) {
        throw new ProtocolError("unknown-call", `Call "${callId}" is unknown.`)
      }
      this.#assertTerminalMatches(record, frame)
      const prefix = `${key}\u0000`
      if (
        [...this.#registry.pendingSpend].some((pending) =>
          pending.startsWith(prefix),
        )
      ) {
        throw new ProtocolError(
          "out-of-order",
          `Call "${callId}" has unacknowledged spend.`,
        )
      }
      record.state = "terminal"
      this.#registry.terminalOrder.push(key)
      while (this.#registry.terminalOrder.length > 4096) {
        const oldest = this.#registry.terminalOrder.shift()
        if (oldest) this.#registry.calls.delete(oldest)
      }
      return
    }
    if (!CALL_SCOPED_TYPES.has(frame.type)) return
    if (!callId) {
      throw new ProtocolError(
        "unknown-call",
        "Call-scoped frame has no call ID.",
      )
    }
    let ownerKey = peerKey
    if (
      frame.type === "cancel"
      || frame.type === "spend-ack"
      || this.#direction === "single"
    ) {
      ownerKey = ownKey
    }
    if (this.#registry.calls.get(ownerKey)?.state !== "open") {
      throw new ProtocolError("unknown-call", `Call "${callId}" is not open.`)
    }
    if (frame.type === "spend") {
      const key = `${ownerKey}\u0000${frame.payload.invocationId}\u0000${frame.payload.providerCallId}`
      if (
        this.#registry.pendingSpend.has(key)
        || this.#registry.completedSpend.has(key)
      ) {
        throw new ProtocolError(
          "out-of-order",
          "Spend invocation is duplicated or replayed.",
        )
      }
      this.#registry.pendingSpend.add(key)
    }
    if (frame.type === "spend-ack") {
      const key = `${ownerKey}\u0000${frame.payload.invocationId}\u0000${frame.payload.providerCallId}`
      if (!this.#registry.pendingSpend.delete(key)) {
        throw new ProtocolError(
          "out-of-order",
          "Spend acknowledgment is unknown.",
        )
      }
      this.#registry.completedSpend.add(key)
      this.#registry.completedSpendOrder.push(key)
      while (this.#registry.completedSpendOrder.length > 4096) {
        const oldest = this.#registry.completedSpendOrder.shift()
        if (oldest) this.#registry.completedSpend.delete(oldest)
      }
    }
  }

  #assertTerminalMatches(record: CallRecord, frame: ProtocolFrame): void {
    const valid =
      (record.opener === "request"
        && (frame.type === "result" || frame.type === "error"))
      || (record.opener === "provider-request"
        && frame.type === "provider-result")
      || (record.opener === "host-request" && frame.type === "host-result")
      || (record.opener === "elicitation" && frame.type === "elicitation-reply")
    if (!valid) {
      throw new ProtocolError(
        "out-of-order",
        `Terminal "${frame.type}" does not match opener "${record.opener}".`,
      )
    }
    if (
      frame.type === "provider-result"
      && frame.payload.providerCallId !== record.correlationId
    ) {
      throw new ProtocolError("out-of-order", "Provider call ID changed.")
    }
    if (
      frame.type === "host-result"
      && frame.payload.hostCallId !== record.correlationId
    ) {
      throw new ProtocolError("out-of-order", "Host call ID changed.")
    }
  }
}

export interface ProtocolTransport {
  send(frame: ProtocolFrame): void
  subscribe(listener: (frame: ProtocolFrame) => void): () => void
  close(): void
  readonly transcript: ReadonlyArray<ProtocolFrame>
}

class LoopbackEndpoint implements ProtocolTransport {
  readonly #listeners = new Set<(frame: ProtocolFrame) => void>()
  readonly #fence: ProtocolFence
  readonly #received: Array<ProtocolFrame> = []
  #peer: LoopbackEndpoint | undefined
  #closed = false

  constructor(
    options: DecodeOptions,
    registry: ProtocolCallRegistry,
    direction: Exclude<FenceDirection, "single">,
  ) {
    this.#fence = new ProtocolFence(options, registry, direction)
  }

  setPeer(peer: LoopbackEndpoint): void {
    this.#peer = peer
  }

  get transcript(): ReadonlyArray<ProtocolFrame> {
    return this.#received.map((frame) => structuredClone(frame))
  }

  send(frame: ProtocolFrame): void {
    if (this.#closed || !this.#peer || this.#peer.#closed) {
      throw new ProtocolError("closed", "Protocol transport is closed.")
    }
    this.#peer.#deliver(structuredClone(frame))
  }

  subscribe(listener: (frame: ProtocolFrame) => void): () => void {
    this.#listeners.add(listener)
    return () => {
      this.#listeners.delete(listener)
    }
  }

  close(): void {
    this.#closed = true
    this.#listeners.clear()
  }

  #deliver(input: unknown): void {
    const frame = this.#fence.accept(input)
    this.#received.push(frame)
    for (const listener of this.#listeners) listener(structuredClone(frame))
  }
}

/** In-memory, structured-clone loopback with the same validation as IPC. */
export function createLoopbackTransportPair(options: DecodeOptions): {
  parent: ProtocolTransport
  runner: ProtocolTransport
} {
  const registry = createProtocolCallRegistry()
  const parent = new LoopbackEndpoint(options, registry, "runner")
  const runner = new LoopbackEndpoint(options, registry, "parent")
  parent.setPeer(runner)
  runner.setPeer(parent)
  return { parent, runner }
}

export function frame<T extends ProtocolFrame>(
  value: Omit<T, "protocol" | "pluginApi">,
): T {
  return {
    protocol: PLUGIN_PROTOCOL_VERSION,
    pluginApi: PLUGIN_API_VERSION,
    ...value,
  } as T
}
