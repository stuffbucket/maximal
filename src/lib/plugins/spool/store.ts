/* eslint-disable complexity, max-lines-per-function, max-params, require-atomic-updates -- publication and policy validation intentionally fail closed at each boundary */
import type { BlobHandleDto } from "@stuffbucket/maximal-plugin-protocol"

import { createHash, randomUUID } from "node:crypto"
import { constants } from "node:fs"
import {
  lstat,
  mkdir,
  open,
  readdir,
  realpath,
  rename,
  rm,
} from "node:fs/promises"
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path"

const SAFE_ID = /^[a-z0-9][\w.-]{0,127}$/i
const SAFE_CALL_ID = /^[a-z0-9][\w.:-]{0,255}$/i

export interface SpoolLimits {
  perBlobBytes: number
  perCallBytes: number
  aggregateBytes: number
  maxBlobs: number
  chunkBytes: number
}

const DEFAULT_LIMITS: SpoolLimits = {
  perBlobBytes: 256 * 1024 * 1024,
  perCallBytes: 512 * 1024 * 1024,
  aggregateBytes: 512 * 1024 * 1024,
  maxBlobs: 1_024,
  chunkBytes: 64 * 1024,
}

export interface PublishBlobOptions {
  callId: string
  byteLength: number
  filename?: string
  mediaType?: string
  signal?: AbortSignal
}

export type BlobInput =
  | Uint8Array
  | Blob
  | ReadableStream<Uint8Array>
  | AsyncIterable<Uint8Array>

interface LeaseRecord {
  handle: BlobHandleDto
  path: string
  callId: string
  refs: number
  dev: number
  ino: number
  digest: string
  deleting: boolean
}

export interface DeleteRetryPolicy {
  attempts: number
  initialDelayMs: number
  maxDelayMs: number
}

export interface SpoolStoreOptions {
  root: string
  generation: string
  limits?: Partial<SpoolLimits>
  deleteRetry?: Partial<DeleteRetryPolicy>
  remove?: typeof rm
  sleep?: (milliseconds: number) => Promise<void>
}

export class SpoolLimitError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "SpoolLimitError"
  }
}

export class InvalidBlobHandleError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "InvalidBlobHandleError"
  }
}

function byteLength(text: string): number {
  return new TextEncoder().encode(text).byteLength
}

function isRetryableDelete(error: unknown): boolean {
  if (!error || typeof error !== "object" || !("code" in error)) return false
  return (
    error.code === "EPERM" || error.code === "EBUSY" || error.code === "EACCES"
  )
}

function within(root: string, candidate: string): boolean {
  const path = relative(root, candidate)
  return (
    path === ""
    || (!path.startsWith(`..${sep}`) && path !== ".." && !isAbsolute(path))
  )
}

interface ByteStreamReader {
  read(): Promise<{ done: boolean; value?: Uint8Array }>
  releaseLock(): void
}

function hasByteReader(
  value: unknown,
): value is { getReader(): ByteStreamReader } {
  return Boolean(
    value
    && typeof value === "object"
    && "getReader" in value
    && typeof value.getReader === "function",
  )
}

async function writeChunk(
  file: Awaited<ReturnType<typeof open>>,
  chunk: Uint8Array,
): Promise<void> {
  let offset = 0
  while (offset < chunk.byteLength) {
    const result = await file.write(chunk, offset, chunk.byteLength - offset)
    if (result.bytesWritten === 0) {
      throw new Error("Spool file write made no progress.")
    }
    offset += result.bytesWritten
  }
}

async function* chunks(input: BlobInput): AsyncIterable<Uint8Array> {
  if (input instanceof Uint8Array) {
    yield input
    return
  }
  if (typeof Blob !== "undefined" && input instanceof Blob) {
    const body: unknown = new Response(input).body
    if (!hasByteReader(body)) {
      throw new TypeError("Blob did not provide a web-readable stream.")
    }
    const reader = body.getReader()
    try {
      while (true) {
        const next = await reader.read()
        if (next.done) return
        if (!next.value) throw new TypeError("Blob stream returned no bytes.")
        yield next.value
      }
    } finally {
      reader.releaseLock()
    }
  }
  if (Symbol.asyncIterator in input) {
    for await (const chunk of input) yield chunk
    return
  }
  if (!hasByteReader(input)) {
    throw new TypeError("Blob input is not readable.")
  }
  const reader = input.getReader()
  try {
    while (true) {
      const next = await reader.read()
      if (next.done) return
      if (!next.value) throw new TypeError("Blob stream returned no bytes.")
      yield next.value
    }
  } finally {
    reader.releaseLock()
  }
}

/** Generation-owned, ref-counted, atomically published blob spool. */
export class GenerationSpoolStore {
  readonly #baseRoot: string
  readonly #generation: string
  readonly #limits: SpoolLimits
  readonly #retry: DeleteRetryPolicy
  readonly #remove: typeof rm
  readonly #sleep: (milliseconds: number) => Promise<void>
  readonly #leases = new Map<string, LeaseRecord>()
  readonly #callLeases = new Map<string, Set<string>>()
  readonly #callBytes = new Map<string, number>()
  #root = ""
  #rootDev = 0
  #rootIno = 0
  #aggregateBytes = 0
  #pendingPublishes = 0
  #initialized = false
  #initializing: Promise<void> | undefined
  #rootQuarantined = false
  #closed = false

  constructor(options: SpoolStoreOptions) {
    if (!SAFE_ID.test(options.generation)) {
      throw new InvalidBlobHandleError(
        "Generation is not a safe spool identity.",
      )
    }
    this.#baseRoot = resolve(options.root)
    this.#generation = options.generation
    this.#limits = { ...DEFAULT_LIMITS, ...options.limits }
    this.#retry = {
      attempts: options.deleteRetry?.attempts ?? 6,
      initialDelayMs: options.deleteRetry?.initialDelayMs ?? 20,
      maxDelayMs: options.deleteRetry?.maxDelayMs ?? 500,
    }
    if (
      Object.values(this.#limits).some(
        (value) => !Number.isSafeInteger(value) || value < 1,
      )
      || !Number.isSafeInteger(this.#retry.attempts)
      || this.#retry.attempts < 1
      || !Number.isSafeInteger(this.#retry.initialDelayMs)
      || this.#retry.initialDelayMs < 0
      || !Number.isSafeInteger(this.#retry.maxDelayMs)
      || this.#retry.maxDelayMs < 0
    ) {
      throw new RangeError(
        "Spool limits and retry policy must be bounded integers.",
      )
    }
    this.#remove = options.remove ?? rm
    this.#sleep = options.sleep ?? ((milliseconds) => Bun.sleep(milliseconds))
  }

  get generation(): string {
    return this.#generation
  }

  get aggregateBytes(): number {
    return this.#aggregateBytes
  }

  get openLeases(): number {
    return this.#leases.size
  }

  async initialize(): Promise<void> {
    if (this.#initialized) return
    this.#initializing ??= this.#initializeOnce()
    try {
      await this.#initializing
    } finally {
      this.#initializing = undefined
    }
  }

  async #initializeOnce(): Promise<void> {
    if (this.#initialized) return
    await mkdir(this.#baseRoot, { recursive: true, mode: 0o700 })
    const base = await realpath(this.#baseRoot)
    const generationRoot = join(base, this.#generation)
    await mkdir(generationRoot, { recursive: true, mode: 0o700 })
    await this.#assertDirectory(generationRoot, base)
    const leftovers = await readdir(generationRoot)
    if (leftovers.length > 0) {
      const quarantine = join(
        base,
        `.${this.#generation}.orphan.${randomUUID()}`,
      )
      await rename(generationRoot, quarantine)
      await mkdir(generationRoot, { mode: 0o700 })
      await this.#removeWithRetry(quarantine, true)
    }
    const canonical = await realpath(generationRoot)
    const rootInfo = await this.#assertDirectory(canonical, base)
    this.#root = canonical
    this.#rootDev = rootInfo.dev
    this.#rootIno = rootInfo.ino
    this.#initialized = true
  }

  async publish(
    input: BlobInput,
    options: PublishBlobOptions,
  ): Promise<BlobHandleDto> {
    await this.initialize()
    if (this.#closed) throw new Error("Spool store is closed.")
    await this.#verifyRoot()
    this.#assertPublication(options)
    this.#pendingPublishes += 1
    const id = randomUUID()
    const finalPath = join(this.#root, `${id}.blob`)
    const temporaryPath = join(this.#root, `.${id}.${randomUUID()}.tmp`)
    this.#reserve(options.callId, options.byteLength)
    let published = false
    let file: Awaited<ReturnType<typeof open>> | undefined
    try {
      file = await open(
        temporaryPath,
        constants.O_WRONLY
          | constants.O_CREAT
          | constants.O_EXCL
          | constants.O_NOFOLLOW,
        0o600,
      )
      const digest = createHash("sha256")
      let measured = 0
      for await (const chunk of chunks(input)) {
        if (options.signal?.aborted)
          throw options.signal.reason ?? new Error("Aborted")
        measured += chunk.byteLength
        if (
          measured > options.byteLength
          || measured > this.#limits.perBlobBytes
        ) {
          throw new SpoolLimitError("Blob exceeded its declared byte length.")
        }
        digest.update(chunk)
        await writeChunk(file, chunk)
      }
      if (options.signal?.aborted) {
        throw options.signal.reason ?? new Error("Aborted")
      }
      if (measured !== options.byteLength) {
        throw new SpoolLimitError(
          `Blob length mismatch: expected ${options.byteLength}, received ${measured}.`,
        )
      }
      await file.sync()
      const fileInfo = await file.stat()
      if (
        !fileInfo.isFile()
        || fileInfo.nlink !== 1
        || fileInfo.dev !== this.#rootDev
      ) {
        throw new InvalidBlobHandleError(
          "Published blob is not a private regular file.",
        )
      }
      const digestHex = digest.digest("hex")
      await file.close()
      await this.#verifyRoot()
      await rename(temporaryPath, finalPath)
      const publishedInfo = await this.#openVerified(
        finalPath,
        fileInfo.dev,
        fileInfo.ino,
        options.byteLength,
      )
      await publishedInfo.close()
      published = true
      const handle: BlobHandleDto = {
        generation: this.#generation,
        id,
        byteLength: options.byteLength,
        ...(options.mediaType === undefined ?
          {}
        : { mediaType: options.mediaType }),
        ...(options.filename === undefined ?
          {}
        : { filename: options.filename }),
      }
      this.#leases.set(id, {
        handle,
        path: finalPath,
        callId: options.callId,
        refs: 1,
        dev: fileInfo.dev,
        ino: fileInfo.ino,
        digest: digestHex,
        deleting: false,
      })
      let call = this.#callLeases.get(options.callId)
      if (!call) {
        call = new Set()
        this.#callLeases.set(options.callId, call)
      }
      call.add(id)
      return structuredClone(handle)
    } finally {
      this.#pendingPublishes -= 1
      await file?.close().catch(() => undefined)
      if (!published) {
        this.#unreserve(options.callId, options.byteLength)
        await this.#removeWithRetry(temporaryPath)
      }
    }
  }

  retain(handle: BlobHandleDto): void {
    const lease = this.#lease(handle)
    if (lease.deleting) {
      throw new InvalidBlobHandleError("Blob lease is being deleted.")
    }
    lease.refs += 1
  }

  async release(handle: BlobHandleDto): Promise<void> {
    const lease = this.#lease(handle)
    if (lease.refs > 1) {
      lease.refs -= 1
      return
    }
    lease.deleting = true
    try {
      await this.#deleteLease(lease)
    } catch (error) {
      lease.deleting = false
      throw error
    }
    this.#leases.delete(handle.id)
    this.#callLeases.get(lease.callId)?.delete(handle.id)
    this.#unreserve(lease.callId, handle.byteLength)
  }

  async releaseCall(callId: string): Promise<void> {
    const owned = this.#callLeases.get(callId)
    if (!owned) return
    for (const id of owned) {
      const lease = this.#leases.get(id)
      if (!lease) {
        owned.delete(id)
        continue
      }
      await this.release(lease.handle)
      owned.delete(id)
    }
    if (owned.size === 0) this.#callLeases.delete(callId)
  }

  async *read(handle: BlobHandleDto): AsyncIterable<Uint8Array> {
    const lease = this.#lease(handle)
    await this.#verifyRoot()
    const file = await this.#openVerified(
      lease.path,
      lease.dev,
      lease.ino,
      handle.byteLength,
    )
    const digest = createHash("sha256")
    try {
      let offset = 0
      while (offset < handle.byteLength) {
        const length = Math.min(
          this.#limits.chunkBytes,
          handle.byteLength - offset,
        )
        const buffer = new Uint8Array(length)
        const result = await file.read(buffer, 0, length, offset)
        if (result.bytesRead === 0) break
        offset += result.bytesRead
        const chunk = buffer.subarray(0, result.bytesRead)
        digest.update(chunk)
        yield chunk
      }
      if (
        offset !== handle.byteLength
        || digest.digest("hex") !== lease.digest
      ) {
        throw new InvalidBlobHandleError(
          "Blob changed while it was being read.",
        )
      }
    } finally {
      await file.close()
    }
  }

  async resolvePath(handle: BlobHandleDto): Promise<string> {
    const lease = this.#lease(handle)
    const file = await this.#openVerified(
      lease.path,
      lease.dev,
      lease.ino,
      handle.byteLength,
    )
    await file.close()
    return lease.path
  }

  async close(): Promise<void> {
    if (this.#closed && !this.#initialized) return
    this.#closed = true
    if (this.#initialized) {
      await this.#verifyRoot()
      if (!this.#rootQuarantined) {
        const quarantine = join(
          dirname(this.#root),
          `.${this.#generation}.delete.${randomUUID()}`,
        )
        await rename(this.#root, quarantine)
        this.#root = quarantine
        this.#rootQuarantined = true
      }
      await this.#removeWithRetry(this.#root, true)
      this.#initialized = false
    }
    this.#leases.clear()
    this.#callLeases.clear()
    this.#callBytes.clear()
    this.#aggregateBytes = 0
  }

  static async cleanupGeneration(options: {
    root: string
    generation: string
    deleteRetry?: Partial<DeleteRetryPolicy>
    remove?: typeof rm
    sleep?: (milliseconds: number) => Promise<void>
  }): Promise<void> {
    const store = new GenerationSpoolStore(options)
    await store.initialize()
    store.#closed = true
    await store.#removeWithRetry(store.#root, true)
  }

  #assertPublication(options: PublishBlobOptions): void {
    if (!SAFE_CALL_ID.test(options.callId)) {
      throw new InvalidBlobHandleError("Call ID is not a safe spool identity.")
    }
    if (!Number.isSafeInteger(options.byteLength) || options.byteLength < 0) {
      throw new SpoolLimitError("Blob byte length is invalid.")
    }
    if (options.byteLength > this.#limits.perBlobBytes) {
      throw new SpoolLimitError("Blob exceeds the per-blob limit.")
    }
    if (this.#leases.size + this.#pendingPublishes >= this.#limits.maxBlobs) {
      throw new SpoolLimitError("Spool blob credit is exhausted.")
    }
    const callBytes = this.#callBytes.get(options.callId) ?? 0
    if (callBytes + options.byteLength > this.#limits.perCallBytes) {
      throw new SpoolLimitError("Call exceeds its spool byte limit.")
    }
    if (
      this.#aggregateBytes + options.byteLength
      > this.#limits.aggregateBytes
    ) {
      throw new SpoolLimitError("Generation exceeds its spool byte limit.")
    }
    if (options.filename !== undefined && byteLength(options.filename) > 4096) {
      throw new SpoolLimitError("Filename exceeds its spool metadata limit.")
    }
    if (
      options.mediaType !== undefined
      && byteLength(options.mediaType) > 512
    ) {
      throw new SpoolLimitError("Media type exceeds its spool metadata limit.")
    }
  }

  #reserve(callId: string, bytes: number): void {
    this.#aggregateBytes += bytes
    this.#callBytes.set(callId, (this.#callBytes.get(callId) ?? 0) + bytes)
  }

  #unreserve(callId: string, bytes: number): void {
    this.#aggregateBytes = Math.max(0, this.#aggregateBytes - bytes)
    const remaining = Math.max(0, (this.#callBytes.get(callId) ?? 0) - bytes)
    if (remaining === 0) this.#callBytes.delete(callId)
    else this.#callBytes.set(callId, remaining)
  }

  #lease(handle: BlobHandleDto): LeaseRecord {
    if (
      handle.generation !== this.#generation
      || !SAFE_ID.test(handle.id)
      || basename(handle.id) !== handle.id
    ) {
      throw new InvalidBlobHandleError("Blob handle is stale or unsafe.")
    }
    const lease = this.#leases.get(handle.id)
    if (
      !lease
      || lease.handle.byteLength !== handle.byteLength
      || lease.handle.filename !== handle.filename
      || lease.handle.mediaType !== handle.mediaType
    ) {
      throw new InvalidBlobHandleError(
        "Blob handle does not match an active lease.",
      )
    }
    return lease
  }

  async #assertDirectory(path: string, base: string) {
    const pathInfo = await lstat(path)
    const directory = await open(
      path,
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
    )
    try {
      const info = await directory.stat()
      const canonical = await realpath(path)
      if (
        pathInfo.isSymbolicLink()
        || !info.isDirectory()
        || info.dev !== pathInfo.dev
        || info.ino !== pathInfo.ino
        || !within(base, canonical)
      ) {
        throw new InvalidBlobHandleError("Spool root is not a safe directory.")
      }
      return info
    } finally {
      await directory.close()
    }
  }

  async #verifyRoot(): Promise<void> {
    const info = await lstat(this.#root)
    if (
      info.isSymbolicLink()
      || !info.isDirectory()
      || info.dev !== this.#rootDev
      || info.ino !== this.#rootIno
    ) {
      throw new InvalidBlobHandleError("Generation spool root was replaced.")
    }
  }

  async #openVerified(
    path: string,
    dev: number,
    ino: number,
    size: number,
  ): Promise<Awaited<ReturnType<typeof open>>> {
    await this.#verifyRoot()
    let file: Awaited<ReturnType<typeof open>>
    try {
      file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
    } catch (error) {
      throw new InvalidBlobHandleError(
        `Blob path cannot be opened safely: ${String(error)}`,
      )
    }
    try {
      const info = await file.stat()
      if (
        !info.isFile()
        || info.nlink !== 1
        || info.dev !== dev
        || info.ino !== ino
        || info.size !== size
      ) {
        throw new InvalidBlobHandleError("Blob file identity changed.")
      }
      return file
    } catch (error) {
      await file.close()
      throw error
    }
  }

  async #deleteLease(lease: LeaseRecord): Promise<void> {
    const file = await this.#openVerified(
      lease.path,
      lease.dev,
      lease.ino,
      lease.handle.byteLength,
    )
    await file.close()
    const quarantine = join(this.#root, `.${lease.handle.id}.delete`)
    if (lease.path !== quarantine) {
      await rename(lease.path, quarantine)
      lease.path = quarantine
    }
    const quarantined = await this.#openVerified(
      quarantine,
      lease.dev,
      lease.ino,
      lease.handle.byteLength,
    )
    await quarantined.close()
    await this.#removeWithRetry(quarantine)
  }

  async #removeWithRetry(path: string, recursive = false): Promise<void> {
    let delay = this.#retry.initialDelayMs
    for (let attempt = 0; attempt < this.#retry.attempts; attempt += 1) {
      try {
        await this.#remove(path, { force: true, recursive })
        return
      } catch (error) {
        if (!isRetryableDelete(error) || attempt + 1 >= this.#retry.attempts) {
          throw error
        }
        await this.#sleep(delay)
        delay = Math.min(this.#retry.maxDelayMs, delay * 2)
      }
    }
  }
}
