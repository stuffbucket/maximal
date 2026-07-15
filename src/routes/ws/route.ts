import type { ServerWebSocket } from "bun"
import type { ServerRequest } from "srvx"

/**
 * WebSocket upgrade route + handler (spec §1.3).
 *
 * srvx 0.11's `bun:{ websocket }` option flows straight to `Bun.serve`, and the
 * Bun `server` handle is decorated per-request, so ONE Hono route calls
 * `server.upgrade(...)` — no crossws, no srvx fork, zero new dependency.
 *
 * THE GATE TO PROVE FIRST (§1.3): srvx's fetch-wrapper must tolerate the
 * `undefined` return after `upgrade()`. If it coerces it to a `Response`, the
 * handshake silently fails. `tests/ws/srvx-upgrade-handshake.test.ts` is the
 * real-port test that proves this (the one deliberate port-binding test).
 *
 * Auth (§1.3, §6): a browser WS cannot send `x-api-key`, so the minted session
 * token rides as `?key=`. The path-scoped `?key=` allowlist that lives in
 * `request-auth.ts` for `SSE_EVENTS_PATH` must MOVE to `WS_PATH`.
 *
 * Integration point (not done here): `run-server.ts` must pass
 * `bun: { websocket: createWebSocketHandler(hub, registry) }` into `serve(...)`
 * and mount `createWsRoutes(...)` on the app at `WS_PATH`.
 */
import { Hono } from "hono"

import type { LiveFeedHub } from "~/lib/ws/live-feed"
import type { PresenceRegistry } from "~/lib/ws/presence-registry"

import { notImplemented } from "~/lib/dev/not-implemented"

/** The single WS endpoint. Replaces `SSE_EVENTS_PATH` as the `?key=` allowlisted path. */
export const WS_PATH = "/ws"

/** Per-socket data attached at upgrade time and read back in the handler callbacks. */
export interface WsData {
  /** Resolved from the `?key=` token at upgrade; the socket is closed if invalid. */
  readonly authed: boolean
  /** Tab id from the query/`hello`; the registry key. */
  tabId: string | null
}

interface WsDeps {
  readonly hub: LiveFeedHub
  readonly registry: PresenceRegistry
}

/**
 * Reach the Bun server decorated on the srvx request, for `server.upgrade`.
 * One-line type-cast seam (not business logic): srvx puts the handle at
 * `request.runtime.bun.server` (node_modules/srvx types).
 */
function bunServer(raw: Request) {
  return (raw as unknown as ServerRequest).runtime?.bun?.server
}

/**
 * The Hono route whose GET performs the upgrade. Returns `undefined` on a
 * successful upgrade (the gate above), or a 401/426 Response otherwise.
 */
export function createWsRoutes(deps: WsDeps): Hono {
  const app = new Hono()
  app.get("/", (c) => {
    // TODO(single-window §1.3): validate `?key=`; on success call
    // bunServer(c.req.raw).upgrade(c.req.raw, { data }) and return undefined; else 401/426.
    return notImplemented("wsRoutes.GET", { deps, path: c.req.path, bunServer })
  })
  return app
}

/**
 * The Bun websocket handler passed to `serve({ bun: { websocket } })`.
 * `open`  → register presence, send snapshot.
 * `message` → hello/visibility/pong frames update the registry.
 * `close` → identity-checked remove.
 */
export function createWebSocketHandler(deps: WsDeps) {
  return {
    open(ws: ServerWebSocket<WsData>): void {
      return notImplemented("ws.open", { ws, deps })
    },
    message(ws: ServerWebSocket<WsData>, raw: string | Buffer): void {
      return notImplemented("ws.message", { ws, raw, deps })
    },
    close(ws: ServerWebSocket<WsData>): void {
      return notImplemented("ws.close", { ws, deps })
    },
    pong(ws: ServerWebSocket<WsData>): void {
      return notImplemented("ws.pong", { ws })
    },
  }
}
