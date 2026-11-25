import { afterEach, describe, expect, test } from "bun:test"
import { setTimeout as delay } from "node:timers/promises"

import { parseAdapterUrl } from "~/lib/mcp-stdio/adapter"
import { MCP_STDIO_API_KEY_ENV } from "~/lib/mcp-stdio/command"

interface JsonRpcMessage {
  jsonrpc: "2.0"
  id?: string | number
  method?: string
  params?: unknown
  result?: unknown
}

function response(message: JsonRpcMessage, result: unknown): Response {
  return Response.json(
    { jsonrpc: "2.0", id: message.id, result },
    { headers: { "mcp-session-id": "session-1" } },
  )
}

function stdoutLines(stream: ReadableStream<Uint8Array>) {
  const reader = stream.getReader()
  const decoder = new TextDecoder()
  let buffered = ""
  return {
    async next(): Promise<JsonRpcMessage> {
      for (;;) {
        const end = buffered.indexOf("\n")
        if (end !== -1) {
          const line = buffered.slice(0, end)
          buffered = buffered.slice(end + 1)
          return JSON.parse(line) as JsonRpcMessage
        }
        const read = await Promise.race([
          reader.read(),
          delay(5_000).then(() => {
            throw new Error("timed out waiting for adapter stdout")
          }),
        ])
        if (read.done) throw new Error("adapter stdout closed")
        buffered += decoder.decode(read.value, { stream: true })
      }
    },
  }
}

async function waitFor(check: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (check()) return
    await delay(10)
  }
  throw new Error("timed out waiting for MCP event stream")
}

function writeMessage(
  stdin: Bun.FileSink,
  message: JsonRpcMessage,
): Promise<number> {
  void stdin.write(`${JSON.stringify(message)}\n`)
  return Promise.resolve(stdin.flush())
}

describe("MCP stdio adapter URL", () => {
  test("accepts only the aggregate loopback HTTP endpoint", () => {
    expect(parseAdapterUrl("http://127.0.0.1:4141/mcp").href).toBe(
      "http://127.0.0.1:4141/mcp",
    )
    expect(parseAdapterUrl("http://localhost:4141/mcp").hostname).toBe(
      "localhost",
    )
    expect(parseAdapterUrl("http://[::1]:4141/mcp").hostname).toBe("[::1]")

    const credentialedLoopbackUrl = new URL("http://127.0.0.1:4141/mcp")
    credentialedLoopbackUrl.username = "user"
    credentialedLoopbackUrl.password = "pass"

    for (const invalid of [
      "https://127.0.0.1:4141/mcp",
      "http://example.com/mcp",
      credentialedLoopbackUrl.href,
      "http://127.0.0.1:4141/mcp/",
      "http://127.0.0.1:4141/mcp/workiq",
      "http://127.0.0.1:4141/mcp?key=value",
      "http://127.0.0.1:4141/mcp#fragment",
    ]) {
      expect(() => parseAdapterUrl(invalid)).toThrow()
    }
  })
})

describe("MCP stdio bridge", () => {
  let child: Bun.Subprocess<"pipe", "pipe", "pipe"> | undefined
  let server: ReturnType<typeof Bun.serve> | undefined

  afterEach(async () => {
    const currentChild = child
    const currentServer = server
    child = undefined
    server = undefined
    currentChild?.kill()
    await currentChild?.exited
    await currentServer?.stop(true)
  })

  test("forwards requests, notifications, progress and elicitation", async () => {
    const authorizations: Array<string | null> = []
    const clientMessages: Array<JsonRpcMessage> = []
    let deleted = false
    let events: ReadableStreamDefaultController<Uint8Array> | undefined
    const encoder = new TextEncoder()

    server = Bun.serve({
      port: 0,
      async fetch(request) {
        authorizations.push(request.headers.get("authorization"))
        if (request.method === "DELETE") {
          deleted = true
          events?.close()
          return new Response(null, { status: 200 })
        }
        if (request.method === "GET") {
          return new Response(
            new ReadableStream<Uint8Array>({
              start(controller) {
                events = controller
              },
            }),
            { headers: { "content-type": "text/event-stream" } },
          )
        }
        const message = (await request.json()) as JsonRpcMessage
        clientMessages.push(message)
        if (message.method === "initialize") {
          return response(message, {
            protocolVersion: "2025-06-18",
            capabilities: { tools: { listChanged: true } },
            serverInfo: { name: "maximal", version: "test" },
          })
        }
        if (message.method === "tools/list") {
          return response(message, {
            tools: [
              {
                name: "workiq__retrieve",
                description: "Retrieve",
                inputSchema: { type: "object" },
              },
            ],
          })
        }
        if (message.method === "tools/call") {
          return response(message, {
            content: [{ type: "text", text: "ok" }],
          })
        }
        return new Response(null, { status: 202 })
      },
    })

    child = Bun.spawn(
      [
        processExecPath(),
        "src/main.ts",
        "mcp",
        "stdio",
        "--url",
        `http://127.0.0.1:${server.port}/mcp`,
      ],
      {
        cwd: process.cwd(),
        env: { ...process.env, [MCP_STDIO_API_KEY_ENV]: "desktop-key" },
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
      },
    )
    const stdin = child.stdin
    const lines = stdoutLines(child.stdout)

    await writeMessage(stdin, {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: { elicitation: {} },
        clientInfo: { name: "desktop-test", version: "1" },
      },
    })
    expect(await lines.next()).toMatchObject({
      id: 1,
      result: { serverInfo: { name: "maximal" } },
    })

    await writeMessage(stdin, {
      jsonrpc: "2.0",
      method: "notifications/initialized",
    })
    await waitFor(() => events !== undefined)
    const emit = (message: JsonRpcMessage) => {
      events?.enqueue(
        encoder.encode(`event: message\ndata: ${JSON.stringify(message)}\n\n`),
      )
    }
    emit({ jsonrpc: "2.0", method: "notifications/tools/list_changed" })
    expect(await lines.next()).toEqual({
      jsonrpc: "2.0",
      method: "notifications/tools/list_changed",
    })

    emit({
      jsonrpc: "2.0",
      method: "notifications/progress",
      params: { progressToken: "p1", progress: 1, total: 2 },
    })
    expect(await lines.next()).toMatchObject({
      method: "notifications/progress",
      params: { progressToken: "p1" },
    })

    emit({
      jsonrpc: "2.0",
      id: "elicit-1",
      method: "elicitation/create",
      params: {
        message: "Continue?",
        requestedSchema: { type: "object", properties: {} },
      },
    })
    expect(await lines.next()).toMatchObject({
      id: "elicit-1",
      method: "elicitation/create",
    })
    await writeMessage(stdin, {
      jsonrpc: "2.0",
      id: "elicit-1",
      result: { action: "decline" },
    })
    await waitFor(() =>
      clientMessages.some(
        (message) => message.id === "elicit-1" && message.result !== undefined,
      ),
    )

    await writeMessage(stdin, {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/list",
      params: {},
    })
    expect(await lines.next()).toMatchObject({
      id: 2,
      result: { tools: [{ name: "workiq__retrieve" }] },
    })

    await writeMessage(stdin, {
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { name: "workiq__retrieve", arguments: {} },
    })
    expect(await lines.next()).toMatchObject({
      id: 3,
      result: { content: [{ text: "ok" }] },
    })

    await stdin.end()
    expect(await child.exited).toBe(0)
    expect(deleted).toBe(true)
    expect(new Set(authorizations)).toEqual(new Set(["Bearer desktop-key"]))
    expect((await new Response(child.stderr).text()).trim()).toBe("")
  })
})

function processExecPath(): string {
  return globalThis.process.execPath
}
