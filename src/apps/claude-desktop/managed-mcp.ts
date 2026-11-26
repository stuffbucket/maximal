const SERVER_NAME = "maximal"
const TRANSPORT = "http"
const AUTHORIZATION = "Authorization"

export interface ClaudeDesktopManagedMcpServer {
  name: typeof SERVER_NAME
  transport: typeof TRANSPORT
  url: string
  headers: { Authorization: string }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function isAggregateUrl(value: unknown): boolean {
  if (typeof value !== "string") return false
  let url: URL
  try {
    url = new URL(value)
  } catch {
    return false
  }
  return (
    url.protocol === "http:"
    && url.hostname === "127.0.0.1"
    && url.username === ""
    && url.password === ""
    && url.pathname === "/mcp"
    && url.search === ""
    && url.hash === ""
  )
}

/** The one remote MCP entry Maximal owns in a Claude Desktop profile. */
export function isMaximalDesktopManagedMcpServer(
  value: unknown,
): value is ClaudeDesktopManagedMcpServer {
  if (!isRecord(value)) return false
  const { name, transport, url, headers } = value
  if (
    name !== SERVER_NAME
    || transport !== TRANSPORT
    || !isAggregateUrl(url)
    || !isRecord(headers)
    || Object.keys(headers).length !== 1
  ) {
    return false
  }
  const authorization = headers[AUTHORIZATION]
  return (
    Object.keys(value).length === 4
    && typeof authorization === "string"
    && authorization.startsWith("Bearer ")
    && authorization.length > "Bearer ".length
  )
}

/** The whole managed MCP field Maximal writes: absent/empty, or its one entry. */
export function isMaximalDesktopManagedMcpServers(
  value: unknown,
): value is Array<ClaudeDesktopManagedMcpServer> {
  return (
    Array.isArray(value)
    && (value.length === 0
      || (value.length === 1 && isMaximalDesktopManagedMcpServer(value[0])))
  )
}

/** Preserve the configurator-owned field when routing rewrites its profile. */
export function withMaximalDesktopManagedMcpServers(
  values: object,
  current: unknown,
): Record<string, unknown> {
  return isMaximalDesktopManagedMcpServers(current) ?
      { ...values, managedMcpServers: current }
    : { ...values }
}

export function maximalDesktopManagedMcpServer(
  url: string,
  apiKey: string,
): ClaudeDesktopManagedMcpServer {
  return {
    name: SERVER_NAME,
    transport: TRANSPORT,
    url,
    // eslint-disable-next-line no-restricted-syntax -- Desktop's managed MCP schema requires this client credential header.
    headers: { Authorization: `Bearer ${apiKey}` },
  }
}
