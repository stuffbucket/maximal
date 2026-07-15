import type { LiveFeedServerMessage } from "~/lib/ws/feed-types"

/**
 * Presence registry (spec §1.2) — the sidecar's map of open tabs, keyed by the
 * client-generated `tabId`, holding each tab's socket + last-reported visibility.
 *
 * Correctness hinges on an **identity-checked delete** (`if map.get(id) === ws`)
 * so a reconnecting tab's new socket isn't removed by the old socket's late
 * `close`. That guard is the mutation-test anchor (Verification table).
 *
 * Generic over the socket type so unit tests can pass a fake `{ send, close }`
 * without Bun's `ServerWebSocket` (there is no real-port harness in the repo).
 */
import { notImplemented } from "~/lib/dev/not-implemented"
import {
  decideTrayOpen,
  type RegisteredTab,
  type TrayOpenAction,
} from "~/lib/ws/tray-open"

/** Minimal contract the registry needs from a connection (subset of ServerWebSocket). */
export interface PresenceSocket {
  send(data: string): unknown
  close(): unknown
}

interface Entry<S extends PresenceSocket> {
  readonly socket: S
  visibility: RegisteredTab["visibility"]
}

export class PresenceRegistry<S extends PresenceSocket = PresenceSocket> {
  private readonly tabs = new Map<string, Entry<S>>()

  /** Insert/replace on `hello`. Replacing a tabId supersedes its prior socket. */
  register(
    tabId: string,
    socket: S,
    visibility: RegisteredTab["visibility"],
  ): void {
    return notImplemented("PresenceRegistry.register", {
      tabId,
      socket,
      visibility,
    })
  }

  /** Update a tab's visibility on a `visibility` frame (no-op if the tab is gone). */
  updateVisibility(
    tabId: string,
    visibility: RegisteredTab["visibility"],
  ): void {
    return notImplemented("PresenceRegistry.updateVisibility", {
      tabId,
      visibility,
    })
  }

  /**
   * Identity-checked delete on socket close. Returns true only if THIS socket was
   * the one registered (a stale socket's late close for a reconnected tab is a no-op).
   */
  remove(tabId: string, socket: S): boolean {
    return notImplemented("PresenceRegistry.remove", { tabId, socket })
  }

  /** Pure snapshot for `decideTrayOpen` and the diagnostics page. */
  snapshot(): ReadonlyArray<RegisteredTab> {
    return notImplemented("PresenceRegistry.snapshot")
  }

  /** Convenience: current tray decision over the live snapshot. */
  trayDecision(): TrayOpenAction {
    return decideTrayOpen(this.snapshot())
  }

  /** Look up the socket for a tabId (used to send the `close` command on dedup). */
  socketFor(tabId: string): S | undefined {
    return notImplemented("PresenceRegistry.socketFor", { tabId })
  }

  /** Fan a server message out to every connected tab (feed broadcast). */
  broadcast(message: LiveFeedServerMessage): void {
    return notImplemented("PresenceRegistry.broadcast", { message })
  }

  get size(): number {
    return this.tabs.size
  }
}
