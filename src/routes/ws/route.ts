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
 * token rides as `?key=`. This is the app's only query-string key (the SSE route
 * that formerly shared the `?key=` pattern has been deleted, ADR-0019).
 *
 * Integration point (not done here): `run-server.ts` must pass
 * `bun: { websocket: createWebSocketHandler(hub, registry) }` into `serve(...)`
 * and mount `createWsRoutes(...)` on the app at `WS_PATH`.
 */
import consola from "consola"
import { Hono } from "hono"

import type {
  LiveFeedClientMessage,
  LiveFeedServerMessage,
  ViewState,
} from "~/lib/ws/feed-types"
import type { LiveFeedHub } from "~/lib/ws/live-feed"
import type { PresenceRegistry } from "~/lib/ws/presence-registry"
import type { TabVisibility } from "~/lib/ws/tray-open"

/** The single WS endpoint. Its own `?key=` minted token is the only query-string key in the app. */
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
  /**
   * Sink for a tab's reported `view` frame (§1.4 restore-on-reopen). Injected so
   * the route stays decoupled from runtime state (and testable with a spy); wired
   * to `setLastView` in run-server. Optional — omitted in tests that don't care.
   */
  readonly onView?: (view: ViewState) => void
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
    // TODO(single-window §6.5): validate the `?key=` session token against the
    // minted per-load token (it rides here because a browser WS can't send
    // headers). For now, presence of a key is required so the handshake can't be
    // opened anonymously. This is the ONLY `?key=` in the app (the SSE route that
    // once shared the pattern is deleted).
    const key = c.req.query("key")
    if (!key) return c.text("missing session token", 401)
    const data: WsData = { authed: true, tabId: c.req.query("tabId") ?? null }
    // A plain (non-WebSocket) GET to /ws — a probe, a health check, a route
    // walker — makes `server.upgrade` throw. Catch it so it degrades to a clean
    // 426 instead of a 500 out of Hono's error handler.
    let upgraded: boolean
    try {
      upgraded = server.upgrade(c.req.raw, { data })
    } catch {
      return c.text("expected a WebSocket upgrade", 426)
    }
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

/** Client `visibilityState` strings we track; anything else is treated as buried. */
function normalizeVisibility(raw: string): TabVisibility {
  return raw === "visible" || raw === "prerender" ? raw : "hidden"
}

/**
 * Parse a frame a tab sent us (hello/visibility/pong). Never throws — a malformed
 * frame from an untrusted browser wire returns null and is dropped, not fatal.
 */
export function parseClientMessage(raw: string): LiveFeedClientMessage | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }
  if (typeof parsed !== "object" || parsed === null || !("type" in parsed)) {
    return null
  }
  const msg = parsed as {
    type: unknown
    tabId?: unknown
    visibility?: unknown
    focused?: unknown
    section?: unknown
    scrollY?: unknown
  }
  // `focused` mirrors `document.hasFocus()`. Optional on the wire: a frame from an
  // older client (or a malformed one) defaults to `false`, which is the safe bias —
  // "not in front" makes the tray reopen rather than dead-click.
  const focused = msg.focused === true
  switch (msg.type) {
    case "hello": {
      if (typeof msg.tabId !== "string" || typeof msg.visibility !== "string") {
        return null
      }
      return {
        type: "hello",
        tabId: msg.tabId,
        visibility: msg.visibility,
        focused,
      }
    }
    case "visibility": {
      if (typeof msg.visibility !== "string") return null
      return { type: "visibility", visibility: msg.visibility, focused }
    }
    case "view": {
      // Restore-on-reopen (§1.4). Require a string section and a finite numeric
      // scroll; a NaN/Infinity or wrong-typed scroll clamps to 0 rather than
      // dropping the whole frame (the section is the more valuable half).
      if (typeof msg.section !== "string") return null
      const scrollY =
        typeof msg.scrollY === "number" && Number.isFinite(msg.scrollY) ?
          Math.max(0, msg.scrollY)
        : 0
      return { type: "view", section: msg.section, scrollY }
    }
    case "pong": {
      return { type: "pong" }
    }
    default: {
      return null
    }
  }
}

/**
 * The Bun websocket handler passed to `serve({ bun: { websocket } })`.
 *
 * Wires the presence registry + snapshot into the socket lifecycle (§1.2–1.3):
 *   - `open`    → an unauthed socket is closed; an authed one is sent the full
 *                 snapshot so the tab resyncs without a poll.
 *   - `message` → `hello` registers the tab (registry key = its `tabId`);
 *                 `visibility` updates presence; `pong` is liveness (Bun's own
 *                 heartbeat drives the ping).
 *   - `close`   → identity-checked remove, so a reconnected tab's live socket
 *                 survives this (stale) socket's late close.
 */
export function createWebSocketHandler({ hub, registry, onView }: WsDeps) {
  return {
    open(ws: ServerWebSocket<WsData>): void {
      if (!ws.data.authed) {
        ws.close()
        return
      }
      // Send the complete snapshot on (re)connect (§1.3). Fire-and-forget: the
      // socket is already open, and a snapshot build failure must not throw out
      // of the Bun callback (it would tear the connection down uncleanly).
      void hub
        .snapshot()
        .then((snapshot) => {
          sendServer(ws, { type: "snapshot", snapshot })
        })
        .catch((error: unknown) => {
          consola.warn("live-feed: snapshot build failed on open", error)
        })
    },

    message(ws: ServerWebSocket<WsData>, raw: string | Buffer): void {
      const message = parseClientMessage(
        typeof raw === "string" ? raw : raw.toString(),
      )
      if (!message) return
      switch (message.type) {
        case "hello": {
          // The registry key. Track it on the socket so `close` can evict the
          // right tab even though the close frame carries no body.
          ws.data.tabId = message.tabId
          registry.register(message.tabId, ws, {
            visibility: normalizeVisibility(message.visibility),
            focused: message.focused,
          })
          return
        }
        case "visibility": {
          if (ws.data.tabId) {
            registry.updateVisibility(ws.data.tabId, {
              visibility: normalizeVisibility(message.visibility),
              focused: message.focused,
            })
          }
          return
        }
        case "view": {
          // Restore-on-reopen (§1.4): remember where this tab is so a tray-
          // surfaced fresh tab lands here. Global (not per-tab): last writer wins.
          onView?.({ section: message.section, scrollY: message.scrollY })
          return
        }
        case "pong": {
          // Liveness ack; Bun's built-in heartbeat sends the ping. No state to
          // change — receiving it at all is the signal the socket is alive.
          return
        }
        default: {
          // `parseClientMessage` already rejected unknown frames; unreachable.
          return
        }
      }
    },

    close(ws: ServerWebSocket<WsData>): void {
      if (ws.data.tabId) registry.remove(ws.data.tabId, ws)
    },

    pong(_ws: ServerWebSocket<WsData>): void {},
  }
}

/** Serialize + send one server frame to a single socket. */
function sendServer(
  ws: ServerWebSocket<WsData>,
  message: LiveFeedServerMessage,
): void {
  ws.send(JSON.stringify(message))
}
