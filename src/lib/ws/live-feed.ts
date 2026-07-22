import type {
  LiveFeedEvent,
  LiveFeedSnapshot,
  UsageLastEvent,
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
import {
  getTokenUsageSummary,
  onTokenUsageRecorded,
  type PersistedTokenUsageEvent,
} from "~/lib/token-usage"
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
  /**
   * Running tally of today's usage, so a live `usage` event can carry the
   * current totals without a per-request DB query. Seeded from the `day`
   * summary at `start()`, incremented per recorded event, and re-seeded when an
   * event crosses the day boundary. Authoritative totals still come from the
   * HTTP summary the tab refetches on the event — this is the between-refetch
   * ticker (§4).
   */
  private usageToday = {
    tokens: 0,
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheCreation: 0,
    requests: 0,
    rangeStartMs: 0,
    rangeEndMs: 0,
    seeded: false,
  }

  constructor(deps: LiveFeedHubDeps) {
    this.deps = deps
  }

  /** Subscribe to every producer and translate → `publish`. Idempotent. */
  start(): void {
    if (this.unsubscribes.length > 0) return // already started — don't double-subscribe
    this.unsubscribes.push(
      settingsEventBus.subscribe("auth.changed", (payload) => {
        this.publish({ type: "auth.changed", payload })
      }),
      // Token-usage → `usage`: every recorded request becomes a live frame
      // carrying the just-recorded event (the pulse/stream, §4) plus the
      // running day totals.
      onTokenUsageRecorded((event) => {
        this.onUsageRecorded(event)
      }),
    )
    // Seed the running day totals from the store (best-effort, async).
    void this.seedUsageToday()
  }

  /** Load the authoritative day totals so the live ticker starts from truth. */
  private async seedUsageToday(): Promise<void> {
    try {
      const summary = await getTokenUsageSummary("day")
      this.usageToday = {
        tokens: summary.totals.total_tokens,
        input: summary.totals.input_tokens,
        output: summary.totals.output_tokens,
        cacheRead: summary.totals.cache_read_input_tokens,
        cacheCreation: summary.totals.cache_creation_input_tokens,
        requests: summary.totals.request_count,
        rangeStartMs: summary.range.start_ms,
        rangeEndMs: summary.range.end_ms,
        seeded: true,
      }
    } catch {
      // Leave unseeded; onUsageRecorded still increments from zero and the tab's
      // HTTP refetch supplies authoritative numbers regardless.
    }
  }

  /** Fold one recorded event into the day tally and broadcast a `usage` frame. */
  private onUsageRecorded(event: PersistedTokenUsageEvent): void {
    // Crossed into a new day (or never seeded) → resync the window + totals.
    if (
      !this.usageToday.seeded
      || event.created_at_ms >= this.usageToday.rangeEndMs
    ) {
      void this.seedUsageToday()
    }
    this.usageToday.tokens += event.total_tokens
    this.usageToday.input += event.input_tokens
    this.usageToday.output += event.output_tokens
    this.usageToday.cacheRead += event.cache_read_input_tokens
    this.usageToday.cacheCreation += event.cache_creation_input_tokens
    this.usageToday.requests += 1
    this.publish({
      type: "usage",
      payload: {
        periodStart:
          this.usageToday.rangeStartMs > 0 ?
            new Date(this.usageToday.rangeStartMs).toISOString()
          : event.created_at_utc,
        periodEnd:
          this.usageToday.rangeEndMs > 0 ?
            new Date(this.usageToday.rangeEndMs).toISOString()
          : event.created_at_utc,
        totalTokens: this.usageToday.tokens,
        inputTokens: this.usageToday.input,
        outputTokens: this.usageToday.output,
        cacheReadTokens: this.usageToday.cacheRead,
        cacheCreationTokens: this.usageToday.cacheCreation,
        requestCount: this.usageToday.requests,
        lastEvent: toUsageLastEvent(event),
      },
    })
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

/** Map the token-usage summary to the feed's distilled usage shape (§4). The
 *  (re)connect snapshot has no "last event" — that only rides live frames. */
function toUsageSnapshot(summary: {
  range: { start_utc: string; end_utc: string }
  totals: {
    total_tokens: number
    input_tokens: number
    output_tokens: number
    cache_read_input_tokens: number
    cache_creation_input_tokens: number
    request_count: number
  }
}): UsageSnapshot {
  return {
    periodStart: summary.range.start_utc,
    periodEnd: summary.range.end_utc,
    totalTokens: summary.totals.total_tokens,
    inputTokens: summary.totals.input_tokens,
    outputTokens: summary.totals.output_tokens,
    cacheReadTokens: summary.totals.cache_read_input_tokens,
    cacheCreationTokens: summary.totals.cache_creation_input_tokens,
    requestCount: summary.totals.request_count,
    lastEvent: null,
  }
}

/** Distil a persisted event to the wire `UsageLastEvent` (camelCase). */
function toUsageLastEvent(event: PersistedTokenUsageEvent): UsageLastEvent {
  return {
    model: event.model,
    source: event.source,
    providerName: event.provider_name,
    endpoint: event.endpoint,
    inputTokens: event.input_tokens,
    outputTokens: event.output_tokens,
    cacheReadTokens: event.cache_read_input_tokens,
    cacheCreationTokens: event.cache_creation_input_tokens,
    totalTokens: event.total_tokens,
    createdAtMs: event.created_at_ms,
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
