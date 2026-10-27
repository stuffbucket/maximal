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
  const { client, transport } = await retryWhileUnreachable(async () => {
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
