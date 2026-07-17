import type {
  LiveFeedEvent,
  LiveFeedSnapshot,
  UsageSnapshot,
} from "~/lib/ws/feed-types"
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
import { getAuthStatus } from "~/lib/auth/auth-controller"
import { settingsEventBus } from "~/lib/config/settings-events"
import { listActiveClients } from "~/lib/http/active-clients"
import { getTokenUsageSummary } from "~/lib/token-usage"
import { getUpdateStatus } from "~/lib/update/update-check"
import { buildAccountsList } from "~/routes/settings/accounts"
import { buildAppsList } from "~/routes/settings/apps"

export interface LiveFeedHubDeps {
  readonly registry: PresenceRegistry
  /** Builds the full snapshot on demand (connect + reconnect). See `buildSnapshot`. */
  readonly buildSnapshot: () => Promise<LiveFeedSnapshot>
}

export class LiveFeedHub {
  private readonly deps: LiveFeedHubDeps
  /** Active producer unsubscribe handles; non-empty iff `start()` has run. */
  private readonly unsubscribes: Array<() => void> = []

  constructor(deps: LiveFeedHubDeps) {
    this.deps = deps
  }

  /** Subscribe to every producer and translate → `publish`. Idempotent. */
  start(): void {
    if (this.unsubscribes.length > 0) return // already started — don't double-subscribe
    // Today the only live producer is the settings event bus (`auth.changed`).
    // The other eight event types have no emitter yet (ADR-0007's bus is
    // "shaped to grow"); they are wired here as their producers land (§1.3).
    this.unsubscribes.push(
      settingsEventBus.subscribe("auth.changed", (payload) => {
        this.publish({ type: "auth.changed", payload })
      }),
    )
  }

  /** Tear down all producer subscriptions (test cleanup + sidecar restart). */
  stop(): void {
    for (const unsubscribe of this.unsubscribes) unsubscribe()
    this.unsubscribes.length = 0
  }

  /** Normalize a producer event and broadcast it to all tabs. */
  publish(event: LiveFeedEvent): void {
    this.deps.registry.broadcast({ type: "event", event })
  }

  /** The snapshot for a freshly (re)connected tab. Delegates to the injected builder. */
  snapshot(): Promise<LiveFeedSnapshot> {
    return this.deps.buildSnapshot()
  }
}

/** Map the token-usage summary to the feed's distilled usage shape (§4). */
function toUsageSnapshot(summary: {
  range: { start_utc: string; end_utc: string }
  totals: { total_tokens: number }
}): UsageSnapshot {
  return {
    periodStart: summary.range.start_utc,
    periodEnd: summary.range.end_utc,
    totalTokens: summary.totals.total_tokens,
  }
}

/**
 * Assemble the full snapshot from the same sources the individual GETs use
 * (auth, accounts, apps, clients, upstream rejection, boot, usage, update, health).
 * Pure-ish read: no mutation. This is the single place `window.__STATE__` (§1.4)
 * and the WS reconnect snapshot agree, so the first paint never disagrees with the
 * first live frame. Reuses the extracted GET builders so each field is byte-identical.
 */
export async function buildSnapshot(): Promise<LiveFeedSnapshot> {
  const auth = getAuthStatus()
  // Independent I/O — read concurrently rather than serially.
  const [accounts, apps, usageSummary, update] = await Promise.all([
    buildAccountsList(),
    buildAppsList(),
    getTokenUsageSummary("day"),
    getUpdateStatus(),
  ])
  const clients = listActiveClients()
  // The rejection sidecar already rides on the auth status (auth-controller maps
  // it to the wire shape there); read it back rather than re-map camelCase state.
  const upstreamRejection =
    ("last_upstream_rejection" in auth ?
      auth.last_upstream_rejection
    : undefined) ?? null
  return {
    auth,
    accounts,
    apps,
    clients: { clients, total: clients.length },
    upstreamRejection,
    // TODO(single-window §1.3): boot.state has no producer yet — the
    // account-switch reboot flow will set switching/failed. Default to ready.
    boot: { phase: "ready" },
    usage: toUsageSnapshot(usageSummary),
    update,
    // Coarse sidecar liveness (§1.3, distinct from the splash). The only concrete
    // "degraded" trigger today is a recent upstream rejection (§3.1); refine when a
    // dedicated health signal exists.
    health: upstreamRejection ? "degraded" : "healthy",
  }
}
