import { afterEach, describe, expect, test } from "bun:test"
import { Hono } from "hono"

import { setRequestUsage } from "../src/lib/http/request-context"
import { traceIdMiddleware } from "../src/lib/http/trace"
import {
  __resetInFlightForTests,
  listInFlight,
  STREAM_BYTES_PER_TOKEN,
  trackInFlight,
} from "../src/lib/token-usage/in-flight"

const encoder = new TextEncoder()

/** Let queued stream microtasks and the transform pipeline settle. */
const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 5))

interface Handle {
  send: (text: string) => void
  close: () => void
}

function streamApp() {
  let controller: ReadableStreamDefaultController<Uint8Array> | undefined
  const handle: Handle = {
    send: (text) => controller?.enqueue(encoder.encode(text)),
    close: () => controller?.close(),
  }
  const app = new Hono()
  app.use(traceIdMiddleware)
  app.use("/stream", trackInFlight)
  app.get("/stream", () => {
    setRequestUsage({ sessionId: "late-session", model: "late-model" })
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        controller = c
      },
    })
    return new Response(body, {
      status: 200,
      headers: { "content-type": "text/event-stream", "x-extra": "kept" },
    })
  })
  return { app, handle }
}

function readerOf(response: Response) {
  if (!response.body) throw new Error("response has no body")
  return response.body.getReader()
}

afterEach(() => {
  __resetInFlightForTests()
})

describe("trackInFlight", () => {
  test("exposes a bytes-per-token estimate", () => {
    expect(STREAM_BYTES_PER_TOKEN).toBe(16)
  })

  test("counts streamed bytes while open and clears on close", async () => {
    const { app, handle } = streamApp()
    const response = await app.request("/stream", {
      headers: { "user-agent": "claude-cli/2.1.0 (external, cli)" },
    })
    expect(response.status).toBe(200)
    expect(response.headers.get("x-extra")).toBe("kept")
    expect(response.headers.get("content-type")).toBe("text/event-stream")

    const reader = readerOf(response)
    handle.send("data: one\n\n")
    handle.send("data: two\n\n")
    // Chunks arrive incrementally, before the stream closes.
    const first = await reader.read()
    expect(first.done).toBe(false)
    await reader.read()

    const open = listInFlight()
    expect(open).toHaveLength(1)
    expect(open[0]?.streamedBytes).toBe(22)
    // Session and model were filled in after the middleware registered.
    expect(open[0]?.sessionId).toBe("late-session")
    expect(open[0]?.model).toBe("late-model")
    expect(open[0]?.client).toBe("claude-code")
    expect(open[0]?.traceId).toBeTruthy()
    expect(open[0]?.startedAtMs).toBeGreaterThan(0)

    handle.close()
    expect((await reader.read()).done).toBe(true)
    await settle()
    expect(listInFlight()).toHaveLength(0)
  })

  test("clears when the client cancels", async () => {
    const { app, handle } = streamApp()
    const response = await app.request("/stream")
    const reader = readerOf(response)
    handle.send("data: x\n\n")
    await reader.read()
    expect(listInFlight()).toHaveLength(1)

    await reader.cancel()
    await settle()
    expect(listInFlight()).toHaveLength(0)
  })

  test("clears when a handler throws", async () => {
    const app = new Hono()
    app.use(traceIdMiddleware)
    app.use("/boom", trackInFlight)
    app.get("/boom", () => {
      throw new Error("boom")
    })
    const response = await app.request("/boom")
    expect(response.status).toBe(500)
    // Hono turns the throw into a 500 response; delivering it ends the entry.
    await response.text()
    expect(listInFlight()).toHaveLength(0)
  })

  test("clears right after a non-streaming response", async () => {
    const app = new Hono()
    app.use(traceIdMiddleware)
    app.use("/json", trackInFlight)
    app.get("/json", (c) => c.json({ ok: true }))
    const response = await app.request("/json")
    expect(await response.json()).toEqual({ ok: true })
    expect(listInFlight()).toHaveLength(0)
  })
})
