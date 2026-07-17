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
} from "../../../src/lib/ws/feed-types";

import {
  computeBackoffMs,
  getTabId,
  liveFeedUrl,
  parseServerMessage,
  serializeClientMessage,
} from "./live-feed-core";

export interface LiveFeedHandlers {
  readonly onSnapshot: (snapshot: LiveFeedSnapshot) => void;
  readonly onEvent: (event: LiveFeedEvent) => void;
  /** The sidecar told this (buried) tab to self-close for tray dedup. */
  readonly onCloseCommand: () => void;
  readonly onStatusChange?: (status: LiveFeedStatus) => void;
}

export type LiveFeedStatus = "connecting" | "open" | "reconnecting" | "closed";

export interface LiveFeedConnection {
  readonly status: () => LiveFeedStatus;
  readonly close: () => void;
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
  const tabId = getTabId(window.sessionStorage, () => crypto.randomUUID());

  let socket: WebSocket | null = null;
  let status: LiveFeedStatus = "closed";
  let attempt = 0;
  let reconnectTimer: number | null = null;
  let closedByUser = false;

  const setStatus = (next: LiveFeedStatus): void => {
    status = next;
    handlers.onStatusChange?.(next);
  };

  const send = (message: Parameters<typeof serializeClientMessage>[0]): void => {
    if (socket?.readyState === WebSocket.OPEN) {
      socket.send(serializeClientMessage(message));
    }
  };

  const scheduleReconnect = (): void => {
    if (closedByUser) return;
    setStatus("reconnecting");
    // Bounded exponential backoff (§1.3); `attempt` resets to 0 on a clean open.
    reconnectTimer = window.setTimeout(connect, computeBackoffMs(attempt));
    attempt += 1;
  };

  function connect(): void {
    if (closedByUser) return;
    setStatus(attempt === 0 ? "connecting" : "reconnecting");
    socket = new WebSocket(liveFeedUrl(boundPort, sessionToken));

    socket.onopen = (): void => {
      attempt = 0;
      setStatus("open");
      // The sidecar sends a full snapshot on connect, so a reconnect resyncs
      // without an extra request; we only announce presence + visibility.
      send({ type: "hello", tabId, visibility: document.visibilityState });
    };

    socket.onmessage = (ev: MessageEvent): void => {
      const message = parseServerMessage(
        typeof ev.data === "string" ? ev.data : "",
      );
      if (!message) return;
      switch (message.type) {
        case "snapshot": {
          handlers.onSnapshot(message.snapshot);
          return;
        }
        case "event": {
          handlers.onEvent(message.event);
          return;
        }
        case "ping": {
          send({ type: "pong" });
          return;
        }
        case "close": {
          // Tray dedup (§1.2): a buried tab is told to self-close. Reliable only
          // under the single-history invariant (ADR-0020).
          handlers.onCloseCommand();
          return;
        }
      }
    };

    // A dropped socket reconnects with backoff; an error just closes it, which
    // routes into the same onclose path.
    socket.onclose = (): void => scheduleReconnect();
    socket.onerror = (): void => socket?.close();
  }

  const onVisibilityChange = (): void => {
    if (document.visibilityState === "visible") {
      // Refocus after the socket was dropped (e.g. Safari tore it down while
      // backgrounded): reconnect immediately at the base backoff.
      if (!socket || socket.readyState === WebSocket.CLOSED) {
        attempt = 0;
        connect();
        return;
      }
    }
    send({ type: "visibility", visibility: document.visibilityState });
  };
  document.addEventListener("visibilitychange", onVisibilityChange);

  connect();

  return {
    status: () => status,
    close: (): void => {
      closedByUser = true;
      if (reconnectTimer !== null) window.clearTimeout(reconnectTimer);
      document.removeEventListener("visibilitychange", onVisibilityChange);
      socket?.close();
      setStatus("closed");
    },
  };
}
