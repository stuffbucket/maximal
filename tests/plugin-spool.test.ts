/* eslint-disable max-lines-per-function -- cohesive spool lifecycle coverage shares cleanup setup */
import { afterEach, describe, expect, test } from "bun:test"
import {
  link,
  mkdtemp,
  readdir,
  rm,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import {
  GenerationSpoolStore,
  InvalidBlobHandleError,
  SpoolLimitError,
  multipartToFormData,
  readMultipart,
  spoolMultipart,
} from "~/lib/plugins/spool"

const roots: Array<string> = []

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise
  } catch (error) {
    return error
  }
  throw new Error("Expected the promise to reject.")
}

afterEach(async () => {
  for (const root of roots.splice(0)) {
    await rm(root, { recursive: true, force: true })
  }
})

async function store(
  options: ConstructorParameters<typeof GenerationSpoolStore>[0] = {
    root: "",
    generation: "generation-1",
  },
) {
  const root = await mkdtemp(join(tmpdir(), "maximal-spool-test-"))
  roots.push(root)
  return new GenerationSpoolStore({
    ...options,
    root,
    generation: options.generation || "generation-1",
  })
}

async function collect(stream: AsyncIterable<Uint8Array>): Promise<Uint8Array> {
  const chunks: Array<Uint8Array> = []
  let length = 0
  for await (const chunk of stream) {
    chunks.push(chunk)
    length += chunk.byteLength
  }
  const result = new Uint8Array(length)
  let offset = 0
  for (const chunk of chunks) {
    result.set(chunk, offset)
    offset += chunk.byteLength
  }
  return result
}

describe("generation spool", () => {
  test("preserves duplicate multipart names, metadata, lengths, and order", async () => {
    const spool = await store()
    const form = new FormData()
    form.append("tag", "one")
    form.append("file", new File(["abc"], "first.txt", { type: "text/plain" }))
    form.append("tag", "two")
    form.append(
      "file",
      new File(["xyz"], "second.bin", { type: "application/x-test" }),
    )
    const dto = await spoolMultipart(form, spool, { callId: "call-1" })
    expect(dto.parts.map((part) => part.name)).toEqual([
      "tag",
      "file",
      "tag",
      "file",
    ])
    expect(dto.parts[1]?.value).toMatchObject({
      filename: "first.txt",
      byteLength: 3,
    })
    const firstValue = dto.parts[1]?.value
    expect(
      typeof firstValue === "string" ? firstValue : firstValue.mediaType,
    ).toContain("text/plain")
    const values = []
    for (const part of readMultipart(dto, spool)) {
      values.push(
        part.kind === "text" ?
          part.value
        : new TextDecoder().decode(await collect(part.stream)),
      )
    }
    expect(values).toEqual(["one", "abc", "two", "xyz"])
    const projected = await multipartToFormData(dto, spool)
    expect(projected.getAll("tag")).toEqual(["one", "two"])
    expect(
      projected
        .getAll("file")
        .map((value) => (typeof value === "string" ? value : value.name)),
    ).toEqual(["first.txt", "second.bin"])
    await spool.close()
  })

  test("streams large binary values with bounded chunks", async () => {
    const spool = await store({
      root: "",
      generation: "generation-1",
      limits: {
        perBlobBytes: 2 * 1024 * 1024,
        perCallBytes: 2 * 1024 * 1024,
        aggregateBytes: 2 * 1024 * 1024,
        maxBlobs: 4,
        chunkBytes: 16 * 1024,
      },
    })
    const size = 1024 * 1024
    // Async iteration is the behavior under test; yielding itself need not await.
    // eslint-disable-next-line @typescript-eslint/require-await
    async function* source() {
      for (let offset = 0; offset < size; offset += 8 * 1024) {
        yield new Uint8Array(Math.min(8 * 1024, size - offset)).fill(7)
      }
    }
    const handle = await spool.publish(source(), {
      callId: "call-large",
      byteLength: size,
    })
    let measured = 0
    let largest = 0
    for await (const chunk of spool.read(handle)) {
      measured += chunk.byteLength
      largest = Math.max(largest, chunk.byteLength)
    }
    expect(measured).toBe(size)
    expect(largest).toBeLessThanOrEqual(16 * 1024)
    expect(spool.aggregateBytes).toBe(size)
    await spool.release(handle)
    expect(spool.aggregateBytes).toBe(0)
    await spool.close()
  })

  test("keeps retained leases alive when call ownership is released", async () => {
    const spool = await store()
    const handle = await spool.publish(new Uint8Array([1, 2]), {
      callId: "parent:0",
      byteLength: 2,
    })
    spool.retain(handle)
    await spool.releaseCall("parent:0")
    expect(spool.openLeases).toBe(1)
    expect(spool.aggregateBytes).toBe(2)
    expect(await collect(spool.read(handle))).toEqual(new Uint8Array([1, 2]))
    await spool.release(handle)
    expect(spool.openLeases).toBe(0)
    expect(spool.aggregateBytes).toBe(0)
    await spool.close()
  })

  test("reserves blob credits while publication is pending", async () => {
    const spool = await store({
      root: "",
      generation: "generation-1",
      limits: { maxBlobs: 1 },
    })
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    async function* blocked() {
      await gate
      yield new Uint8Array([1])
    }
    const first = spool.publish(blocked(), {
      callId: "parent:0",
      byteLength: 1,
    })
    await Bun.sleep(0)
    expect(
      await rejection(
        spool.publish(new Uint8Array([2]), {
          callId: "parent:1",
          byteLength: 1,
        }),
      ),
    ).toBeInstanceOf(SpoolLimitError)
    release()
    const handle = await first
    await spool.release(handle)
    await spool.close()
  })

  test("retains call ownership when cleanup fails so it can retry", async () => {
    let fail = true
    const spool = await store({
      root: "",
      generation: "generation-1",
      deleteRetry: { attempts: 1 },
      remove: async (...args) => {
        if (fail) throw Object.assign(new Error("locked"), { code: "EPERM" })
        await rm(...args)
      },
    })
    await spool.publish(new Uint8Array([1]), {
      callId: "parent:0",
      byteLength: 1,
    })
    expect(await rejection(spool.releaseCall("parent:0"))).toBeInstanceOf(Error)
    expect(spool.openLeases).toBe(1)
    expect(spool.aggregateBytes).toBe(1)
    fail = false
    await spool.releaseCall("parent:0")
    expect(spool.openLeases).toBe(0)
    expect(spool.aggregateBytes).toBe(0)
    await spool.close()
  })

  test("enforces aggregate, per-call, and per-blob credits", async () => {
    const spool = await store({
      root: "",
      generation: "generation-1",
      limits: {
        perBlobBytes: 4,
        perCallBytes: 5,
        aggregateBytes: 6,
        maxBlobs: 2,
        chunkBytes: 2,
      },
    })
    expect(
      await rejection(
        spool.publish(new Uint8Array(5), {
          callId: "call-1",
          byteLength: 5,
        }),
      ),
    ).toBeInstanceOf(SpoolLimitError)
    const first = await spool.publish(new Uint8Array(4), {
      callId: "call-1",
      byteLength: 4,
    })
    expect(
      await rejection(
        spool.publish(new Uint8Array(2), {
          callId: "call-1",
          byteLength: 2,
        }),
      ),
    ).toBeInstanceOf(SpoolLimitError)
    expect(
      await rejection(
        spool.publish(new Uint8Array(3), {
          callId: "call-2",
          byteLength: 3,
        }),
      ),
    ).toBeInstanceOf(SpoolLimitError)
    await spool.release(first)
    await spool.close()
  })

  test("cleans partial files on abort and whole generations after crashes", async () => {
    const spool = await store()
    const controller = new AbortController()
    // Async iteration is the behavior under test; yielding itself need not await.
    // eslint-disable-next-line @typescript-eslint/require-await
    async function* source() {
      yield new Uint8Array([1, 2])
      controller.abort("stop")
      yield new Uint8Array([3, 4])
    }
    expect(
      await rejection(
        spool.publish(source(), {
          callId: "call-abort",
          byteLength: 4,
          signal: controller.signal,
        }),
      ),
    ).toBe("stop")
    expect(spool.aggregateBytes).toBe(0)

    const handle = await spool.publish(new Uint8Array([1]), {
      callId: "call-crash",
      byteLength: 1,
    })
    const path = await spool.resolvePath(handle)
    const generationRoot = join(path, "..")
    await GenerationSpoolStore.cleanupGeneration({
      root: join(generationRoot, ".."),
      generation: "generation-1",
    })
    expect(await rejection(readdir(generationRoot))).toBeInstanceOf(Error)
  })

  test("rejects traversal, stale generations, and symlink replacement", async () => {
    const spool = await store()
    const handle = await spool.publish(new Uint8Array([1, 2, 3]), {
      callId: "call-safe",
      byteLength: 3,
    })
    expect(() => spool.retain({ ...handle, id: "../escape" })).toThrow(
      InvalidBlobHandleError,
    )
    expect(() => spool.retain({ ...handle, generation: "old" })).toThrow(
      InvalidBlobHandleError,
    )
    const path = await spool.resolvePath(handle)
    const outside = join(path, "..", "outside")
    await writeFile(outside, "abc")
    await unlink(path)
    await symlink(outside, path)
    expect(await rejection(spool.resolvePath(handle))).toBeInstanceOf(
      InvalidBlobHandleError,
    )

    const hardlinkHandle = await spool.publish(new Uint8Array([4, 5, 6]), {
      callId: "call-hardlink",
      byteLength: 3,
    })
    const hardlinkPath = await spool.resolvePath(hardlinkHandle)
    const hardlinkOutside = join(hardlinkPath, "..", "hardlink-outside")
    await writeFile(hardlinkOutside, "def")
    await unlink(hardlinkPath)
    await link(hardlinkOutside, hardlinkPath)
    expect(await rejection(spool.resolvePath(hardlinkHandle))).toBeInstanceOf(
      InvalidBlobHandleError,
    )
  })

  test("retries Windows-style locked file deletion with bounded backoff", async () => {
    let attempts = 0
    const delays: Array<number> = []
    const spool = await store({
      root: "",
      generation: "generation-1",
      deleteRetry: { attempts: 4, initialDelayMs: 2, maxDelayMs: 3 },
      remove: async (...args) => {
        attempts += 1
        if (attempts < 3)
          throw Object.assign(new Error("locked"), { code: "EPERM" })
        await rm(...args)
      },
      sleep: (milliseconds) => {
        delays.push(milliseconds)
        return Promise.resolve()
      },
    })
    const handle = await spool.publish(new Uint8Array([1]), {
      callId: "call-lock",
      byteLength: 1,
    })
    await spool.release(handle)
    expect(attempts).toBe(3)
    expect(delays).toEqual([2, 3])
    await spool.close()
  })
})
