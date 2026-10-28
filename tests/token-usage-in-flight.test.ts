import { afterEach, describe, expect, test } from "bun:test"
import { Hono } from "hono"

import {
  requestContext,
  setRequestUsage,
} from "../src/lib/http/request-context"
import { traceIdMiddleware } from "../src/lib/http/trace"
import {
  __inFlightCountForTests,
  __resetInFlightForTests,
  DeltaTextCounter,
  IN_FLIGHT_MAX_AGE_MS,
  listInFlight,
  STREAM_CHARS_PER_TOKEN,
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

/** One SSE event per wire format, each carrying `text` as its delta. */
const anthropicDelta = (text: string) =>
  `event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"${text}"}}\n\n`
const responsesDelta = (text: string) =>
  `event: response.output_text.delta\ndata: {"type":"response.output_text.delta","item_id":"msg_1","output_index":0,"content_index":0,"delta":"${text}"}\n\n`
const chatDelta = (text: string) =>
  `data: {"id":"c1","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"content":"${text}"}}]}\n\n`

/** Delta characters a fresh counter finds in `chunks`. */
function count(...chunks: Array<string>): number {
  const counter = new DeltaTextCounter()
  return chunks.reduce(
    (sum, chunk) => sum + counter.feed(encoder.encode(chunk)),
    0,
  )
}

describe("DeltaTextCounter", () => {
  test("counts the delta text of each wire format, not the framing", () => {
    expect(count(anthropicDelta("Hello"))).toBe(5)
    expect(count(responsesDelta("abc"))).toBe(3)
    expect(count(chatDelta("xy"))).toBe(2)
  })

  test("counts tool-call arguments and thinking as they stream", () => {
    expect(
      count(
        'data: {"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"{\\"a\\":1}"}}\n\n',
        'data: {"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"hmm"}}\n\n',
        'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{}"}}]}}]}\n\n',
      ),
    ).toBe(9 + 3 + 2)
  })

  test("ignores events that repeat the finished text", () => {
    expect(
      count(
        'data: {"type":"response.output_text.done","text":"Hello there"}\n\n',
        'data: {"type":"response.completed","response":{"output":[{"content":[{"type":"output_text","text":"Hello there"}]}]}}\n\n',
        'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":3}}\n\n',
      ),
    ).toBe(0)
  })

  test("an event split across chunks counts once it is complete", () => {
    const event = anthropicDelta("split text")
    const counter = new DeltaTextCounter()
    expect(counter.feed(encoder.encode(event.slice(0, 70)))).toBe(0)
    expect(counter.feed(encoder.encode(event.slice(70)))).toBe(10)
  })

  test("a typical delta event is several times longer than its text", () => {
    // Why raw bytes overstated tokens: the framing dwarfs a few tokens.
    const event = anthropicDelta("Hello")
    expect(event.length).toBeGreaterThan(20 * count(event))
  })
})

describe("trackInFlight", () => {
  test("estimates four characters of streamed text per token", () => {
    expect(STREAM_CHARS_PER_TOKEN).toBe(4)
  })

  test("counts streamed text while open and clears on close", async () => {
    const { app, handle } = streamApp()
    const response = await app.request("/stream", {
      headers: { "user-agent": "claude-cli/2.1.0 (external, cli)" },
    })
    expect(response.status).toBe(200)
    expect(response.headers.get("x-extra")).toBe("kept")
    expect(response.headers.get("content-type")).toBe("text/event-stream")

    const reader = readerOf(response)
    handle.send(anthropicDelta("one"))
    handle.send(anthropicDelta("three"))
    // Chunks arrive incrementally, before the stream closes.
    const first = await reader.read()
    expect(first.done).toBe(false)
    await reader.read()

    const open = listInFlight()
    expect(open).toHaveLength(1)
    expect(open[0]?.streamedChars).toBe(8)
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
    handle.send(chatDelta("a"))
    await reader.read()
    const open = listInFlight()
    expect(open).toHaveLength(1)
    expect(open[0]?.streamedChars).toBe(1)
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

  test("registering a request drops entries older than the max age", async () => {
    // A response nobody reads: its entry would sit there until a list.
    const leaked = {
      traceId: "leaked",
      startTime: Date.now() - IN_FLIGHT_MAX_AGE_MS - 1,
      userAgent: "",
      sessionAffinity: undefined,
      parentSessionId: undefined,
      usage: {},
    }
    const c = { res: new Response(new ReadableStream<Uint8Array>()) }
    await requestContext.run(leaked, () =>
      trackInFlight(c as never, () => Promise.resolve()),
    )
    expect(__inFlightCountForTests()).toBe(1)

    const { app, handle } = streamApp()
    const response = await app.request("/stream")
    const reader = readerOf(response)
    handle.send(chatDelta("a"))
    await reader.read()
    expect(__inFlightCountForTests()).toBe(1)
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
