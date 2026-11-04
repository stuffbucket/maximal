/**
 * A fake remote MCP server: a real MCP Streamable HTTP server on loopback
 * (agent-kit `workiqtest` style), for connector tests and the bench.
 *
 * - Serves a seedable tool list; `tools/call` answers from per-tool
 *   handlers, then canned results, then an echo.
 * - Checks `Authorization: Bearer <token>` (unless `token: null`).
 * - Legacy (2025, sessionful) by default; `protocol: "modern"` also serves
 *   2026-07-28 traffic (`server/discover`), as a server that supports both.
 * - Optional `oauth`: RFC 9728 protected-resource metadata plus a fake,
 *   auto-approving OAuth authorization server (RFC 8414 metadata, PKCE
 *   authorize, token + refresh, optional dynamic registration).
 * - Records HTTP requests and tool calls; can inject HTTP failures and
 *   throttling (HTTP-level or inside a tool result, `throttle()`, or a
 *   token-bucket `rateLimit`).
 */
import {
  createMcpHandler,
  isLegacyRequest,
  Server,
  WebStandardStreamableHTTPServerTransport,
  type CallToolResult,
  type ElicitRequestFormParams,
  type McpHttpHandler,
  type ServerContext,
  type Tool,
} from "@modelcontextprotocol/server"

import {
  ThrottleState,
  throttledEntry,
  throttledResult,
  type FakeRateLimit,
  type FakeThrottle,
} from "./fake-throttle"

export type { FakeRateLimit, FakeThrottle } from "./fake-throttle"

export type FakeToolHandler = (
  args: Record<string, unknown>,
  ctx: ServerContext,
  meta: { progressToken?: string | number },
) => Promise<CallToolResult>

/** A canned answer: a fixed result or one computed from the arguments. */
export type CannedResult =
  | CallToolResult
  | ((args: Record<string, unknown>) => CallToolResult)

export interface RecordedRequest {
  method: string
  path: string
  authorization: string | null
  sessionId: string | null
  /** JSON-RPC method of a POST body (first message). */
  rpc?: string
  /** Tool name of a `tools/call`. */
  tool?: string
  status: number
  /** When the request arrived (the `now` option's clock). */
  at: number
}

export interface FakeOAuthOptions {
  /** Only this client id may authorize (static registration). Default: any id. */
  clientId?: string
  /** Advertise and serve RFC 7591 dynamic registration. */
  registration?: boolean
  /** `scopes_supported` in the protected-resource metadata. */
  scopes?: Array<string>
  /** `expires_in` of issued access tokens (seconds). Default 3600. */
  expiresIn?: number
  /** Claims for an `id_token` (unsigned) in the token response. */
  idTokenClaims?: Record<string, unknown>
  /** Answer the authorize request with this OAuth error instead of a code. */
  denyWith?: string
}

/** What the fake authorization server saw. */
export interface OAuthRecord {
  authorizations: Array<URLSearchParams>
  tokenRequests: Array<URLSearchParams>
  registrations: Array<Record<string, unknown>>
}

export interface FakeRemoteMcpOptions {
  /** Accepted bearer token; `null` accepts unauthenticated requests. Default `token-1`. */
  token?: string | null
  tools?: Array<Tool>
  handlers?: Record<string, FakeToolHandler>
  results?: Record<string, CannedResult>
  /** `legacy` (default): 2025 `initialize` sessions only. `modern`: also 2026-07-28. */
  protocol?: "legacy" | "modern"
  /** Serve protected-resource metadata and a fake authorization server. */
  oauth?: FakeOAuthOptions
  /** `serverInfo.name` (default `fake-remote-mcp`). */
  name?: string
  /** Time source for request timestamps and `rateLimit` (default `Date.now`). */
  now?: () => number
  /** Throttle `tools/call` beyond a token-bucket rate (a bench scenario). */
  rateLimit?: FakeRateLimit
}

/** Failure injected before the MCP layer, consumed in order. */
export interface InjectedFailure {
  status: number
  body?: string
  headers?: Record<string, string>
  /** Only fail requests carrying this JSON-RPC method. */
  rpc?: string
  /** Only fail `tools/call` requests for this tool. */
  tool?: string
}

export interface FakeRemoteMcp {
  /** The MCP endpoint (`…/mcp`). */
  readonly url: string
  /** Origin of the server (also the fake authorization server's issuer). */
  readonly origin: string
  readonly requests: Array<RecordedRequest>
  token: string | null
  tools: Array<Tool>
  handlers: Record<string, FakeToolHandler>
  results: Record<string, CannedResult>
  /** Authorization-server activity (empty without `oauth`). */
  readonly oauth: OAuthRecord
  /** Change the fake authorization server's behaviour. */
  oauthOptions: FakeOAuthOptions | undefined
  fail(failure: InjectedFailure, times?: number): void
  /** Throttle matching requests (HTTP-level or inside the tool result). */
  throttle(throttle?: FakeThrottle): void
  /** Throttled responses sent so far (injected and rate-limited). */
  readonly throttled: number
  /** Replace the tool list and notify every open session. */
  setTools(tools: Array<Tool>): Promise<void>
  /** Forget every legacy session (subsequent calls get 404). */
  expireSessions(): Promise<void>
  readonly sessionCount: number
  calls(): Array<{ name: string; args: Record<string, unknown> }>
  close(): Promise<void>
}

/** A small generic tool list (synthetic). */
export const SAMPLE_TOOLS: Array<Tool> = [
  {
    name: "ask",
    title: "Ask",
    description: "Ask a question about your work data.",
    inputSchema: {
      type: "object",
      properties: { question: { type: "string" } },
      required: ["question"],
    },
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  {
    name: "fetch",
    description: "Fetch entities by path.",
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
    description: "Search the catalog of allowed paths.",
    inputSchema: { type: "object", properties: { query: { type: "string" } } },
  },
]

/** Send a progress notification from a tool handler (no-op when the caller asked for none). */
export async function notifyProgress(
  ctx: ServerContext,
  meta: { progressToken?: string | number },
  update: { progress: number; total?: number; message?: string },
): Promise<void> {
  if (meta.progressToken === undefined) return
  await ctx.mcpReq.notify({
    method: "notifications/progress",
    params: { progressToken: meta.progressToken, ...update },
  })
}

/** Ask the client for input from a tool handler (2025-era push elicitation). */
export async function elicitForm(
  ctx: ServerContext,
  message: string,
  requestedSchema: ElicitRequestFormParams["requestedSchema"],
): Promise<{ action: string; content?: Record<string, unknown> }> {
  // The fake issues a 2025-era push elicitation, which is what a connector relays.
  // eslint-disable-next-line @typescript-eslint/no-deprecated
  return await ctx.mcpReq.elicitInput({
    mode: "form",
    message,
    requestedSchema,
  })
}

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

/** Tool name of a `tools/call` body. */
function toolName(body: unknown): string | undefined {
  const first: unknown = Array.isArray(body) ? (body[0] as unknown) : body
  if (first === null || typeof first !== "object") return undefined
  const params = (first as { params?: { name?: unknown } }).params
  return typeof params?.name === "string" ? params.name : undefined
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
  token: string | null
  tools: Array<Tool>
  handlers: Record<string, FakeToolHandler>
  results: Record<string, CannedResult>
  oauth: FakeOAuthOptions | undefined
}

interface FakeContext {
  name: string
  state: FakeState
  now: () => number
  requests: Array<RecordedRequest>
  failures: Array<InjectedFailure>
  throttles: ThrottleState
  sessions: Map<string, Session>
  callLog: Array<{ name: string; args: Record<string, unknown> }>
  modern: McpHttpHandler | undefined
  origin: string
  oauth: OAuthRecord
  codes: Map<
    string,
    { challenge: string; clientId: string; resource: string | null }
  >
  refreshTokens: Set<string>
}

function buildServer(fake: FakeContext): LowLevelServer {
  const { state, callLog } = fake
  // eslint-disable-next-line @typescript-eslint/no-deprecated -- see LowLevelServer
  const server = new Server(
    { name: fake.name, version: "1.0.0" },
    { capabilities: { tools: { listChanged: true } } },
  )
  server.setRequestHandler("tools/list", () => ({ tools: state.tools }))
  server.setRequestHandler("tools/call", async (request, ctx) => {
    const name = request.params.name
    const args = (request.params.arguments ?? {}) as Record<string, unknown>
    callLog.push({ name, args })
    const answer = async (): Promise<CallToolResult> => {
      const handler = lookup(state.handlers, name)
      if (handler) {
        const progressToken = request.params._meta?.progressToken
        return await handler(
          args,
          ctx,
          progressToken === undefined ? {} : { progressToken },
        )
      }
      const canned = lookup(state.results, name)
      if (canned) return typeof canned === "function" ? canned(args) : canned
      return {
        content: [{ type: "text", text: `${name}:${JSON.stringify(args)}` }],
      }
    }
    const throttle = fake.throttles.take("result", { tool: name, args })
    return throttle ?
        await throttledResult(throttle, args, answer)
      : await answer()
  })
  return server
}

function createSession(
  fake: FakeContext,
): WebStandardStreamableHTTPServerTransport {
  const server = buildServer(fake)
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: () => crypto.randomUUID(),
    onsessioninitialized: (id) => {
      fake.sessions.set(id, { server, transport })
    },
    onsessionclosed: (id) => {
      fake.sessions.delete(id)
    },
  })
  void server.connect(transport)
  return transport
}

const json = (
  body: unknown,
  status = 200,
  headers: Record<string, string> = {},
) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  })

function sessionNotFound(): Response {
  return json(
    {
      jsonrpc: "2.0",
      error: { code: -32001, message: "Session not found" },
      id: null,
    },
    404,
  )
}

const b64url = (value: string) => Buffer.from(value).toString("base64url")

async function s256(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(verifier),
  )
  return Buffer.from(digest).toString("base64url")
}

function issueTokens(fake: FakeContext, options: FakeOAuthOptions) {
  const refresh = `refresh-${crypto.randomUUID()}`
  fake.refreshTokens.add(refresh)
  return {
    access_token: fake.state.token ?? "anonymous",
    token_type: "Bearer",
    expires_in: options.expiresIn ?? 3600,
    refresh_token: refresh,
    ...(options.idTokenClaims ?
      {
        id_token: `${b64url(JSON.stringify({ alg: "none" }))}.${b64url(JSON.stringify(options.idTokenClaims))}.`,
      }
    : {}),
  }
}

/** RFC 9728 protected-resource metadata. */
function protectedResource(
  fake: FakeContext,
  options: FakeOAuthOptions,
): Response {
  return json({
    resource: `${fake.origin}/mcp`,
    authorization_servers: [fake.origin],
    ...(options.scopes ? { scopes_supported: options.scopes } : {}),
    bearer_methods_supported: ["header"],
  })
}

/** RFC 8414 authorization-server metadata. */
function serverMetadata(
  fake: FakeContext,
  options: FakeOAuthOptions,
): Response {
  const issuer = fake.origin
  return json({
    issuer,
    authorization_endpoint: `${issuer}/authorize`,
    token_endpoint: `${issuer}/token`,
    ...(options.registration ?
      { registration_endpoint: `${issuer}/register` }
    : {}),
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none"],
  })
}

/** Why the authorize request is refused, if it is. */
function authorizeError(
  params: URLSearchParams,
  options: FakeOAuthOptions,
): string | undefined {
  if (options.denyWith) return options.denyWith
  const clientId = params.get("client_id") ?? ""
  const known =
    options.clientId === undefined ?
      clientId !== ""
    : clientId === options.clientId
  if (!known) return "unauthorized_client"
  if (params.get("code_challenge_method") !== "S256") return "invalid_request"
  return undefined
}

/** Auto-approve: redirect straight back with a code bound to the PKCE challenge and resource. */
function authorize(
  fake: FakeContext,
  options: FakeOAuthOptions,
  url: URL,
): Response {
  const params = url.searchParams
  fake.oauth.authorizations.push(params)
  const redirect = new URL(params.get("redirect_uri") ?? "")
  const state = params.get("state")
  if (state) redirect.searchParams.set("state", state)
  const error = authorizeError(params, options)
  if (error) redirect.searchParams.set("error", error)
  else {
    const code = `code-${crypto.randomUUID()}`
    fake.codes.set(code, {
      challenge: params.get("code_challenge") ?? "",
      clientId: params.get("client_id") ?? "",
      resource: params.get("resource"),
    })
    redirect.searchParams.set("code", code)
  }
  return new Response(null, {
    status: 302,
    headers: { location: redirect.href },
  })
}

const invalidGrant = (description: string) =>
  json({ error: "invalid_grant", error_description: description }, 400)

async function codeGrant(
  fake: FakeContext,
  options: FakeOAuthOptions,
  form: URLSearchParams,
): Promise<Response> {
  const key = form.get("code") ?? ""
  const code = fake.codes.get(key)
  if (!code) return invalidGrant("unknown code")
  fake.codes.delete(key)
  if ((await s256(form.get("code_verifier") ?? "")) !== code.challenge)
    return invalidGrant("PKCE verification failed")
  if (code.resource !== form.get("resource"))
    return invalidGrant("resource mismatch")
  return json(issueTokens(fake, options))
}

async function token(
  fake: FakeContext,
  options: FakeOAuthOptions,
  request: Request,
): Promise<Response> {
  const form = new URLSearchParams(await request.text())
  fake.oauth.tokenRequests.push(form)
  switch (form.get("grant_type")) {
    case "authorization_code": {
      return await codeGrant(fake, options, form)
    }
    case "refresh_token": {
      if (!fake.refreshTokens.delete(form.get("refresh_token") ?? ""))
        return invalidGrant("unknown refresh token")
      return json(issueTokens(fake, options))
    }
    default: {
      return json({ error: "unsupported_grant_type" }, 400)
    }
  }
}

async function register(
  fake: FakeContext,
  options: FakeOAuthOptions,
  request: Request,
): Promise<Response> {
  if (!options.registration) return json({ error: "not_found" }, 404)
  const body = (await request.json()) as Record<string, unknown>
  fake.oauth.registrations.push(body)
  return json(
    {
      ...body,
      client_id: `dcr-${fake.oauth.registrations.length}`,
      client_id_issued_at: Math.floor(Date.now() / 1000),
    },
    201,
  )
}

/** The fake authorization server and protected-resource metadata, or `undefined` when the path is not theirs. */
async function handleOAuth(
  fake: FakeContext,
  request: Request,
  url: URL,
): Promise<Response | undefined> {
  const options = fake.state.oauth
  if (!options) return undefined
  switch (url.pathname) {
    case "/.well-known/oauth-protected-resource/mcp":
    case "/.well-known/oauth-protected-resource": {
      return protectedResource(fake, options)
    }
    case "/.well-known/oauth-authorization-server": {
      return serverMetadata(fake, options)
    }
    case "/authorize": {
      return authorize(fake, options, url)
    }
    case "/token": {
      return await token(fake, options, request)
    }
    case "/register": {
      return await register(fake, options, request)
    }
    default: {
      return undefined
    }
  }
}

/** One MCP request as the fake sees it. */
interface McpExchange {
  request: Request
  body: unknown
  rpc: string | undefined
  tool: string | undefined
  sessionId: string | null
  record(status: number): void
}

/** An HTTP-level throttle for this request (`throttle()` or `rateLimit`), if any. */
function httpThrottle(
  fake: FakeContext,
  exchange: McpExchange,
): Response | undefined {
  if (exchange.request.method !== "POST") return undefined
  const spec = fake.throttles.take("http", {
    rpc: exchange.rpc,
    tool: exchange.tool,
  })
  if (!spec) return undefined
  const status = spec.status ?? 429
  exchange.record(status)
  const entry = throttledEntry(status, undefined)
  return json(
    { error: entry.error },
    status,
    spec.retryAfter ? { "retry-after": spec.retryAfter } : {},
  )
}

/** A queued failure for this request, if any. */
function injectedFailure(
  fake: FakeContext,
  exchange: McpExchange,
): Response | undefined {
  if (exchange.request.method !== "POST") return undefined
  const index = fake.failures.findIndex(
    (failure) =>
      (!failure.rpc || failure.rpc === exchange.rpc)
      && (!failure.tool || failure.tool === exchange.tool),
  )
  const failure = index === -1 ? undefined : fake.failures.splice(index, 1)[0]
  if (!failure) return undefined
  exchange.record(failure.status)
  return new Response(failure.body ?? "", {
    status: failure.status,
    headers: failure.headers ?? {},
  })
}

/** 401 unless the request carries the accepted bearer token. */
function unauthorized(
  fake: FakeContext,
  exchange: McpExchange,
): Response | undefined {
  const { token: accepted, oauth } = fake.state
  if (
    accepted === null
    || exchange.request.headers.get("authorization") === `Bearer ${accepted}`
  )
    return undefined
  exchange.record(401)
  const metadata =
    oauth ?
      `, resource_metadata="${fake.origin}/.well-known/oauth-protected-resource/mcp"`
    : ""
  return json({ error: "invalid_token" }, 401, {
    "www-authenticate": `Bearer error="invalid_token"${metadata}`,
  })
}

/** 2025-era sessionful serving. */
async function serveLegacy(
  fake: FakeContext,
  exchange: McpExchange,
): Promise<Response> {
  const { sessionId, rpc, body } = exchange
  let transport: WebStandardStreamableHTTPServerTransport | undefined
  if (sessionId) {
    transport = fake.sessions.get(sessionId)?.transport
    if (!transport) {
      exchange.record(404)
      return sessionNotFound()
    }
  } else if (rpc === "initialize") {
    transport = createSession(fake)
  } else {
    exchange.record(400)
    return new Response("missing session", { status: 400 })
  }
  const response = await transport.handleRequest(
    exchange.request,
    body === undefined ? undefined : { parsedBody: body },
  )
  exchange.record(response.status)
  return response
}

async function handleMcp(
  fake: FakeContext,
  exchange: McpExchange,
): Promise<Response> {
  const refused =
    injectedFailure(fake, exchange)
    ?? unauthorized(fake, exchange)
    ?? httpThrottle(fake, exchange)
  if (refused) return refused
  const { request, body } = exchange
  if (
    fake.modern
    && !exchange.sessionId
    && !(await isLegacyRequest(request, body))
  ) {
    const response = await fake.modern.fetch(
      request,
      body === undefined ? undefined : { parsedBody: body },
    )
    exchange.record(response.status)
    return response
  }
  return await serveLegacy(fake, exchange)
}

async function handleRequest(
  fake: FakeContext,
  request: Request,
): Promise<Response> {
  const url = new URL(request.url)
  const oauth = await handleOAuth(fake, request, url)
  if (oauth) return oauth
  let body: unknown
  if (request.method === "POST")
    body = await request
      .clone()
      .json()
      .catch(() => undefined)
  const rpc = rpcMethod(body)
  const tool = rpc === "tools/call" ? toolName(body) : undefined
  const sessionId = request.headers.get("mcp-session-id")
  const at = fake.now()
  const record = (status: number) => {
    fake.requests.push({
      method: request.method,
      path: url.pathname,
      authorization: request.headers.get("authorization"),
      sessionId,
      ...(rpc ? { rpc } : {}),
      ...(tool ? { tool } : {}),
      status,
      at,
    })
  }
  if (url.pathname !== "/mcp") {
    record(404)
    return new Response("not found", { status: 404 })
  }
  return await handleMcp(fake, {
    request,
    body,
    rpc,
    tool,
    sessionId,
    record,
  })
}

async function closeAll(open: Array<Session>): Promise<void> {
  await Promise.all(open.map(({ server }) => server.close().catch(() => {})))
}

/** The test-facing controls over a running fake. */
function controls(
  fake: FakeContext,
  stopHttp: () => Promise<void>,
): Omit<FakeRemoteMcp, "url" | "origin" | "requests" | "oauth"> {
  const { state, sessions } = fake
  return {
    get token() {
      return state.token
    },
    set token(value: string | null) {
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
    get results() {
      return state.results
    },
    set results(value: Record<string, CannedResult>) {
      state.results = value
    },
    get oauthOptions() {
      return state.oauth
    },
    set oauthOptions(value: FakeOAuthOptions | undefined) {
      state.oauth = value
    },
    get sessionCount() {
      return sessions.size
    },
    fail(failure, times = 1) {
      for (let i = 0; i < times; i++) fake.failures.push(failure)
    },
    throttle(throttle = {}) {
      fake.throttles.add(throttle)
    },
    get throttled() {
      return fake.throttles.count
    },
    async setTools(tools) {
      state.tools = tools
      fake.modern?.notify.toolsChanged()
      await Promise.all(
        [...sessions.values()].map(({ server }) =>
          server.sendToolListChanged().catch(() => {}),
        ),
      )
    },
    async expireSessions() {
      const open = [...sessions.values()]
      sessions.clear()
      await closeAll(open)
    },
    calls: () => [...fake.callLog],
    async close() {
      const open = [...sessions.values()]
      sessions.clear()
      await closeAll(open)
      await fake.modern?.close()
      await stopHttp()
    },
  }
}

/** Start a fake remote MCP server on 127.0.0.1 (random port). */
export function startFakeRemoteMcp(
  options: FakeRemoteMcpOptions = {},
): FakeRemoteMcp {
  const now = options.now ?? (() => Date.now())
  const fake: FakeContext = {
    name: options.name ?? "fake-remote-mcp",
    state: {
      token: options.token === undefined ? "token-1" : options.token,
      tools: options.tools ?? SAMPLE_TOOLS,
      handlers: options.handlers ?? {},
      results: options.results ?? {},
      oauth: options.oauth,
    },
    now,
    requests: [],
    failures: [],
    throttles: new ThrottleState(now, options.rateLimit),
    sessions: new Map(),
    callLog: [],
    modern: undefined,
    origin: "",
    oauth: { authorizations: [], tokenRequests: [], registrations: [] },
    codes: new Map(),
    refreshTokens: new Set(),
  }
  if (options.protocol === "modern")
    fake.modern = createMcpHandler(() => buildServer(fake), {
      legacy: "reject",
    })
  const http = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    idleTimeout: 0,
    fetch: (request) => handleRequest(fake, request),
  })
  fake.origin = `http://127.0.0.1:${http.port}`
  const facade = controls(fake, () => http.stop(true))
  return Object.defineProperties(facade, {
    url: { value: `${fake.origin}/mcp`, enumerable: true },
    origin: { value: fake.origin, enumerable: true },
    requests: { value: fake.requests, enumerable: true },
    oauth: { value: fake.oauth, enumerable: true },
  }) as FakeRemoteMcp
}
