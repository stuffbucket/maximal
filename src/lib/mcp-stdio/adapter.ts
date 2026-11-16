import type { Readable, Writable } from "node:stream"

/* eslint-disable unicorn/prefer-add-event-listener -- MCP Transport exposes callback properties, not EventTarget. */
import {
  isInitializeRequest,
  isJSONRPCRequest,
  isJSONRPCResponse,
  StreamableHTTPClientTransport,
  type JSONRPCMessage,
} from "@modelcontextprotocol/client"
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio"
import { setTimeout as delay } from "node:timers/promises"

import {
  MCP_STDIO_API_KEY_ENV,
  MCP_STDIO_URL_FLAG,
} from "~/lib/mcp-stdio/command"
import {
  DEFAULT_RECONNECT_WINDOW_MS,
  ResumableTransport,
} from "~/lib/mcp-stdio/resumable-transport"

const LOOPBACK_HOSTNAMES = new Set(["127.0.0.1", "localhost", "[::1]"])
const END_SESSION_TIMEOUT_MS = 2_000
const MAX_MESSAGE_BYTES = 1_048_576

export interface McpStdioAdapterOptions {
  readonly url: URL
  readonly apiKey?: string
  readonly stdin?: Readable
  readonly stdout?: Writable
  readonly stderr?: Writable
  readonly fetch?: typeof fetch
  readonly retryWindowMs?: number
}

/** Accept only Maximal's aggregate MCP endpoint on plain-HTTP loopback. */
export function parseAdapterUrl(value: string): URL {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new Error("MCP adapter URL is invalid")
  }
  if (
    url.protocol !== "http:"
    || !LOOPBACK_HOSTNAMES.has(url.hostname)
    || url.username !== ""
    || url.password !== ""
    || url.pathname !== "/mcp"
    || url.search !== ""
    || url.hash !== ""
  ) {
    throw new Error(
      "MCP adapter URL must be the loopback aggregate endpoint http://127.0.0.1:<port>/mcp",
    )
  }
  return url
}

function errorProperty(
  value: unknown,
  key: "status" | "code" | "cause",
): unknown {
  return typeof value === "object" && value !== null ?
      (value as Record<string, unknown>)[key]
    : undefined
}

function errorStatus(error: unknown): number | undefined {
  let current = error
  for (let depth = 0; current !== undefined && depth < 8; depth += 1) {
    const status = errorProperty(current, "status")
    if (typeof status === "number") return status
    current = errorProperty(current, "cause")
  }
  return undefined
}

function safeFailureReason(error: unknown): string {
  const status = errorStatus(error)
  if (status !== undefined) return `HTTP ${status}`
  let current = error
  for (let depth = 0; current !== undefined && depth < 8; depth += 1) {
    const code = errorProperty(current, "code")
    if (typeof code === "string" && /^[A-Z][A-Z_]+$/u.test(code)) return code
    current = errorProperty(current, "cause")
  }
  return "transport error"
}

function initializeProtocolVersion(
  message: JSONRPCMessage,
  initializeId: string | number | undefined,
): string | undefined {
  if (
    initializeId === undefined
    || !isJSONRPCResponse(message)
    || message.id !== initializeId
    || !("result" in message)
  ) {
    return undefined
  }
  const result = message.result
  if (typeof result !== "object") return undefined
  const version = (result as { protocolVersion?: unknown }).protocolVersion
  return typeof version === "string" ? version : undefined
}

function jsonRpcFailure(
  message: JSONRPCMessage,
  error: unknown,
): JSONRPCMessage | undefined {
  if (!isJSONRPCRequest(message)) return undefined
  return {
    jsonrpc: "2.0",
    id: message.id,
    error: {
      code: -32_000,
      message:
        `Maximal's MCP endpoint isn't available (${safeFailureReason(error)}). `
        + "Check that Maximal is running.",
    },
  }
}

/**
 * Bridge one MCP stdio peer to one Streamable HTTP session. The bridge is
 * transport-aware but tool-agnostic: every JSON-RPC message, including
 * progress and elicitation, passes through unchanged.
 */
export async function runMcpStdioAdapter(
  options: McpStdioAdapterOptions,
): Promise<number> {
  const stdin = options.stdin ?? process.stdin
  const stdout = options.stdout ?? process.stdout
  const stderr = options.stderr ?? process.stderr
  const key = options.apiKey?.trim()
  const openTransport = () =>
    new StreamableHTTPClientTransport(options.url, {
      requestInit: {
        // eslint-disable-next-line no-restricted-syntax -- transport credential for the local MCP client, not an upstream provider request
        headers: key ? { Authorization: `Bearer ${key}` } : {},
        redirect: "error",
      },
      ...(options.fetch ? { fetch: options.fetch } : {}),
    })
  const http = new ResumableTransport(
    openTransport,
    options.retryWindowMs ?? DEFAULT_RECONNECT_WINDOW_MS,
  )
  const stdio = new StdioServerTransport(stdin, stdout, {
    maxBufferSize: MAX_MESSAGE_BYTES,
  })

  let initializeId: string | number | undefined
  let ending: Promise<void> | undefined
  const { promise: exited, resolve: resolveExit } =
    Promise.withResolvers<number>()

  const shutdown = (code: number): Promise<void> => {
    ending ??= Promise.race([
      http.sessionId ?
        http.terminateSession().catch(() => undefined)
      : undefined,
      delay(END_SESSION_TIMEOUT_MS, undefined, { ref: false }),
    ])
      .then(async () => {
        await http.close().catch(() => undefined)
        await stdio.close().catch(() => undefined)
      })
      .finally(() => resolveExit(code))
    return ending
  }

  http.onmessage = (message) => {
    const version = initializeProtocolVersion(message, initializeId)
    if (version) http.setProtocolVersion(version)
    void stdio.send(message).catch((error: unknown) => {
      stderr.write(
        `Maximal MCP stdio write failed (${safeFailureReason(error)}).\n`,
      )
      void shutdown(1)
    })
  }
  http.onerror = (error) => {
    stderr.write(
      `Maximal MCP HTTP transport error (${safeFailureReason(error)}).\n`,
    )
  }
  http.onclose = () => {
    if (!ending) void shutdown(1)
  }
  stdio.onerror = (error) => {
    stderr.write(
      `Maximal MCP stdio transport error (${safeFailureReason(error)}).\n`,
    )
    void shutdown(1)
  }
  stdio.onclose = () => {
    void shutdown(0)
  }
  stdio.onmessage = (message) => {
    if (isJSONRPCRequest(message) && isInitializeRequest(message)) {
      initializeId = message.id
    }
    void http.send(message).catch(async (error: unknown) => {
      const failure = jsonRpcFailure(message, error)
      if (failure) await stdio.send(failure).catch(() => undefined)
      stderr.write(
        `Maximal MCP request failed (${safeFailureReason(error)}).\n`,
      )
      await shutdown(1)
    })
  }

  const stop = () => {
    void shutdown(0)
  }
  process.once("SIGHUP", stop)
  process.once("SIGINT", stop)
  process.once("SIGTERM", stop)
  try {
    await http.start()
    await stdio.start()
    return await exited
  } finally {
    process.off("SIGHUP", stop)
    process.off("SIGINT", stop)
    process.off("SIGTERM", stop)
  }
}

export function adapterUrlFromArgv(argv: ReadonlyArray<string>): URL {
  if (argv.length !== 2 || argv[0] !== MCP_STDIO_URL_FLAG || !argv[1]) {
    throw new Error(
      "Usage: maximal mcp stdio --url http://127.0.0.1:<port>/mcp",
    )
  }
  return parseAdapterUrl(argv[1])
}

export async function runMcpStdioFromArgv(
  argv: ReadonlyArray<string>,
  env: NodeJS.ProcessEnv = process.env,
): Promise<number> {
  let url: URL
  try {
    url = adapterUrlFromArgv(argv)
  } catch (error) {
    process.stderr.write(
      `${error instanceof Error ? error.message : String(error)}\n`,
    )
    return 2
  }
  return runMcpStdioAdapter({
    url,
    apiKey: env[MCP_STDIO_API_KEY_ENV],
  })
}
