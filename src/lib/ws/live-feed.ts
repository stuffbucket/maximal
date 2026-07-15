import type { LiveFeedEvent, LiveFeedSnapshot } from "~/lib/ws/feed-types"
import type { PresenceRegistry } from "~/lib/ws/presence-registry"

/**
 * Live-feed hub (spec §1.3) — the multi-subscriber fan-out that supersedes
 * ADR-0007's "one shell, one connection" scope. It:
 *   1. bridges producers (settingsEventBus, token-usage, update-check, boot state)
 *      into the unified `LiveFeedEvent` union, and
 *   2. broadcasts them to every connected tab via the presence registry, and
 *   3. builds the complete `LiveFeedSnapshot` sent on each (re)connect and inlined
 *      as `window.__STATE__` for instant paint (§1.4).
 *
 * Wiring note (integration point, not done here): `run-server.ts` constructs one
 * hub, calls `hub.start()` after the sidecar is up, and passes it to
 * `createWebSocketHandler` (routes/ws/route.ts).
 */
import { notImplemented } from "~/lib/dev/not-implemented"

export interface LiveFeedHubDeps {
  readonly registry: PresenceRegistry
  /** Builds the full snapshot on demand (connect + reconnect). See `buildSnapshot`. */
  readonly buildSnapshot: () => Promise<LiveFeedSnapshot>
}

export class LiveFeedHub {
  private readonly deps: LiveFeedHubDeps

  constructor(deps: LiveFeedHubDeps) {
    this.deps = deps
  }

  /** Subscribe to every producer and translate → `publish`. Idempotent. */
  start(): void {
    return notImplemented("LiveFeedHub.start")
  }

  /** Tear down all producer subscriptions (test cleanup + sidecar restart). */
  stop(): void {
    return notImplemented("LiveFeedHub.stop")
  }

  /** Normalize a producer event and broadcast it to all tabs. */
  publish(event: LiveFeedEvent): void {
    return notImplemented("LiveFeedHub.publish", { event })
  }

  /** The snapshot for a freshly (re)connected tab. Delegates to the injected builder. */
  snapshot(): Promise<LiveFeedSnapshot> {
    return this.deps.buildSnapshot()
  }
}

/**
 * Assemble the full snapshot from the same sources the individual GETs use
 * (auth, accounts, apps, clients, upstream rejection, boot, usage, update, health).
 * Pure-ish read: no mutation. This is the single place `window.__STATE__` (§1.4)
 * and the WS reconnect snapshot agree, so the first paint never disagrees with the
 * first live frame.
 */
export function buildSnapshot(): Promise<LiveFeedSnapshot> {
  return notImplemented("buildSnapshot")
}
