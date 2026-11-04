/**
 * A fake Work IQ: a real MCP Streamable HTTP server on loopback (agent-kit
 * `workiqtest` style). Checks the bearer token, serves a recorded tool list,
 * answers `tools/call` through per-test handlers, and can inject HTTP
 * failures (429/503/403 …) ahead of the MCP layer.
 */
import {
  Server,
  WebStandardStreamableHTTPServerTransport,
  type CallToolResult,
  type ServerContext,
  type Tool,
} from "@modelcontextprotocol/server"

export type FakeToolHandler = (
  args: Record<string, unknown>,
  ctx: ServerContext,
  meta: { progressToken?: string | number },
) => Promise<CallToolResult>

export interface RecordedRequest {
  method: string
  authorization: string | null
  sessionId: string | null
  /** JSON-RPC method of a POST body (first message). */
  rpc?: string
  status: number
}

export interface FakeWorkIqOptions {
  token?: string
  tools?: Array<Tool>
  handlers?: Record<string, FakeToolHandler>
}

/** Failure injected before the MCP layer, consumed in order. */
export interface InjectedFailure {
  status: number
  body?: string
  headers?: Record<string, string>
  /** Only fail requests carrying this JSON-RPC method. */
  rpc?: string
}

export interface FakeWorkIq {
  readonly url: string
  readonly requests: Array<RecordedRequest>
  token: string
  tools: Array<Tool>
  handlers: Record<string, FakeToolHandler>
  fail(failure: InjectedFailure, times?: number): void
  /** Replace the tool list and notify every open session. */
  setTools(tools: Array<Tool>): Promise<void>
  /** Forget every session (subsequent calls get 404). */
  expireSessions(): Promise<void>
  readonly sessionCount: number
  calls(): Array<{ name: string; args: Record<string, unknown> }>
  close(): Promise<void>
}

/** Recorded tool list in the shape Work IQ serves (synthetic descriptions). */
export const RECORDED_TOOLS: Array<Tool> = [
  {
    name: "ask",
    title: "Ask Work IQ",
    description: "Ask a question about your Microsoft 365 work data.",
    inputSchema: {
      type: "object",
      properties: { question: { type: "string" } },
      required: ["question"],
    },
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  {
    name: "fetch",
    description: "Fetch Microsoft Graph entities by path.",
    inputSchema: {
      type: "object",
      properties: { entityUrls: { type: "array", items: { type: "string" } } },
      required: ["entityUrls"],
    },
    outputSchema: {
      type: "object",
      properties: { results: { type: "array" } },
    },
    annotations: { readOnlyHint: true, idempotentHint: true },
  },
  {
    name: "search_paths",
    description: "Search the catalog of allowed Graph paths.",
    inputSchema: { type: "object", properties: { query: { type: "string" } } },
  },
]

function rpcMethod(body: unknown): string | undefined {
  const first: unknown = Array.isArray(body) ? (body[0] as unknown) : body
  if (
    first !== null
    && typeof first === "object"
    && typeof (first as { method?: unknown }).method === "string"
  ) {
    return (first as { method: string }).method
  }
  return undefined
}

function lookup<T>(record: Record<string, T>, key: string): T | undefined {
  return Object.hasOwn(record, key) ? record[key] : undefined
}

// eslint-disable-next-line @typescript-eslint/no-deprecated -- the low-level Server serves raw tools/list and tools/call handlers, which is all this fake needs
type LowLevelServer = Server

interface Session {
  server: LowLevelServer
  transport: WebStandardStreamableHTTPServerTransport
}

interface FakeState {
  token: string
  tools: Array<Tool>
  handlers: Record<string, FakeToolHandler>
}

interface FakeContext {
  state: FakeState
  requests: Array<RecordedRequest>
  failures: Array<InjectedFailure>
  sessions: Map<string, Session>
  callLog: Array<{ name: string; args: Record<string, unknown> }>
}

function createSession(
  fake: FakeContext,
): WebStandardStreamableHTTPServerTransport {
  const { state, sessions, callLog } = fake
  // eslint-disable-next-line @typescript-eslint/no-deprecated -- see LowLevelServer
  const server = new Server(
    { name: "fake-workiq", version: "1.0.0" },
    { capabilities: { tools: { listChanged: true } } },
  )
  server.setRequestHandler("tools/list", () => ({ tools: state.tools }))
  server.setRequestHandler("tools/call", async (request, ctx) => {
    const args = (request.params.arguments ?? {}) as Record<string, unknown>
    callLog.push({ name: request.params.name, args })
    const handler = lookup(state.handlers, request.params.name)
    if (!handler)
      return {
        content: [
          {
            type: "text",
            text: `${request.params.name}:${JSON.stringify(args)}`,
          },
        ],
      }
    const progressToken = request.params._meta?.progressToken
    return await handler(
      args,
      ctx,
      progressToken === undefined ? {} : { progressToken },
    )
  })
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: () => crypto.randomUUID(),
    onsessioninitialized: (id) => {
      sessions.set(id, { server, transport })
    },
    onsessionclosed: (id) => {
      sessions.delete(id)
    },
  })
  void server.connect(transport)
  return transport
}

function sessionNotFound(): Response {
  return new Response(
    JSON.stringify({
      jsonrpc: "2.0",
      error: { code: -32001, message: "Session not found" },
      id: null,
    }),
    { status: 404, headers: { "content-type": "application/json" } },
  )
}

async function handleRequest(
  fake: FakeContext,
  request: Request,
): Promise<Response> {
  const { state, requests, failures, sessions } = fake
  const authorization = request.headers.get("authorization")
  const sessionId = request.headers.get("mcp-session-id")
  let body: unknown
  if (request.method === "POST")
    body = await request
      .clone()
      .json()
      .catch(() => undefined)
  const rpc = rpcMethod(body)
  const record = (status: number) => {
    requests.push({
      method: request.method,
      authorization,
      sessionId,
      ...(rpc ? { rpc } : {}),
      status,
    })
  }

  const failureIndex = failures.findIndex(
    (failure) => !failure.rpc || failure.rpc === rpc,
  )
  if (failureIndex !== -1 && request.method === "POST") {
    const failure = failures.splice(failureIndex, 1).at(0)
    if (failure) {
      record(failure.status)
      return new Response(failure.body ?? "", {
        status: failure.status,
        headers: failure.headers ?? {},
      })
    }
  }
  if (authorization !== `Bearer ${state.token}`) {
    record(401)
    return new Response(JSON.stringify({ error: "invalid_token" }), {
      status: 401,
      headers: { "www-authenticate": 'Bearer error="invalid_token"' },
    })
  }
  let transport: WebStandardStreamableHTTPServerTransport | undefined
  if (sessionId) {
    transport = sessions.get(sessionId)?.transport
    if (!transport) {
      record(404)
      return sessionNotFound()
    }
  } else if (rpc === "initialize") {
    transport = createSession(fake)
  } else {
    record(400)
    return new Response("missing session", { status: 400 })
  }
  const response = await transport.handleRequest(
    request,
    body === undefined ? undefined : { parsedBody: body },
  )
  record(response.status)
  return response
}

export function startFakeWorkIq(options: FakeWorkIqOptions = {}): FakeWorkIq {
  const fake: FakeContext = {
    state: {
      token: options.token ?? "token-1",
      tools: options.tools ?? RECORDED_TOOLS,
      handlers: options.handlers ?? {},
    },
    requests: [],
    failures: [],
    sessions: new Map(),
    callLog: [],
  }
  const { state, requests, failures, sessions, callLog } = fake

  const http = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    idleTimeout: 0,
    fetch: (request) => handleRequest(fake, request),
  })

  const url = `http://127.0.0.1:${http.port}/mcp`

  return {
    url,
    requests,
    get token() {
      return state.token
    },
    set token(value: string) {
      state.token = value
    },
    get tools() {
      return state.tools
    },
    set tools(value: Array<Tool>) {
      state.tools = value
    },
    get handlers() {
      return state.handlers
    },
    set handlers(value: Record<string, FakeToolHandler>) {
      state.handlers = value
    },
    get sessionCount() {
      return sessions.size
    },
    fail(failure, times = 1) {
      for (let i = 0; i < times; i++) failures.push(failure)
    },
    async setTools(tools) {
      state.tools = tools
      await Promise.all(
        [...sessions.values()].map(({ server }) =>
          server.sendToolListChanged().catch(() => {}),
        ),
      )
    },
    async expireSessions() {
      const open = [...sessions.values()]
      sessions.clear()
      await Promise.all(
        open.map(({ server }) => server.close().catch(() => {})),
      )
    },
    calls: () => [...callLog],
    async close() {
      await Promise.all(
        [...sessions.values()].map(({ server }) =>
          server.close().catch(() => {}),
        ),
      )
      sessions.clear()
      await http.stop(true)
    },
  }
}
