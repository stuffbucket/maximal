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

/** The one Bun-server capability the route needs: upgrade a request to a WS. */
interface Upgradable {
  upgrade(request: Request, options?: { data?: WsData }): boolean
}

/**
 * Reach the Bun server decorated on the srvx request, for `server.upgrade`.
 * One-line type-cast seam (not business logic): srvx puts the handle at
 * `request.runtime.bun.server` (node_modules/srvx types). Narrowed to `Upgradable`
 * so the `data` payload types as `WsData` without fighting Bun's `Server<T>`
 * generic (which srvx pins to `<any>`).
 */
function bunServer(raw: Request): Upgradable | undefined {
  return (raw as unknown as ServerRequest).runtime?.bun?.server
}

/**
 * The Hono route whose GET performs the upgrade. Returns `undefined` on a
 * successful upgrade (the gate proven in tests/ws/srvx-upgrade-handshake.test.ts),
 * or an error Response otherwise. Stateless — presence lives in the WS callbacks.
 */
export function createWsRoutes(): Hono {
  const app = new Hono()
  app.get("/", (c) => {
    const server = bunServer(c.req.raw)
    if (!server) return c.text("bun server unavailable", 500)
    // TODO(single-window §1.3/§6.5): validate the `?key=` session token (the
    // SSE_EVENTS_PATH `?key=` allowlist moves here). For now, presence of a key
    // is required so the handshake can't be opened anonymously.
    const key = c.req.query("key")
    if (!key) return c.text("missing session token", 401)
    const data: WsData = { authed: true, tabId: c.req.query("tabId") ?? null }
    const upgraded = server.upgrade(c.req.raw, { data })
    // THE GATE (proven): on success the handler returns `undefined` and Bun keeps
    // the upgraded socket. srvx hands this return straight to Bun (no coercion),
    // so the `undefined` survives Hono's dispatch. The cast only satisfies Hono's
    // handler-return typing (which expects a Response) — at runtime this is a
    // genuine `undefined`, which is exactly what Bun requires post-upgrade.
    if (upgraded) return undefined as unknown as Response
    return c.text("upgrade failed", 426)
  })
  return app
}

/**
 * The Bun websocket handler passed to `serve({ bun: { websocket } })`.
 *
 * SPIKE SCOPE: these are minimal non-throwing callbacks that prove the handshake.
 * The full behavior — `open` → register presence + send snapshot; `message` →
 * hello/visibility/pong frames update the registry; `close` → identity-checked
 * remove — is TODO(single-window §1.2/§1.3) and depends on the (still stubbed)
 * PresenceRegistry + LiveFeedHub methods, so it is intentionally not wired here.
 */
export function createWebSocketHandler(_deps: WsDeps) {
  return {
    open(_ws: ServerWebSocket<WsData>): void {},
    message(_ws: ServerWebSocket<WsData>, _raw: string | Buffer): void {},
    close(_ws: ServerWebSocket<WsData>): void {},
    pong(_ws: ServerWebSocket<WsData>): void {},
  }
}
