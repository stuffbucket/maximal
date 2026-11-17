/**
 * The FigJam panel's WebSocket, relayed on Maximal's own origin.
 *
 * The panel (a Figma plugin) may reach only the origins its manifest lists, so
 * it connects to `ws://localhost:<maximalPort>/figjam/plugin` and nothing else.
 * The bridge itself runs inside the FigJam plugin's generation child process
 * (its state is module-level, and plugins have no raw-socket channel to the
 * parent), listening on a loopback port of its own. This module is the
 * parent-owned seam between the two: the HTTP route upgrades the request, and
 * these handlers copy frames both ways to the bridge's `/plugin` socket. It
 * never looks inside a frame: pairing, tokens and tool calls stay the
 * bridge's business, so no credential is seen or stored here.
 */

import type { ServerWebSocket, WebSocketHandler } from "bun"

import consola from "consola"

/** What the route attaches to an upgraded socket. */
export interface FigjamRelayData {
  /** The bridge's loopback socket this panel is relayed to. */
  target: string
  /** Chatty (info) logging instead of debug: a development profile. */
  verbose: boolean
  /** Frames that arrived before the bridge socket opened. */
  queue: Array<string | Uint8Array>
  upstream?: WebSocket
}

/** Opens the bridge's socket. Injectable so a test needn't run a bridge. */
export type FigjamRelayConnector = (url: string) => WebSocket

const BRIDGE_SOCKET_LIMIT = 64 * 1024 * 1024

// Bun's server socket may be closed only with these codes. The bridge's
// pairing codes (4000-4999) are the point of relaying faithfully.
function closeCode(code: number): number {
  const sendable =
    (code >= 1000 && code <= 1003)
    || (code >= 1007 && code <= 1011)
    || (code >= 3000 && code <= 4999)
  return sendable ? code : 1011
}

function say(data: FigjamRelayData, message: string): void {
  if (data.verbose) consola.info(message)
  else consola.debug(message)
}

export function createFigjamRelay(
  connect: FigjamRelayConnector = (url) => new WebSocket(url),
): WebSocketHandler<FigjamRelayData> {
  return {
    maxPayloadLength: BRIDGE_SOCKET_LIMIT,
    open(ws: ServerWebSocket<FigjamRelayData>) {
      const { data } = ws
      say(data, `figjam: panel socket upgraded; relaying to ${data.target}`)
      let upstream: WebSocket
      try {
        upstream = connect(data.target)
      } catch (error) {
        consola.warn(
          `figjam: could not open the bridge socket at ${data.target}: ${String(error)}`,
        )
        ws.close(1011, "The FigJam bridge is not reachable.")
        return
      }
      upstream.binaryType = "arraybuffer"
      data.upstream = upstream
      upstream.addEventListener("open", () => {
        for (const frame of data.queue.splice(0)) upstream.send(frame)
      })
      upstream.addEventListener("message", (event) => {
        const frame: unknown = event.data
        if (typeof frame === "string") ws.send(frame)
        else if (frame instanceof ArrayBuffer) ws.send(new Uint8Array(frame))
      })
      upstream.addEventListener("error", () => {
        // The close event follows and carries the outcome to the panel.
        consola.warn(
          `figjam: the bridge socket at ${data.target} failed; the FigJam plugin may have stopped or restarted`,
        )
      })
      upstream.addEventListener("close", (event) => {
        say(
          data,
          `figjam: the bridge closed the relayed socket (code ${event.code})`,
        )
        data.upstream = undefined
        ws.close(closeCode(event.code), event.reason.slice(0, 120))
      })
    },
    message(ws, message) {
      const { upstream, queue } = ws.data
      const frame =
        typeof message === "string" ? message : new Uint8Array(message)
      if (upstream?.readyState === WebSocket.OPEN) upstream.send(frame)
      else if (upstream?.readyState === WebSocket.CONNECTING) queue.push(frame)
    },
    close(ws, code, reason) {
      const { upstream } = ws.data
      say(
        ws.data,
        `figjam: the panel closed its socket (code ${code}${reason ? `, ${reason.slice(0, 80)}` : ""})`,
      )
      ws.data.upstream = undefined
      if (
        upstream
        && (upstream.readyState === WebSocket.OPEN
          || upstream.readyState === WebSocket.CONNECTING)
      ) {
        upstream.close(
          code === 1005 || code === 1006 ? 1000 : closeCode(code),
          reason.slice(0, 120),
        )
      }
    },
  }
}

/** The relay `run-server` hands to the HTTP server. */
export const figjamRelay = createFigjamRelay()
