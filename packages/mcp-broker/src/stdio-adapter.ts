import {
  Client,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client"
import { Server } from "@modelcontextprotocol/server"
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio"
import { proxyServer, resolveVersionNegotiation } from "mcp-proxy"
import { setTimeout as delay } from "node:timers/promises"

import {
  RECONNECT_WINDOW_MS,
  ResumableTransport,
  retryWhileUnreachable,
} from "./resumable-transport.ts"

export const ADAPTER_API_KEY_ENV = "MAXIMAL_MCP_API_KEY"

const LOOPBACK_HOSTNAMES = new Set(["127.0.0.1", "localhost", "[::1]"])

export interface StdioAdapterOptions {
  url: string
}

/** Accept only plain-HTTP loopback URLs without embedded credentials. */
export const parseAdapterUrl = (value: string): URL => {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new Error("ADAPTER_ENDPOINT_INVALID")
  }
  if (
    url.protocol !== "http:"
    || !LOOPBACK_HOSTNAMES.has(url.hostname)
    || url.username !== ""
    || url.password !== ""
    || !/^\/mcp\/[a-z0-9]+(?:[._-][a-z0-9]+)*$/u.test(url.pathname)
  ) {
    throw new Error("ADAPTER_ENDPOINT_INVALID")
  }
  return url
}

/** Upper bound on the DELETE, so an unreachable Maximal can't hold up exit. */
const END_SESSION_TIMEOUT_MS = 2_000
/** How long an adapter that couldn't connect reads stdin for requests to
 *  answer with the reason, before it exits. */
const ANSWER_FAILURE_WAIT_MS = 1_000

/** Why connecting failed, for the client: the HTTP status, or the code. */
const failureReason = (error: unknown): string => {
  for (
    let cause: unknown = error, depth = 0;
    cause && depth < 8;
    cause = (cause as { cause?: unknown }).cause, depth += 1
  ) {
    const status = (cause as { status?: unknown }).status
    if (typeof status === "number") return `HTTP ${status}`
  }
  return error instanceof Error ? error.message.slice(0, 200) : String(error)
}

/**
 * Answer each request the client has sent (usually its `initialize`) with a
 * JSON-RPC error that says why, so the client shows a reason rather than a
 * server that closed without a word. Reads stdin for a moment, then stops.
 */
export const answerPendingRequests = async (message: string): Promise<void> => {
  let buffered = ""
  const onData = (chunk: Buffer | string) => {
    buffered += chunk.toString()
    for (
      let end = buffered.indexOf("\n");
      end !== -1;
      end = buffered.indexOf("\n")
    ) {
      const line = buffered.slice(0, end).trim()
      buffered = buffered.slice(end + 1)
      let parsed: { id?: unknown; method?: unknown }
      try {
        parsed = JSON.parse(line) as { id?: unknown; method?: unknown }
      } catch {
        continue
      }
      const { id, method } = parsed
      if (
        typeof method === "string"
        && (typeof id === "string" || typeof id === "number")
      ) {
        process.stdout.write(
          `${JSON.stringify({ jsonrpc: "2.0", id, error: { code: -32_000, message } })}\n`,
        )
      }
    }
  }
  process.stdin.on("data", onData)
  await delay(ANSWER_FAILURE_WAIT_MS)
  process.stdin.off("data", onData)
  process.stdin.pause()
  await new Promise<void>((resolve) => {
    process.stdout.write("", () => resolve())
  })
}

const ADAPTER_IDENTITY = { name: "maximal-mcp-broker", version: "0.0.0" }

/**
 * Bridge one stdio client to one broker session. mcp-proxy's
 * `startStdioServer` does the same but never ends its HTTP session. Idle
 * reaping can't recover it either: the session's event stream counts as open,
 * and under Bun the broker never sees that stream's client go away. So every
 * adapter a client discarded kept a server instance, and a slot toward the
 * endpoint's session limit, until the broker restarted. Holding the transport
 * here lets shutdown DELETE the session first.
 *
 * Claude Desktop starts its MCP servers only when it launches, so an adapter
 * that exits is gone until Desktop restarts. It therefore keeps trying while
 * Maximal isn't up yet or its broker is still starting (connection refused,
 * 502/503) for up to RECONNECT_WINDOW_MS, and starts a new session when the
 * broker restarted under it (see ResumableTransport).
 */
export const runStdioAdapter = async (
  options: StdioAdapterOptions,
): Promise<void> => {
  const url = parseAdapterUrl(options.url)
  const apiKey = process.env[ADAPTER_API_KEY_ENV]?.trim()
  const openTransport = () =>
    new StreamableHTTPClientTransport(url, {
      requestInit: {
        headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
      },
    })
  let connected: { client: Client; transport: ResumableTransport }
  try {
    connected = await retryWhileUnreachable(async () => {
      const attempt = new ResumableTransport(openTransport)
      const candidate = new Client(ADAPTER_IDENTITY, {
        capabilities: {},
        versionNegotiation: resolveVersionNegotiation("auto"),
      })
      try {
        await candidate.connect(attempt)
      } catch (error) {
        await candidate.close().catch(() => undefined)
        throw error
      }
      return { client: candidate, transport: attempt }
    }, Date.now() + RECONNECT_WINDOW_MS)
  } catch (error) {
    await answerPendingRequests(
      `Maximal's MCP endpoint ${url.pathname} isn't available (${failureReason(error)}). Check that Maximal is running and that this server is on in Maximal's Settings.`,
    )
    throw error
  }
  const { client, transport } = connected

  let ending: Promise<void> | undefined
  const endSession = (): Promise<void> => {
    ending ??= Promise.race([
      transport.terminateSession().catch(() => undefined),
      delay(END_SESSION_TIMEOUT_MS, undefined, { ref: false }),
    ]).then(() => client.close().catch(() => undefined))
    return ending
  }

  let server: Server
  try {
    const serverCapabilities = client.getServerCapabilities() ?? {}
    server = new Server(client.getServerVersion() ?? ADAPTER_IDENTITY, {
      capabilities: serverCapabilities,
    })
    await proxyServer({ client, server, serverCapabilities })
    // Fires when the client closes stdin, which is how most clients stop a
    // stdio server.
    const previousOnClose = server.onclose
    server.onclose = () => {
      previousOnClose?.()
      void endSession()
    }
    await server.connect(new StdioServerTransport())
  } catch (error) {
    await endSession()
    throw error
  }

  const stop = () => {
    void endSession().finally(() => server.close())
  }
  process.once("SIGHUP", stop)
  process.once("SIGINT", stop)
  process.once("SIGTERM", stop)
}
