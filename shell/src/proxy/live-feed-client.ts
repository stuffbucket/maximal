/**
 * Browser-side live-feed client (spec §1.2–1.3) — the WebSocket/DOM glue.
 *
 * Replaces `subscribeAuthEvents()` (the EventSource wrapper in `client.ts`) with
 * the single WebSocket. Composes the DOM-free helpers in `live-feed-core.ts`;
 * this file owns the `WebSocket` + `window` + `visibilitychange` wiring and is
 * therefore covered by source-grep, not imported into the DOM-less test runner.
 *
 * Responsibilities:
 *   - hold a stable `tabId` in `sessionStorage` (the presence-registry key, §1.2);
 *   - connect to the `?key=<sessionToken>` WS on the inlined bound port (§1.1/§1.4);
 *   - send `hello`/`visibility`, answer `ping` with `pong`;
 *   - reconnect on `visibilitychange`→visible with bounded backoff (§1.3);
 *   - on the sidecar `close` command, self-close the tab (tray dedup §1.2) — only
 *     reliable under the single-history invariant (ADR-0020);
 *   - re-request the full snapshot on every (re)connect so a resumed tab resyncs.
 *
 * No `window.__TAURI__` (§1.5): a browser tab has no Tauri host.
 */
import type {
  LiveFeedEvent,
  LiveFeedSnapshot,
  ViewState,
} from "../../../src/lib/ws/feed-types"

import {
  computeBackoffMs,
  getTabId,
  liveFeedUrl,
  parseServerMessage,
  serializeClientMessage,
} from "./live-feed-core"

export interface LiveFeedHandlers {
  readonly onSnapshot: (snapshot: LiveFeedSnapshot) => void
  readonly onEvent: (event: LiveFeedEvent) => void
  /** The sidecar told this (buried) tab to self-close for tray dedup. */
  readonly onCloseCommand: () => void
  readonly onStatusChange?: (status: LiveFeedStatus) => void
  /**
   * Sample the tab's current section + scroll for restore-on-reopen (§1.4). Called
   * on connect and on each presence change (focus/blur/visibility) — the latter
   * captures the view at the moment the user switches away, which is what a later
   * tray click restores. Also invoked by `reportView()`. Omit to disable reporting.
   */
  readonly sampleView?: () => ViewState
}

export type LiveFeedStatus = "connecting" | "open" | "reconnecting" | "closed"

export interface LiveFeedConnection {
  readonly status: () => LiveFeedStatus
  readonly close: () => void
  /** Report the current view now (e.g. on section navigation). No-op without `sampleView`. */
  readonly reportView: () => void
}

/**
 * Wire the DOM listeners that keep the sidecar's presence registry current, and
 * return a teardown. BOTH visibility and OS focus are reported (§1.2): switching
 * app or browser window changes `document.hasFocus()` WITHOUT firing
 * `visibilitychange` (the tab stays "visible") — that gap is exactly what made a
 * tray click dead when the browser wasn't frontmost. On a hidden→visible
 * transition, `reconnectIfDropped` reconnects a dead socket (and returns true,
 * suppressing the presence report, since the reconnect's `hello` carries it).
 */
function installPresenceReporting(
  reportPresence: () => void,
  reconnectIfDropped: () => boolean,
): () => void {
  const onVisibilityChange = (): void => {
    if (document.visibilityState === "visible" && reconnectIfDropped()) return
    reportPresence()
  }
  const onFocusChange = (): void => reportPresence()
  document.addEventListener("visibilitychange", onVisibilityChange)
  globalThis.addEventListener("focus", onFocusChange)
  globalThis.addEventListener("blur", onFocusChange)
  return (): void => {
    document.removeEventListener("visibilitychange", onVisibilityChange)
    globalThis.removeEventListener("focus", onFocusChange)
    globalThis.removeEventListener("blur", onFocusChange)
  }
}

/**
 * Route one parsed server frame to the handlers. Extracted from `connectLiveFeed`
 * to keep that function within the line budget; pure dispatch, no socket state.
 */
function dispatchServerMessage(
  message: NonNullable<ReturnType<typeof parseServerMessage>>,
  handlers: LiveFeedHandlers,
  send: (message: Parameters<typeof serializeClientMessage>[0]) => void,
): void {
  switch (message.type) {
    case "snapshot": {
      handlers.onSnapshot(message.snapshot)
      return
    }
    case "event": {
      handlers.onEvent(message.event)
      return
    }
    case "ping": {
      send({ type: "pong" })
      return
    }
    case "close": {
      // Tray dedup (§1.2): a buried tab is told to self-close. Reliable only
      // under the single-history invariant (ADR-0020).
      handlers.onCloseCommand()
      return
    }
    default: {
      break
    }
  }
}

/**
 * Open the feed using values inlined in `window.__STATE__` (bound port + session
 * token). Owns reconnect/backoff/visibility internally via `live-feed-core.ts`.
 */
export function connectLiveFeed(
  handlers: LiveFeedHandlers,
  boundPort: number,
  sessionToken: string,
): LiveFeedConnection {
  // Stable presence-registry key (§1.2), minted once per tab and kept across
  // reconnects so the sidecar recognizes a resumed tab as the same one.
  const tabId = getTabId(globalThis.sessionStorage, () => crypto.randomUUID())

  let socket: WebSocket | null = null
  let status: LiveFeedStatus = "closed"
  let attempt = 0
  let reconnectTimer: ReturnType<typeof globalThis.setTimeout> | null = null
  let closedByUser = false

  const setStatus = (next: LiveFeedStatus): void => {
    status = next
    handlers.onStatusChange?.(next)
  }

  const send = (
    message: Parameters<typeof serializeClientMessage>[0],
  ): void => {
    if (socket?.readyState === WebSocket.OPEN) {
      socket.send(serializeClientMessage(message))
    }
  }

  // Restore-on-reopen (§1.4): sample and report the current section + scroll.
  const reportView = (): void => {
    const view = handlers.sampleView?.()
    if (view) {
      send({ type: "view", section: view.section, scrollY: view.scrollY })
    }
  }

  const scheduleReconnect = (): void => {
    if (closedByUser) return
    setStatus("reconnecting")
    // Bounded exponential backoff (§1.3); `attempt` resets to 0 on a clean open.
    reconnectTimer = globalThis.setTimeout(connect, computeBackoffMs(attempt))
    attempt += 1
  }

  function connect(): void {
    if (closedByUser) return
    setStatus(attempt === 0 ? "connecting" : "reconnecting")
    socket = new WebSocket(liveFeedUrl(boundPort, sessionToken))

    socket.addEventListener("open", (): void => {
      attempt = 0
      setStatus("open")
      // The sidecar sends a full snapshot on connect, so a reconnect resyncs
      // without an extra request; we only announce presence + visibility.
      send({
        type: "hello",
        tabId,
        visibility: document.visibilityState,
        focused: document.hasFocus(),
      })
      // Announce the current view too, so the sidecar has it from first connect.
      reportView()
    })

    socket.addEventListener("message", (ev: MessageEvent): void => {
      const message = parseServerMessage(
        typeof ev.data === "string" ? ev.data : "",
      )
      if (message) dispatchServerMessage(message, handlers, send)
    })

    // A dropped socket reconnects with backoff; an error just closes it, which
    // routes into the same onclose path.
    socket.addEventListener("close", (): void => scheduleReconnect())
    socket.addEventListener("error", (): void => socket?.close())
  }

  // Keep the sidecar's presence registry current (visibility + OS focus, §1.2). A
  // hidden→visible transition that finds the socket dropped reconnects instead of
  // just reporting.
  const teardownPresence = installPresenceReporting(
    () => {
      send({
        type: "visibility",
        visibility: document.visibilityState,
        focused: document.hasFocus(),
      })
      // Capture section + scroll on the same triggers — a blur/hidden transition
      // (user switching away) freezes exactly the view a later reopen restores.
      reportView()
    },
    () => {
      if (!socket || socket.readyState === WebSocket.CLOSED) {
        attempt = 0
        connect()
        return true
      }
      return false
    },
  )

  connect()

  return {
    status: () => status,
    reportView,
    close: (): void => {
      closedByUser = true
      if (reconnectTimer !== null) globalThis.clearTimeout(reconnectTimer)
      teardownPresence()
      socket?.close()
      setStatus("closed")
    },
  }
}
