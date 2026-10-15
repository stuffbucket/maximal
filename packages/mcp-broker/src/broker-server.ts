import { Client, type ClientOptions } from "@modelcontextprotocol/client"
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio"
import { Server } from "@modelcontextprotocol/server"
import {
  proxyServer,
  resolveVersionNegotiation,
  startHTTPServer,
} from "mcp-proxy"
import { timingSafeEqual } from "node:crypto"
import http from "node:http"

import type {
  BrokerWireConfiguration,
  ResolvedMcpEndpoint,
} from "./wire-config.ts"

const EXTERNAL_HOST = "127.0.0.1"
const INTERNAL_PATH = "/mcp"
const EXTERNAL_PATH_PREFIX = "/mcp/"

const HOP_BY_HOP_HEADERS = new Set([
  "access-control-allow-credentials",
  "access-control-allow-headers",
  "access-control-allow-methods",
  "access-control-allow-origin",
  "access-control-expose-headers",
  "access-control-max-age",
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
])

export type BrokerStartupErrorCode =
  | "BROKER_AUTH_INVALID"
  | "BROKER_BIND_FAILED"
  | "ENDPOINT_CONNECT_FAILED"
  | "ENDPOINT_SHARING_DISABLED"

export class BrokerStartupError extends Error {
  readonly code: BrokerStartupErrorCode

  constructor(code: BrokerStartupErrorCode, options?: ErrorOptions) {
    super(code, options)
    this.name = "BrokerStartupError"
    this.code = code
  }
}

const sanitizeIdentity = (
  value: string | undefined,
  fallback: string,
): string =>
  (value ?? fallback).replaceAll(/[\u0000-\u001f\u007f]/gu, "�").slice(0, 256)

export interface EndpointObservation {
  id: string
  serverName: string
  serverVersion: string
  negotiatedProtocol?: string
  protocolEra?: "legacy" | "modern"
  ownership: "exclusive"
  capabilities: {
    completions: boolean
    logging: boolean
    prompts: boolean
    resources: boolean
    tools: boolean
  }
}

interface RunningEndpoint {
  close(): Promise<void>
  id: string
  internalPort: number
  observation: EndpointObservation
}

export interface RunningBrokerServer {
  close(): Promise<void>
  endpoints: Array<EndpointObservation>
  host: typeof EXTERNAL_HOST
  port: number
}

const clientOptions = (endpoint: ResolvedMcpEndpoint): ClientOptions => ({
  capabilities: {},
  versionNegotiation: resolveVersionNegotiation(endpoint.protocol),
})

const startEndpoint = async (
  endpoint: ResolvedMcpEndpoint,
  apiKey: string,
  maxBodyBytes: number,
): Promise<RunningEndpoint> => {
  if (endpoint.ownership === "shareable") {
    throw new BrokerStartupError("ENDPOINT_SHARING_DISABLED")
  }

  const transport = new StdioClientTransport({
    args: endpoint.args,
    command: endpoint.command,
    cwd: endpoint.cwd,
    env: endpoint.environment,
    stderr: "pipe",
  })
  transport.stderr?.on("data", () => undefined)

  const client = new Client(
    { name: "maximal-mcp-broker", version: "0.0.0" },
    clientOptions(endpoint),
  )

  try {
    await client.connect(transport, { timeout: endpoint.initializeTimeoutMs })
  } catch (error) {
    await client.close().catch(() => undefined)
    throw new BrokerStartupError("ENDPOINT_CONNECT_FAILED", { cause: error })
  }

  const serverCapabilities = client.getServerCapabilities() ?? {}
  const serverVersion = client.getServerVersion() ?? {
    name: "anonymous-upstream",
    version: "unknown",
  }
  const protocolEra = client.getProtocolEra()
  let activeServer: Server | undefined

  let httpServer
  try {
    httpServer = await startHTTPServer({
      apiKey,
      createServer: async () => {
        const server = new Server(serverVersion, {
          capabilities: serverCapabilities,
          inputRequired: { legacyShim: false },
          instructions: client.getInstructions(),
        })
        await proxyServer({
          client,
          requestTimeout: endpoint.callTimeoutMs,
          server,
          serverCapabilities,
        })
        return server
      },
      enableJsonResponse: true,
      eventStore: false,
      host: EXTERNAL_HOST,
      maxBodySize: maxBodyBytes,
      modern: protocolEra === "modern",
      onClose: async (server) => {
        if (activeServer === server) {
          activeServer = undefined
        }
      },
      onConnect: async (server) => {
        if (activeServer !== undefined && activeServer !== server) {
          throw new Error("exclusive endpoint already has an owner")
        }
        activeServer = server
      },
      port: 0,
      sseEndpoint: null,
      stateless: false,
      streamEndpoint: INTERNAL_PATH,
    })
  } catch (error) {
    await client.close().catch(() => undefined)
    throw new BrokerStartupError("BROKER_BIND_FAILED", { cause: error })
  }

  let closed = false
  return {
    id: endpoint.id,
    internalPort: httpServer.address.port,
    observation: {
      id: endpoint.id,
      serverName: sanitizeIdentity(serverVersion.name, "anonymous-upstream"),
      serverVersion: sanitizeIdentity(serverVersion.version, "unknown"),
      negotiatedProtocol: client.getNegotiatedProtocolVersion(),
      protocolEra,
      ownership: "exclusive",
      capabilities: {
        completions: serverCapabilities.completions !== undefined,
        logging: serverCapabilities.logging !== undefined,
        prompts: serverCapabilities.prompts !== undefined,
        resources: serverCapabilities.resources !== undefined,
        tools: serverCapabilities.tools !== undefined,
      },
    },
    async close() {
      if (closed) {
        return
      }
      closed = true
      await httpServer.close().catch(() => undefined)
      await client.close().catch(() => undefined)
    },
  }
}

const hasValidAuthorization = (
  authorization: string | undefined,
  apiKey: string,
): boolean => {
  const expected = Buffer.from(`Bearer ${apiKey}`)
  const actual = Buffer.from(authorization ?? "")
  return (
    actual.byteLength === expected.byteLength
    && timingSafeEqual(actual, expected)
  )
}

const copyHeaders = (
  source: http.IncomingHttpHeaders,
): http.OutgoingHttpHeaders => {
  const headers: http.OutgoingHttpHeaders = {}
  for (const [name, value] of Object.entries(source)) {
    if (!HOP_BY_HOP_HEADERS.has(name.toLowerCase()) && value !== undefined) {
      headers[name] = value
    }
  }
  return headers
}

const startFrontDoor = async (
  endpoints: ReadonlyMap<string, RunningEndpoint>,
  apiKey: string,
): Promise<{ close(): Promise<void>; port: number }> => {
  const server = http.createServer((request, response) => {
    if (!hasValidAuthorization(request.headers.authorization, apiKey)) {
      response.writeHead(401, {
        "content-type": "application/json; charset=utf-8",
      })
      response.end('{"error":"unauthorized"}')
      return
    }

    let requestUrl: URL
    try {
      requestUrl = new URL(request.url ?? "", "http://127.0.0.1")
    } catch {
      response.writeHead(400).end()
      return
    }

    if (!requestUrl.pathname.startsWith(EXTERNAL_PATH_PREFIX)) {
      response.writeHead(404).end()
      return
    }

    const endpointId = requestUrl.pathname.slice(EXTERNAL_PATH_PREFIX.length)
    if (endpointId.length === 0 || endpointId.includes("/")) {
      response.writeHead(404).end()
      return
    }

    const endpoint = endpoints.get(endpointId)
    if (!endpoint) {
      response.writeHead(404).end()
      return
    }

    const upstreamHeaders = copyHeaders(request.headers)
    delete upstreamHeaders.authorization
    upstreamHeaders["x-api-key"] = apiKey

    const upstream = http.request({
      headers: upstreamHeaders,
      host: EXTERNAL_HOST,
      method: request.method,
      path: `${INTERNAL_PATH}${requestUrl.search}`,
      port: endpoint.internalPort,
    })

    upstream.on("response", (upstreamResponse) => {
      response.writeHead(
        upstreamResponse.statusCode ?? 502,
        copyHeaders(upstreamResponse.headers),
      )
      upstreamResponse.pipe(response)
    })
    upstream.on("error", () => {
      if (!response.headersSent) {
        response.writeHead(502).end()
      } else {
        response.destroy()
      }
    })
    request.on("aborted", () => upstream.destroy())
    request.pipe(upstream)
  })

  server.headersTimeout = 10_000
  server.keepAliveTimeout = 5_000
  server.maxConnections = 128
  server.maxHeadersCount = 64
  server.maxRequestsPerSocket = 1_000
  server.requestTimeout = 30_000

  try {
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error) => {
        server.off("listening", onListening)
        reject(error)
      }
      const onListening = () => {
        server.off("error", onError)
        resolve()
      }
      server.once("error", onError)
      server.once("listening", onListening)
      server.listen(0, EXTERNAL_HOST)
    })
  } catch (error) {
    throw new BrokerStartupError("BROKER_BIND_FAILED", { cause: error })
  }

  const address = server.address()
  if (!address || typeof address === "string") {
    await new Promise<void>((resolve) => server.close(() => resolve()))
    throw new BrokerStartupError("BROKER_BIND_FAILED")
  }

  return {
    port: address.port,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve())
        server.closeIdleConnections()
        server.closeAllConnections()
      }),
  }
}

export const startBrokerServer = async (
  configuration: BrokerWireConfiguration,
  apiKey: string,
): Promise<RunningBrokerServer> => {
  if (apiKey.length < 32) {
    throw new BrokerStartupError("BROKER_AUTH_INVALID")
  }

  const endpoints = new Map<string, RunningEndpoint>()

  try {
    for (const endpointConfiguration of configuration.endpoints) {
      const endpoint = await startEndpoint(
        endpointConfiguration,
        apiKey,
        configuration.httpBodyBytes,
      )
      endpoints.set(endpoint.id, endpoint)
    }

    const frontDoor = await startFrontDoor(endpoints, apiKey)
    let closed = false
    return {
      endpoints: [...endpoints.values()].map(
        (endpoint) => endpoint.observation,
      ),
      host: EXTERNAL_HOST,
      port: frontDoor.port,
      async close() {
        if (closed) {
          return
        }
        closed = true
        await frontDoor.close()
        await Promise.all(
          [...endpoints.values()].map((endpoint) => endpoint.close()),
        )
      },
    }
  } catch (error) {
    await Promise.all(
      [...endpoints.values()].map((endpoint) => endpoint.close()),
    )
    throw error
  }
}
