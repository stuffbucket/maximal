import { afterEach, describe, expect, test } from "bun:test"
import { Hono } from "hono"

import {
  requestContext,
  setRequestUsage,
} from "../src/lib/http/request-context"
import { traceIdMiddleware } from "../src/lib/http/trace"
import {
  __resetInFlightForTests,
  IN_FLIGHT_MAX_AGE_MS,
  listInFlight,
  STREAM_BYTES_PER_TOKEN,
  trackInFlight,
} from "../src/lib/token-usage/in-flight"
import { server } from "../src/server"

const encoder = new TextEncoder()

/** Let queued stream microtasks and the transform pipeline settle. */
const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 5))

interface Handle {
  send: (text: string) => void
  close: () => void
}

function streamApp(mounts: Array<string> = ["/stream"]) {
  let controller: ReadableStreamDefaultController<Uint8Array> | undefined
  const handle: Handle = {
    send: (text) => controller?.enqueue(encoder.encode(text)),
    close: () => controller?.close(),
  }
  const app = new Hono()
  app.use(traceIdMiddleware)
  for (const mount of mounts) app.use(mount, trackInFlight)
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
    app.onError((_error, c) => c.text("err", 500))
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

  test("clears when next() rejects", async () => {
    const app = new Hono()
    app.use(traceIdMiddleware)
    app.use("/rejects", trackInFlight)
    app.use("/rejects", async () => {
      await Promise.resolve()
      throw new Error("rejected")
    })
    app.onError((_error, c) => c.text("err", 500))
    const response = await app.request("/rejects")
    await response.text()
    expect(listInFlight()).toHaveLength(0)

    // Direct middleware call with a rejecting next(): the finally path.
    let seen = 0
    let caught: unknown
    const next = () => {
      seen = listInFlight().length
      return Promise.reject(new Error("direct"))
    }
    const context = {
      traceId: "t",
      startTime: Date.now(),
      userAgent: "",
      sessionAffinity: undefined,
      parentSessionId: undefined,
      usage: {},
    }
    try {
      await requestContext.run(context, () =>
        trackInFlight({ res: new Response() } as never, next),
      )
    } catch (error) {
      caught = error
    }
    expect(caught).toBeInstanceOf(Error)
    expect(seen).toBe(1)
    expect(listInFlight()).toHaveLength(0)
  })

  test("registers once when the middleware is mounted twice", async () => {
    const { app, handle } = streamApp(["/stream", "/stream/*"])
    const response = await app.request("/stream")
    const reader = readerOf(response)
    handle.send("data: a\n\n")
    await reader.read()
    const open = listInFlight()
    expect(open).toHaveLength(1)
    expect(open[0]?.streamedBytes).toBe(9)
    await reader.cancel()
  })

  test("drops entries older than the max age", async () => {
    const { app, handle } = streamApp()
    const response = await app.request("/stream")
    const reader = readerOf(response)
    handle.send("data: a\n\n")
    await reader.read()
    const startedAt = listInFlight()[0]?.startedAtMs ?? 0
    expect(startedAt).toBeGreaterThan(0)
    expect(listInFlight(startedAt + IN_FLIGHT_MAX_AGE_MS - 1)).toHaveLength(1)
    expect(listInFlight(startedAt + IN_FLIGHT_MAX_AGE_MS + 1)).toHaveLength(0)
    // Pruned for good, not just hidden for that call.
    expect(listInFlight(startedAt)).toHaveLength(0)
    await reader.cancel()
  })
})

const mounts = (path: string) =>
  server.routes.filter(
    (route) =>
      route.handler === trackInFlight
      && new RegExp(
        `^${route.path.replaceAll(/:\w+/g, "[^/]+").replace("/*", "(?:/.*)?")}$`,
      ).test(path),
  ).length

describe("server mounts", () => {
  const trackedRequests = [
    "/chat/completions",
    "/responses",
    "/v1/chat/completions",
    "/v1/responses",
    "/v1/messages",
    "/v1/messages/count_tokens",
    "/some-provider/v1/messages",
  ]
  const untracked = [
    "/models",
    "/v1/models",
    "/embeddings",
    "/v1/embeddings",
    "/token-usage",
    "/settings/api/x",
    "/ui/x",
    "/mcp/x",
  ]
  test("each tracked request path matches exactly one mount", () => {
    for (const path of trackedRequests) {
      expect([path, mounts(path)]).toEqual([path, 1])
    }
  })

  test("other routes are not tracked", () => {
    for (const path of untracked) {
      expect([path, mounts(path)]).toEqual([path, 0])
    }
  })
})
