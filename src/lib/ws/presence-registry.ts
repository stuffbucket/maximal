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
import {
  decideTrayOpen,
  type RegisteredTab,
  type TabPresence,
  type TrayOpenAction,
} from "~/lib/ws/tray-open"

/** Minimal contract the registry needs from a connection (subset of ServerWebSocket). */
export interface PresenceSocket {
  send(data: string): unknown
  close(): unknown
}

interface Entry<S extends PresenceSocket> {
  readonly socket: S
  presence: TabPresence
}

export class PresenceRegistry<S extends PresenceSocket = PresenceSocket> {
  private readonly tabs = new Map<string, Entry<S>>()

  /** Insert/replace on `hello`. Replacing a tabId supersedes its prior socket. */
  register(tabId: string, socket: S, presence: TabPresence): void {
    this.tabs.set(tabId, { socket, presence })
  }

  /**
   * Update a tab's presence (visibility + focus) on a `visibility` frame (no-op if
   * the tab is gone). Focus rides the same frame because both change on the same
   * user actions (switching tabs/windows/apps) and the tray decision needs both.
   */
  updateVisibility(tabId: string, presence: TabPresence): void {
    const entry = this.tabs.get(tabId)
    if (entry) entry.presence = presence
  }

  /**
   * Identity-checked delete on socket close. Returns true only if THIS socket was
   * the one registered (a stale socket's late close for a reconnected tab is a no-op).
   */
  remove(tabId: string, socket: S): boolean {
    // The identity guard: a reconnecting tab's new socket registered under the
    // same tabId must survive the OLD socket's late `close`. Deleting on tabId
    // alone would evict the live connection.
    if (this.tabs.get(tabId)?.socket !== socket) return false
    return this.tabs.delete(tabId)
  }

  /** Pure snapshot for `decideTrayOpen` and the diagnostics page. */
  snapshot(): ReadonlyArray<RegisteredTab> {
    return [...this.tabs].map(([tabId, entry]) => ({
      tabId,
      visibility: entry.presence.visibility,
      focused: entry.presence.focused,
    }))
  }

  /** Convenience: current tray decision over the live snapshot. */
  trayDecision(): TrayOpenAction {
    return decideTrayOpen(this.snapshot())
  }

  /** Look up the socket for a tabId (used to send the `close` command on dedup). */
  socketFor(tabId: string): S | undefined {
    return this.tabs.get(tabId)?.socket
  }

  /** Fan a server message out to every connected tab (feed broadcast). */
  broadcast(message: LiveFeedServerMessage): void {
    const data = JSON.stringify(message)
    for (const entry of this.tabs.values()) entry.socket.send(data)
  }

  get size(): number {
    return this.tabs.size
  }
}

/**
 * The app-level presence registry singleton (one per sidecar). `run-server`'s
 * live-feed wiring registers tabs here via the WS handler, and the tray-open
 * endpoint reads it to decide the single-tab action. A module singleton (like the
 * settings event bus) so both the WS route and the `/_internal/tray-open` route
 * see the same open-tab set. Tests construct their own `PresenceRegistry`.
 */
export const presenceRegistry = new PresenceRegistry()

/** What the tray-open endpoint tells the native shell to do after orchestrating. */
export interface TrayOpenOutcome {
  /** True → the shell opens one fresh foreground tab; false → a visible tab exists. */
  readonly open: boolean
}

/**
 * Run the single-tab tray-open decision (spec §1.2) over a registry: a visible tab
 * → no-op; only buried tabs → command each to self-close over the WS, then tell the
 * shell to open one fresh tab; no tabs → open one. The "open a tab" half is the
 * native shell's job (it has the browser); this owns the "close stale tabs" half.
 */
export function orchestrateTrayOpen(
  registry: PresenceRegistry,
): TrayOpenOutcome {
  const decision = registry.trayDecision()
  if (decision.kind === "noop") return { open: false }
  if (decision.kind === "close-then-open") {
    const closeFrame: LiveFeedServerMessage = { type: "close" }
    const data = JSON.stringify(closeFrame)
    for (const tabId of decision.closeTabIds) {
      registry.socketFor(tabId)?.send(data)
    }
  }
  return { open: true }
}
