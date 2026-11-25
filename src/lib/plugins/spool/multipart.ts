import {
  decodeMultipart,
  PROTOCOL_LIMITS,
  type BlobHandleDto,
  type MultipartDto,
} from "@stuffbucket/maximal-plugin-protocol"

import {
  GenerationSpoolStore,
  SpoolLimitError,
} from "~/lib/plugins/spool/store"

export interface MultipartSpoolOptions {
  callId: string
  signal?: AbortSignal
  perCallBytes?: number
}

export type OrderedMultipartValue =
  | { name: string; kind: "text"; value: string }
  | {
      name: string
      kind: "blob"
      handle: BlobHandleDto
      stream: AsyncIterable<Uint8Array>
    }

function utf8Bytes(value: string): number {
  return new TextEncoder().encode(value).byteLength
}

/** Spool FormData without collapsing duplicate field names or reordering parts. */
export async function spoolMultipart(
  form: FormData,
  store: GenerationSpoolStore,
  options: MultipartSpoolOptions,
): Promise<MultipartDto> {
  const parts: MultipartDto["parts"] = []
  const published: Array<BlobHandleDto> = []
  let aggregateBytes = 0
  const perCallLimit =
    options.perCallBytes ?? PROTOCOL_LIMITS.aggregateBlobBytes
  try {
    for (const [name, rawValue] of form.entries()) {
      const value: unknown = rawValue
      if (value instanceof Blob) {
        aggregateBytes += value.size
        if (aggregateBytes > perCallLimit) {
          throw new SpoolLimitError(
            "Multipart value exceeds its per-call limit.",
          )
        }
        const filename =
          "name" in value && typeof value.name === "string" ?
            value.name
          : "blob"
        const handle = await store.publish(value, {
          callId: options.callId,
          byteLength: value.size,
          filename,
          mediaType: value.type || undefined,
          signal: options.signal,
        })
        published.push(handle)
        parts.push({ name, value: handle })
        continue
      }
      if (typeof value !== "string") {
        throw new SpoolLimitError("Multipart value has an unsupported type.")
      }
      aggregateBytes += utf8Bytes(value)
      if (aggregateBytes > perCallLimit) {
        throw new SpoolLimitError("Multipart value exceeds its per-call limit.")
      }
      parts.push({ name, value })
    }
    return decodeMultipart({ parts, aggregateBytes }, store.generation)
  } catch (error) {
    for (const handle of published.reverse()) {
      await store.release(handle).catch(() => undefined)
    }
    throw error
  }
}

/** Stream ordered multipart values without loading blob contents into memory. */
export function* readMultipart(
  dto: MultipartDto,
  store: GenerationSpoolStore,
): Iterable<OrderedMultipartValue> {
  const decoded = decodeMultipart(dto, store.generation)
  for (const part of decoded.parts) {
    yield typeof part.value === "string" ?
      { name: part.name, kind: "text", value: part.value }
    : {
        name: part.name,
        kind: "blob",
        handle: part.value,
        stream: store.read(part.value),
      }
  }
}

/** Bun-backed FormData projection; Bun.file keeps large bodies file-backed. */
export async function multipartToFormData(
  dto: MultipartDto,
  store: GenerationSpoolStore,
): Promise<FormData> {
  const decoded = decodeMultipart(dto, store.generation)
  const form = new FormData()
  for (const part of decoded.parts) {
    if (typeof part.value === "string") {
      form.append(part.name, part.value)
      continue
    }
    const path = await store.resolvePath(part.value)
    const blob = Bun.file(path, {
      type: part.value.mediaType ?? "application/octet-stream",
    })
    const file = new File([blob], part.value.filename ?? "blob", {
      type: part.value.mediaType ?? "application/octet-stream",
    })
    form.append(part.name, file)
  }
  return form
}
