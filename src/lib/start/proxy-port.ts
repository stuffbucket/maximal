/**
 * The port Maximal's proxy listens on, for anything that must point a client
 * at it (e.g. MCP entries written into Claude Code / Claude Desktop).
 *
 * In the server process it is the port `runServer` bound. Elsewhere (the CLI)
 * it is the running instance's, read from its session sentinel; with none
 * running, the default.
 */

import { runningSessionPort } from "./session-sentinel"

export const DEFAULT_PROXY_PORT = 4141

let listeningPort: number | undefined

/** Called by `runServer` once it knows its port. */
export function setListeningPort(port: number | undefined): void {
  listeningPort = port
}

export function currentProxyPort(): number {
  return listeningPort ?? runningSessionPort() ?? DEFAULT_PROXY_PORT
}
