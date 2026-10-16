import { z } from "zod"

import { BrokerWireConfigurationSchema } from "./wire-config.ts"

export const CONTROL_PROTOCOL = "maximal-mcp-control"
// 2: adds `update`. Broker and sidecar ship together; a mismatched pair
// fails the first frame instead of half-working.
export const CONTROL_PROTOCOL_VERSION = 2
export const DEFAULT_MAX_CONTROL_FRAME_BYTES = 1_048_576

const IdentifierSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[\w.-]+$/u)

const BaseEnvelopeSchema = z.strictObject({
  protocol: z.literal(CONTROL_PROTOCOL),
  version: z.literal(CONTROL_PROTOCOL_VERSION),
  generation: IdentifierSchema,
  sequence: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  deadlineMs: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  requestId: IdentifierSchema.optional(),
})

const BrokerStateSchema = z.enum(["starting", "ready", "degraded", "stopping"])

const EndpointObservationSchema = z.strictObject({
  id: z.string().min(1).max(64),
  serverName: z.string().min(1).max(256),
  serverVersion: z.string().min(1).max(256),
  negotiatedProtocol: z.string().min(1).max(64).optional(),
  protocolEra: z.enum(["legacy", "modern"]).optional(),
  ownership: z.literal("exclusive"),
  capabilities: z.strictObject({
    completions: z.boolean(),
    logging: z.boolean(),
    prompts: z.boolean(),
    resources: z.boolean(),
    tools: z.boolean(),
  }),
})

export const ControlEnvelopeSchema = z.discriminatedUnion("operation", [
  BaseEnvelopeSchema.extend({
    operation: z.literal("hello"),
    payload: z.strictObject({
      binaryVersion: z.string().min(1).max(64),
    }),
  }),
  BaseEnvelopeSchema.extend({
    operation: z.literal("configure"),
    requestId: IdentifierSchema,
    payload: z.strictObject({
      apiKey: z.string().min(32).max(512),
      configuration: BrokerWireConfigurationSchema,
    }),
  }),
  BaseEnvelopeSchema.extend({
    // New launch settings for future session instances; running ones keep
    // theirs. Answered RESTART_REQUIRED when the change needs a new broker.
    operation: z.literal("update"),
    requestId: IdentifierSchema,
    payload: z.strictObject({
      configuration: BrokerWireConfigurationSchema,
    }),
  }),
  BaseEnvelopeSchema.extend({
    operation: z.literal("ready"),
    payload: z.strictObject({
      host: z.literal("127.0.0.1"),
      port: z.number().int().min(1).max(65_535),
      endpoints: z.array(EndpointObservationSchema).max(64),
    }),
  }),
  BaseEnvelopeSchema.extend({
    operation: z.literal("heartbeat"),
    payload: z.strictObject({
      sentAtMs: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    }),
  }),
  BaseEnvelopeSchema.extend({
    operation: z.literal("status"),
    payload: z.strictObject({
      state: BrokerStateSchema,
    }),
  }),
  BaseEnvelopeSchema.extend({
    operation: z.literal("shutdown"),
    requestId: IdentifierSchema,
    payload: z.strictObject({}),
  }),
  BaseEnvelopeSchema.extend({
    operation: z.literal("response"),
    requestId: IdentifierSchema,
    payload: z.discriminatedUnion("ok", [
      z.strictObject({ ok: z.literal(true) }),
      z.strictObject({
        ok: z.literal(false),
        code: z
          .string()
          .min(1)
          .max(64)
          .regex(/^[A-Z0-9_]+$/u),
      }),
    ]),
  }),
])

export type ControlEnvelope = z.infer<typeof ControlEnvelopeSchema>

export type ControlProtocolErrorCode =
  | "CONTROL_FRAME_EMPTY"
  | "CONTROL_FRAME_INVALID_JSON"
  | "CONTROL_FRAME_INVALID_UTF8"
  | "CONTROL_FRAME_OVERSIZED"
  | "CONTROL_FRAME_SCHEMA_INVALID"
  | "CONTROL_FRAME_TRUNCATED"
  | "CONTROL_GENERATION_MISMATCH"
  | "CONTROL_SEQUENCE_MISMATCH"

export class ControlProtocolError extends Error {
  readonly code: ControlProtocolErrorCode

  constructor(code: ControlProtocolErrorCode) {
    super(code)
    this.name = "ControlProtocolError"
    this.code = code
  }
}

const validateMaxFrameBytes = (maxFrameBytes: number): number => {
  if (!Number.isSafeInteger(maxFrameBytes) || maxFrameBytes < 1) {
    throw new TypeError("maxFrameBytes must be a positive safe integer")
  }

  return maxFrameBytes
}

const parseFrame = (frame: Uint8Array): ControlEnvelope => {
  let json: string
  try {
    json = new TextDecoder("utf-8", { fatal: true }).decode(frame)
  } catch {
    throw new ControlProtocolError("CONTROL_FRAME_INVALID_UTF8")
  }

  let value: unknown
  try {
    value = JSON.parse(json)
  } catch {
    throw new ControlProtocolError("CONTROL_FRAME_INVALID_JSON")
  }

  const parsed = ControlEnvelopeSchema.safeParse(value)
  if (!parsed.success) {
    throw new ControlProtocolError("CONTROL_FRAME_SCHEMA_INVALID")
  }

  return parsed.data
}

export const encodeControlEnvelope = (
  envelope: ControlEnvelope,
  maxFrameBytes = DEFAULT_MAX_CONTROL_FRAME_BYTES,
): Uint8Array => {
  const limit = validateMaxFrameBytes(maxFrameBytes)
  const parsed = ControlEnvelopeSchema.safeParse(envelope)
  if (!parsed.success) {
    throw new ControlProtocolError("CONTROL_FRAME_SCHEMA_INVALID")
  }

  const body = new TextEncoder().encode(JSON.stringify(parsed.data))
  if (body.byteLength === 0) {
    throw new ControlProtocolError("CONTROL_FRAME_EMPTY")
  }
  if (body.byteLength > limit) {
    throw new ControlProtocolError("CONTROL_FRAME_OVERSIZED")
  }

  const frame = new Uint8Array(4 + body.byteLength)
  new DataView(frame.buffer, frame.byteOffset, 4).setUint32(0, body.byteLength)
  frame.set(body, 4)

  return frame
}

export class ControlFrameDecoder {
  readonly #maxFrameBytes: number
  readonly #header = new Uint8Array(4)
  #headerLength = 0
  #body: Uint8Array | undefined
  #bodyLength = 0
  #failed = false

  constructor(maxFrameBytes = DEFAULT_MAX_CONTROL_FRAME_BYTES) {
    this.#maxFrameBytes = validateMaxFrameBytes(maxFrameBytes)
  }

  push(chunk: Uint8Array): Array<ControlEnvelope> {
    if (this.#failed) {
      throw new ControlProtocolError("CONTROL_FRAME_TRUNCATED")
    }

    const envelopes: Array<ControlEnvelope> = []
    let offset = 0

    try {
      while (offset < chunk.byteLength) {
        if (!this.#body) {
          const copied = Math.min(
            4 - this.#headerLength,
            chunk.byteLength - offset,
          )
          this.#header.set(
            chunk.subarray(offset, offset + copied),
            this.#headerLength,
          )
          this.#headerLength += copied
          offset += copied

          if (this.#headerLength < 4) {
            continue
          }

          const bodyLength = new DataView(
            this.#header.buffer,
            this.#header.byteOffset,
            4,
          ).getUint32(0)
          if (bodyLength === 0) {
            throw new ControlProtocolError("CONTROL_FRAME_EMPTY")
          }
          if (bodyLength > this.#maxFrameBytes) {
            throw new ControlProtocolError("CONTROL_FRAME_OVERSIZED")
          }

          this.#body = new Uint8Array(bodyLength)
          this.#bodyLength = 0
        }

        const body = this.#body
        const copied = Math.min(
          body.byteLength - this.#bodyLength,
          chunk.byteLength - offset,
        )
        body.set(chunk.subarray(offset, offset + copied), this.#bodyLength)
        this.#bodyLength += copied
        offset += copied

        if (this.#bodyLength === body.byteLength) {
          envelopes.push(parseFrame(body))
          this.#headerLength = 0
          this.#body = undefined
          this.#bodyLength = 0
        }
      }
    } catch (error) {
      this.#failed = true
      throw error
    }

    return envelopes
  }

  finish(): void {
    if (this.#headerLength !== 0 || this.#body) {
      this.#failed = true
      throw new ControlProtocolError("CONTROL_FRAME_TRUNCATED")
    }
  }
}

export class ControlSequenceValidator {
  readonly #generation: string
  #nextSequence: number

  constructor(generation: string, initialSequence = 0) {
    const parsedGeneration = IdentifierSchema.safeParse(generation)
    if (!parsedGeneration.success) {
      throw new TypeError("generation must be a valid control identifier")
    }
    if (!Number.isSafeInteger(initialSequence) || initialSequence < 0) {
      throw new TypeError("initialSequence must be a non-negative safe integer")
    }

    this.#generation = parsedGeneration.data
    this.#nextSequence = initialSequence
  }

  accept(envelope: ControlEnvelope): void {
    if (envelope.generation !== this.#generation) {
      throw new ControlProtocolError("CONTROL_GENERATION_MISMATCH")
    }
    if (envelope.sequence !== this.#nextSequence) {
      throw new ControlProtocolError("CONTROL_SEQUENCE_MISMATCH")
    }

    this.#nextSequence += 1
  }
}
