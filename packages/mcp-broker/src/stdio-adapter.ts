import { ServerType, startStdioServer } from "mcp-proxy"

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

export const runStdioAdapter = async (
  options: StdioAdapterOptions,
): Promise<void> => {
  const url = parseAdapterUrl(options.url)
  const apiKey = process.env[ADAPTER_API_KEY_ENV]?.trim()
  const server = await startStdioServer({
    serverType: ServerType.HTTPStream,
    transportOptions: {
      requestInit: {
        headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
      },
    },
    upstreamProtocol: "auto",
    url: url.href,
  })

  const close = () => {
    void server.close()
  }
  process.once("SIGINT", close)
  process.once("SIGTERM", close)
}
