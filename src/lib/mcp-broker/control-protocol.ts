import { z } from "zod"

import type { ResolvedBrokerConfiguration } from "./configuration"

export const CONTROL_PROTOCOL = "maximal-mcp-control"
// 2: adds `update`. 3: adds `elicit`, `elicitResult` and `elicitWithdrawn`.
// Broker and sidecar ship together; a mismatched pair fails the first frame
// instead of half-working.
export const CONTROL_PROTOCOL_VERSION = 3
export const DEFAULT_MAX_CONTROL_FRAME_BYTES = 1_048_576

const IdentifierSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[\w.-]+$/u)

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

const BaseEnvelopeSchema = z.strictObject({
  protocol: z.literal(CONTROL_PROTOCOL),
  version: z.literal(CONTROL_PROTOCOL_VERSION),
  generation: IdentifierSchema,
  sequence: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  deadlineMs: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  requestId: IdentifierSchema.optional(),
})

/** A server's request for user input, for Maximal to show. Everything in
 *  it came from the MCP server and is untrusted. */
export const ElicitPayloadSchema = z.strictObject({
  endpointId: z.string().min(1).max(64),
  label: z.string().min(1).max(128),
  toolName: z.string().min(1).max(256).optional(),
  mechanism: z.enum(["legacy-form", "legacy-url", "modern-input-required"]),
  mode: z.enum(["form", "url"]),
  message: z.string().max(4096),
  requestedSchema: z
    .looseObject({
      type: z.literal("object"),
      properties: z.record(
        z.string().max(256),
        z.record(z.string(), z.unknown()),
      ),
      required: z.array(z.string().max(256)).max(64).optional(),
    })
    .optional(),
  url: z.string().min(1).max(4096).optional(),
  expiresAtMs: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
})

export type ElicitPayload = z.infer<typeof ElicitPayloadSchema>

export type ElicitContentValue = string | number | boolean | Array<string>

export interface ElicitResultPayload {
  action: "accept" | "decline" | "cancel"
  content?: Record<string, ElicitContentValue>
}

export const BrokerEnvelopeSchema = z.discriminatedUnion("operation", [
  BaseEnvelopeSchema.extend({
    operation: z.literal("hello"),
    payload: z.strictObject({ binaryVersion: z.string().min(1).max(64) }),
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
      state: z.enum(["starting", "ready", "degraded", "stopping"]),
    }),
  }),
  BaseEnvelopeSchema.extend({
    operation: z.literal("elicit"),
    requestId: IdentifierSchema,
    payload: ElicitPayloadSchema,
  }),
  BaseEnvelopeSchema.extend({
    operation: z.literal("elicitWithdrawn"),
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

export type BrokerEnvelope = z.infer<typeof BrokerEnvelopeSchema>

export type SidecarEnvelope =
  | {
      operation: "configure"
      requestId: string
      payload: {
        apiKey: string
        configuration: ResolvedBrokerConfiguration
      }
    }
  | {
      operation: "update"
      requestId: string
      payload: { configuration: ResolvedBrokerConfiguration }
    }
  | {
      operation: "shutdown"
      requestId: string
      payload: Record<string, never>
    }
  | {
      operation: "elicitResult"
      requestId: string
      payload: ElicitResultPayload
    }

export class BrokerControlProtocolError extends Error {
  readonly code: string

  constructor(code: string) {
    super(code)
    this.name = "BrokerControlProtocolError"
    this.code = code
  }
}

function parseFrame(frame: Uint8Array): BrokerEnvelope {
  let text: string
  try {
    // Default label is UTF-8; `fatal` rejects malformed sequences.
    text = new TextDecoder(undefined, { fatal: true }).decode(frame)
  } catch {
    throw new BrokerControlProtocolError("CONTROL_FRAME_INVALID_UTF8")
  }

  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    throw new BrokerControlProtocolError("CONTROL_FRAME_INVALID_JSON")
  }

  const parsed = BrokerEnvelopeSchema.safeParse(value)
  if (!parsed.success) {
    throw new BrokerControlProtocolError("CONTROL_FRAME_SCHEMA_INVALID")
  }
  return parsed.data
}

export interface SidecarFrameHeader {
  generation: string
  sequence: number
  deadlineMs: number
  maxFrameBytes?: number
}

export function encodeSidecarEnvelope(
  envelope: SidecarEnvelope,
  header: SidecarFrameHeader,
): Uint8Array {
  const {
    generation,
    sequence,
    deadlineMs,
    maxFrameBytes = DEFAULT_MAX_CONTROL_FRAME_BYTES,
  } = header
  const body = new TextEncoder().encode(
    JSON.stringify({
      protocol: CONTROL_PROTOCOL,
      version: CONTROL_PROTOCOL_VERSION,
      generation,
      sequence,
      deadlineMs,
      ...envelope,
    }),
  )
  if (body.byteLength === 0 || body.byteLength > maxFrameBytes) {
    throw new BrokerControlProtocolError("CONTROL_FRAME_OVERSIZED")
  }

  const frame = new Uint8Array(4 + body.byteLength)
  new DataView(frame.buffer, frame.byteOffset, 4).setUint32(0, body.byteLength)
  frame.set(body, 4)
  return frame
}

export class BrokerFrameDecoder {
  readonly maxFrameBytes: number
  readonly #header = new Uint8Array(4)
  #headerLength = 0
  #body: Uint8Array | undefined
  #bodyLength = 0

  constructor(maxFrameBytes = DEFAULT_MAX_CONTROL_FRAME_BYTES) {
    if (!Number.isSafeInteger(maxFrameBytes) || maxFrameBytes < 1) {
      throw new TypeError("maxFrameBytes must be a positive safe integer")
    }
    this.maxFrameBytes = maxFrameBytes
  }

  push(chunk: Uint8Array): Array<BrokerEnvelope> {
    const envelopes: Array<BrokerEnvelope> = []
    let offset = 0

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
        if (this.#headerLength < 4) continue

        const bodyLength = new DataView(
          this.#header.buffer,
          this.#header.byteOffset,
          4,
        ).getUint32(0)
        if (bodyLength === 0 || bodyLength > this.maxFrameBytes) {
          throw new BrokerControlProtocolError("CONTROL_FRAME_OVERSIZED")
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

    return envelopes
  }
}
