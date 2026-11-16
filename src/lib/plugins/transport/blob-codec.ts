import type {
  BlobHandleDto,
  JsonValue,
} from "@stuffbucket/maximal-plugin-protocol"

import {
  decodeBlobHandle,
  ProtocolError,
} from "@stuffbucket/maximal-plugin-protocol"
import { createHash } from "node:crypto"
import { constants } from "node:fs"
import { open } from "node:fs/promises"

import type { DuplexRpcDispatcher } from "~/lib/plugins/transport/dispatcher"

import { GenerationSpoolStore } from "~/lib/plugins/spool/store"
import {
  exact,
  HOST_RPC,
  stringValue,
} from "~/lib/plugins/transport/gateway-codec"

const BLOB_STRING_KEY = "$maximalBlobString"
const LARGE_STRING_BYTES = 64 * 1024

interface BlobStringDto {
  readonly $maximalBlobString: BlobHandleDto
  readonly encoding: "utf8"
}

interface EncodeLargeStringOptions {
  readonly store: GenerationSpoolStore
  readonly callId: string
  readonly signal?: AbortSignal
}

interface DecodeLargeStringOptions {
  readonly generation: string
  readonly read: (handle: BlobHandleDto) => Promise<Uint8Array>
  readonly remember?: (text: string, reference: BlobStringDto) => void
}

interface RunnerBlobReference {
  readonly handle: BlobHandleDto
  readonly size: number
  readonly type: string
  readonly name: string | undefined
  readonly digest: string
  claimed: boolean
}

function blobName(blob: Blob): string | undefined {
  return "name" in blob && typeof blob.name === "string" ? blob.name : undefined
}

function digest(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex")
}

async function blobDigest(blob: Blob): Promise<string> {
  return digest(new Uint8Array(await blob.arrayBuffer()))
}

function utf8(value: string): Uint8Array {
  return new TextEncoder().encode(value)
}

function blobHandleJson(handle: BlobHandleDto): JsonValue {
  return {
    generation: handle.generation,
    id: handle.id,
    byteLength: handle.byteLength,
    ...(handle.mediaType === undefined ? {} : { mediaType: handle.mediaType }),
    ...(handle.filename === undefined ? {} : { filename: handle.filename }),
  }
}

function blobStringJson(reference: BlobStringDto): JsonValue {
  return {
    [BLOB_STRING_KEY]: blobHandleJson(reference.$maximalBlobString),
    encoding: reference.encoding,
  }
}

function blobString(
  value: JsonValue,
  generation: string,
): BlobStringDto | undefined {
  if (
    value === null
    || Array.isArray(value)
    || typeof value !== "object"
    || !Object.hasOwn(value, BLOB_STRING_KEY)
  )
    return undefined
  const entries = Object.keys(value)
  if (
    entries.length !== 2
    || !entries.includes("encoding")
    || value.encoding !== "utf8"
  )
    throw new ProtocolError("malformed", "Malformed blob-string reference.")
  return {
    $maximalBlobString: decodeBlobHandle(value[BLOB_STRING_KEY], generation),
    encoding: "utf8",
  }
}

async function collect(
  chunks: AsyncIterable<Uint8Array>,
  expectedBytes: number,
): Promise<Uint8Array> {
  const output = new Uint8Array(expectedBytes)
  let offset = 0
  for await (const chunk of chunks) {
    if (offset + chunk.byteLength > output.byteLength)
      throw new ProtocolError("malformed", "Blob exceeded its declared length.")
    output.set(chunk, offset)
    offset += chunk.byteLength
  }
  if (offset !== expectedBytes)
    throw new ProtocolError(
      "malformed",
      "Blob length did not match its handle.",
    )
  return output
}

async function encodeLargeStrings(
  value: JsonValue,
  options: EncodeLargeStringOptions,
): Promise<JsonValue> {
  if (typeof value === "string") {
    const bytes = utf8(value)
    if (bytes.byteLength <= LARGE_STRING_BYTES) return value
    const handle = await options.store.publish(bytes, {
      callId: options.callId,
      byteLength: bytes.byteLength,
      mediaType: "text/plain;charset=utf-8",
      signal: options.signal,
    })
    return blobStringJson({
      $maximalBlobString: handle,
      encoding: "utf8",
    })
  }
  if (value === null || typeof value !== "object") return value
  if (Array.isArray(value)) {
    const output: Array<JsonValue> = []
    for (const item of value)
      output.push(await encodeLargeStrings(item, options))
    return output
  }
  const output: Record<string, JsonValue> = {}
  for (const [key, item] of Object.entries(value))
    output[key] = await encodeLargeStrings(item, options)
  return output
}

async function decodeLargeStrings(
  value: JsonValue,
  options: DecodeLargeStringOptions,
): Promise<JsonValue> {
  if (value === null || typeof value !== "object") return value
  const reference = blobString(value, options.generation)
  if (reference) {
    const bytes = await options.read(reference.$maximalBlobString)
    const text = new TextDecoder(undefined, { fatal: true }).decode(bytes)
    options.remember?.(text, reference)
    return text
  }
  if (Array.isArray(value)) {
    const output: Array<JsonValue> = []
    for (const item of value)
      output.push(await decodeLargeStrings(item, options))
    return output
  }
  const output: Record<string, JsonValue> = {}
  for (const [key, item] of Object.entries(value))
    output[key] = await decodeLargeStrings(item, options)
  return output
}

/** Replace large provider-response strings with bounded, generation-fenced handles. */
export function spoolLargeStrings(
  value: JsonValue,
  options: EncodeLargeStringOptions,
): Promise<JsonValue> {
  return encodeLargeStrings(value, options)
}

/** Rehydrate handled strings in the parent immediately before the HTTP reply. */
export function materializeParentStrings(
  value: JsonValue,
  store: GenerationSpoolStore,
): Promise<JsonValue> {
  return decodeLargeStrings(value, {
    generation: store.generation,
    read: async (handle) => collect(store.read(handle), handle.byteLength),
  })
}

/** Runner-side bridge for parent-owned blob handles. */
export class RunnerBlobBridge {
  readonly #dispatcher: DuplexRpcDispatcher
  readonly #generation: string
  readonly #strings = new Map<string, Map<string, BlobStringDto>>()
  readonly #blobHandles = new WeakMap<Blob, BlobHandleDto>()
  readonly #callBlobs = new Map<string, Array<RunnerBlobReference>>()

  constructor(dispatcher: DuplexRpcDispatcher, generation: string) {
    this.#dispatcher = dispatcher
    this.#generation = generation
  }

  async materializeStrings(
    value: JsonValue,
    callId: string,
  ): Promise<JsonValue> {
    let references = this.#strings.get(callId)
    if (!references) {
      references = new Map()
      this.#strings.set(callId, references)
    }
    return await decodeLargeStrings(value, {
      generation: this.#generation,
      read: async (handle) => {
        const path = await this.#blobPath(handle)
        const file = Bun.file(path)
        if (file.size !== handle.byteLength)
          throw new ProtocolError(
            "malformed",
            "Blob file length did not match its handle.",
          )
        return new Uint8Array(await file.arrayBuffer())
      },
      remember: (text, reference) => references.set(text, reference),
    })
  }

  restoreStringHandles(value: JsonValue, callId: string): JsonValue {
    const references = this.#strings.get(callId)
    if (typeof value === "string") {
      const reference = references?.get(value)
      return reference === undefined ? value : blobStringJson(reference)
    }
    if (value === null || typeof value !== "object") return value
    if (Array.isArray(value))
      return value.map((item) => this.restoreStringHandles(item, callId))
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        this.restoreStringHandles(item, callId),
      ]),
    )
  }

  async publishBlob(
    blob: Blob,
    callId: string,
    signal?: AbortSignal,
  ): Promise<BlobHandleDto> {
    const name = blobName(blob)
    const staged = exact(
      await this.#dispatcher.callHost(
        HOST_RPC.blobStage,
        {
          callId,
          byteLength: blob.size,
          ...(name === undefined ? {} : { filename: name }),
          ...(blob.type.length === 0 ? {} : { mediaType: blob.type }),
        },
        { signal },
      ),
      "Blob stage result",
      ["id", "path"],
    )
    const id = stringValue(staged.id, "Blob upload id")
    const path = stringValue(staged.path, "Blob upload path")
    let committed = false
    let file: Awaited<ReturnType<typeof open>> | undefined
    try {
      file = await open(
        path,
        constants.O_WRONLY | constants.O_TRUNC | constants.O_NOFOLLOW,
      )
      const bytes = new Uint8Array(await blob.arrayBuffer())
      let offset = 0
      while (offset < bytes.byteLength) {
        if (signal?.aborted) throw signal.reason ?? new Error("Aborted")
        const result = await file.write(
          bytes,
          offset,
          bytes.byteLength - offset,
          offset,
        )
        if (result.bytesWritten === 0)
          throw new Error("Blob upload write made no progress.")
        offset += result.bytesWritten
      }
      await file.sync()
      await file.close()
      file = undefined
      const handle = decodeBlobHandle(
        await this.#dispatcher.callHost(
          HOST_RPC.blobCommit,
          { id },
          { signal },
        ),
        this.#generation,
      )
      committed = true
      return handle
    } finally {
      await file?.close().catch(() => undefined)
      if (!committed)
        await this.#dispatcher
          .callHost(HOST_RPC.blobAbort, { id })
          .catch(() => undefined)
    }
  }

  async handleForBlob(
    blob: Blob,
    callId: string,
  ): Promise<BlobHandleDto | undefined> {
    const references = this.#callBlobs.get(callId)
    const direct = this.#blobHandles.get(blob)
    if (direct) {
      const reference = references?.find(
        (candidate) => candidate.handle.id === direct.id,
      )
      if (!reference) return undefined
      reference.claimed = true
      return structuredClone(direct)
    }
    const candidates = references?.filter(
      (reference) =>
        !reference.claimed
        && reference.size === blob.size
        && reference.type === blob.type
        && reference.name === blobName(blob),
    )
    if (!candidates || candidates.length === 0) return undefined
    const candidateDigest = await blobDigest(blob)
    const reference = candidates.find(
      (candidate) => candidate.digest === candidateDigest,
    )
    if (!reference) return undefined
    reference.claimed = true
    return structuredClone(reference.handle)
  }

  async fileForHandle(handle: BlobHandleDto, callId: string): Promise<File> {
    const path = await this.#blobPath(handle)
    const source = Bun.file(path, {
      type: handle.mediaType ?? "application/octet-stream",
    })
    if (source.size !== handle.byteLength)
      throw new ProtocolError(
        "malformed",
        "Multipart blob length did not match its handle.",
      )
    const bytes = Uint8Array.from(new Uint8Array(await source.arrayBuffer()))
    const file = new File([bytes], handle.filename ?? "blob", {
      type: handle.mediaType ?? "application/octet-stream",
    })
    this.#blobHandles.set(file, structuredClone(handle))
    let references = this.#callBlobs.get(callId)
    if (!references) {
      references = []
      this.#callBlobs.set(callId, references)
    }
    references.push({
      handle: structuredClone(handle),
      size: file.size,
      type: file.type,
      name: blobName(file),
      digest: digest(bytes),
      claimed: false,
    })
    return file
  }

  release(callId: string): void {
    this.#strings.delete(callId)
    this.#callBlobs.delete(callId)
  }

  async #blobPath(handle: BlobHandleDto): Promise<string> {
    const value = await this.#dispatcher.callHost(HOST_RPC.blobPath, {
      handle: blobHandleJson(handle),
    })
    if (typeof value !== "string" || value.length === 0)
      throw new ProtocolError("malformed", "Blob path result is invalid.")
    return value
  }
}
