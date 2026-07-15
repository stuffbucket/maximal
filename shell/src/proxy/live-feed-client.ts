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
import { notImplemented } from "../dev/not-implemented";
import type {
  LiveFeedEvent,
  LiveFeedSnapshot,
} from "../../../src/lib/ws/feed-types";

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
  return notImplemented("connectLiveFeed", { handlers, boundPort, sessionToken });
}
