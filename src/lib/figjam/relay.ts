/**
 * The FigJam panel's WebSocket, relayed on Maximal's own origin.
 *
 * The panel (a Figma plugin) may reach only the origins its manifest lists, so
 * it connects to `ws://localhost:<maximalPort>/figjam/plugin` and nothing else.
 * The bridge itself runs inside the FigJam plugin's generation child process.
 * These handlers copy frames both ways without inspecting them; pairing,
 * tokens and tool calls stay the bridge's business.
 */

import type { ServerWebSocket, WebSocketHandler } from "bun"

import consola from "consola"

export interface FigjamRelayData {
  target: string
  verbose: boolean
  /** Frames that arrived before the bridge socket opened. */
  queue: Array<string | Uint8Array>
  queueBytes: number
  /** The downstream ended, so late upstream events are expected. */
  closed: boolean
  upstream?: WebSocket
}

export type FigjamRelayConnector = (url: string) => WebSocket

/** A legitimate individual frame may be as large as the bridge already allowed. */
export const FIGJAM_RELAY_PAYLOAD_LIMIT = 64 * 1024 * 1024
/** Queued or buffered bytes beyond this bound close both peers. */
export const FIGJAM_RELAY_BACKPRESSURE_LIMIT = 64 * 1024 * 1024

const textEncoder = new TextEncoder()
const OVERFLOW_REASON = "FigJam relay backpressure limit exceeded."

function closeCode(code: number): number {
  const sendable =
    (code >= 1000 && code <= 1003)
    || (code >= 1007 && code <= 1011)
    || (code >= 3000 && code <= 4999)
  return sendable ? code : 1011
}

function frameBytes(frame: string | Uint8Array): number {
  return typeof frame === "string" ?
      textEncoder.encode(frame).byteLength
    : frame.byteLength
}

function say(data: FigjamRelayData, message: string): void {
  if (data.verbose) consola.info(message)
  else consola.debug(message)
}

function closeBoth(
  ws: ServerWebSocket<FigjamRelayData>,
  code: number,
  reason: string,
): void {
  const { data } = ws
  if (data.closed) return
  data.closed = true
  data.queue.length = 0
  data.queueBytes = 0
  const upstream = data.upstream
  data.upstream = undefined
  if (
    upstream
    && (upstream.readyState === WebSocket.OPEN
      || upstream.readyState === WebSocket.CONNECTING)
  ) {
    upstream.close(code, reason.slice(0, 120))
  }
  ws.close(code, reason.slice(0, 120))
}

interface UpstreamSend {
  socket: WebSocket
  backpressureLimit: number
}

function sendUpstream(
  ws: ServerWebSocket<FigjamRelayData>,
  frame: string | Uint8Array,
  target: UpstreamSend,
): boolean {
  const bytes = frameBytes(frame)
  if (target.socket.bufferedAmount + bytes > target.backpressureLimit) {
    closeBoth(ws, 1013, OVERFLOW_REASON)
    return false
  }
  try {
    target.socket.send(frame)
  } catch {
    closeBoth(ws, 1011, "The FigJam bridge socket failed.")
    return false
  }
  if (target.socket.bufferedAmount > target.backpressureLimit) {
    closeBoth(ws, 1013, OVERFLOW_REASON)
    return false
  }
  return true
}

interface RelayRuntime {
  connect: FigjamRelayConnector
  backpressureLimit: number
}

function openRelay(
  ws: ServerWebSocket<FigjamRelayData>,
  runtime: RelayRuntime,
): void {
  const { data } = ws
  say(data, `figjam: panel socket upgraded; relaying to ${data.target}`)
  let upstream: WebSocket
  try {
    upstream = runtime.connect(data.target)
  } catch (error) {
    consola.warn(
      `figjam: could not open the bridge socket at ${data.target}: ${String(error)}`,
    )
    closeBoth(ws, 1011, "The FigJam bridge is not reachable.")
    return
  }
  upstream.binaryType = "arraybuffer"
  data.upstream = upstream
  const target = {
    socket: upstream,
    backpressureLimit: runtime.backpressureLimit,
  }
  upstream.addEventListener("open", () => {
    if (data.closed) {
      if (upstream.readyState === WebSocket.OPEN) upstream.close(1000)
      return
    }
    const queued = data.queue.splice(0)
    data.queueBytes = 0
    for (const frame of queued) {
      if (!sendUpstream(ws, frame, target)) break
    }
  })
  upstream.addEventListener("message", (event) => {
    if (data.closed) return
    const frame: unknown = event.data
    let sendable: string | Uint8Array | undefined
    if (typeof frame === "string") sendable = frame
    else if (frame instanceof ArrayBuffer) sendable = new Uint8Array(frame)
    if (sendable === undefined) return
    const sent = ws.send(sendable)
    if (frameBytes(sendable) > 0 && sent <= 0) {
      closeBoth(ws, 1013, OVERFLOW_REASON)
    }
  })
  upstream.addEventListener("error", () => {
    // Closing downstream aborts an in-progress upstream connect. Its resulting
    // error/1006 is expected and must not become a false warning.
    if (data.closed) return
    consola.warn(
      `figjam: the bridge socket at ${data.target} failed; the FigJam plugin may have stopped or restarted`,
    )
  })
  upstream.addEventListener("close", (event) => {
    data.upstream = undefined
    if (data.closed) return
    say(
      data,
      `figjam: the bridge closed the relayed socket (code ${event.code})`,
    )
    data.closed = true
    data.queue.length = 0
    data.queueBytes = 0
    ws.close(closeCode(event.code), event.reason.slice(0, 120))
  })
}

function relayMessage(
  ws: ServerWebSocket<FigjamRelayData>,
  message: string | Buffer<ArrayBuffer>,
  backpressureLimit: number,
): void {
  const { upstream, queue } = ws.data
  if (ws.data.closed) return
  const frame = typeof message === "string" ? message : new Uint8Array(message)
  if (upstream?.readyState === WebSocket.OPEN) {
    sendUpstream(ws, frame, { socket: upstream, backpressureLimit })
    return
  }
  if (upstream?.readyState === WebSocket.CONNECTING) {
    const bytes = frameBytes(frame)
    if (ws.data.queueBytes + bytes > backpressureLimit) {
      closeBoth(ws, 1013, OVERFLOW_REASON)
      return
    }
    queue.push(frame)
    ws.data.queueBytes += bytes
    return
  }
  closeBoth(ws, 1011, "The FigJam bridge socket is not open.")
}

function closeDownstream(
  ws: ServerWebSocket<FigjamRelayData>,
  code: number,
  reason: string,
): void {
  const { data } = ws
  if (!data.closed) {
    say(
      data,
      `figjam: the panel closed its socket (code ${code}${reason ? `, ${reason.slice(0, 80)}` : ""})`,
    )
  }
  data.closed = true
  data.queue.length = 0
  data.queueBytes = 0
  const upstream = data.upstream
  data.upstream = undefined
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
}

export interface FigjamRelayOptions {
  /** Test seam; production keeps the 64 MiB bound. */
  backpressureLimit?: number
}

export function createFigjamRelay(
  connect: FigjamRelayConnector = (url) => new WebSocket(url),
  options: FigjamRelayOptions = {},
): WebSocketHandler<FigjamRelayData> {
  const backpressureLimit =
    options.backpressureLimit ?? FIGJAM_RELAY_BACKPRESSURE_LIMIT
  const runtime = { connect, backpressureLimit }
  return {
    maxPayloadLength: FIGJAM_RELAY_PAYLOAD_LIMIT,
    backpressureLimit,
    closeOnBackpressureLimit: true,
    open: (ws) => openRelay(ws, runtime),
    message: (ws, message) => relayMessage(ws, message, backpressureLimit),
    close: closeDownstream,
  }
}

export const figjamRelay = createFigjamRelay()
