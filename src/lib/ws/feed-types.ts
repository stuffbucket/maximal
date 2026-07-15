/**
 * The unified live-feed wire contract (spec §1.3).
 *
 * One Bun-native WebSocket replaces three transports (SSE `/settings/api/events`,
 * the Tauri `Channel` `subscribe_token_usage`, and Rust `emit`). It MUST carry
 * every event ADR-0007's SSE defined — auth/accounts/apps/clients/upstream/boot —
 * plus the new usage/update/health events, or the ported sections orphan when the
 * polling shell is deleted.
 *
 * NOTE: reuses the existing Zod-inferred response types so each event payload is
 * byte-identical to the matching GET (ADR-0007's "payload = the GET's shape").
 */
// Relative (not `~/`) import: this file is imported by BOTH the sidecar and the
// shell tree, and the shell tsconfig has no `~/` path mapping. settings-types
// only depends on `zod`, so it is safe to pull into the shell graph (as
// shell/src/proxy/client.ts already does).
import type {
  AccountsListResponse,
  AppsListResponse,
  AuthStatus,
  UpdateStatusResponse,
  UpstreamRejection,
} from "../config/settings-types"

/**
 * One active API client. Structural mirror of `ActiveClient`
 * (src/lib/http/active-clients.ts) — declared locally rather than imported so the
 * shell graph doesn't pull in that stateful module. TODO(single-window §11):
 * unify with a Zod `ActiveApiClientsResponse` in settings-types.
 */
export interface ActiveApiClient {
  readonly key: string
  readonly label: string
  readonly userAgent: string
  readonly ageSeconds: number
}

/**
 * The `/settings/api/clients` response has no named type today (returned inline
 * as `{ clients, total }`). Declared here for the feed.
 */
export interface ActiveApiClientsResponse {
  readonly clients: ReadonlyArray<ActiveApiClient>
  readonly total: number
}

/** Account-switch reboot transitions (ADR-0007 `boot.state`). */
export type BootState =
  | { readonly phase: "switching"; readonly toAccountId: string }
  | { readonly phase: "ready" }
  | { readonly phase: "failed"; readonly reason: string }

/** Usage rollup that drives the ported Usage section live (replaces the Rust Channel). */
export interface UsageSnapshot {
  // TODO(single-window §4): mirror the `/token-usage` response shape exactly so
  // the ported Usage island renders from this without a second fetch.
  readonly periodStart: string
  readonly periodEnd: string
  readonly totalTokens: number
}

/** Update-available signal, sourced from the Phase-6 `update-check.ts` detector (§8). */
export interface LatestUpdate {
  readonly version: string
  readonly url: string
}

/** Coarse sidecar liveness for the in-page health affordance (distinct from the splash). */
export type SidecarHealth = "healthy" | "degraded"

/**
 * A single live event. Discriminated on `type`; each `payload` matches its GET.
 * The nine members are the full contract — dropping any orphans a UI section.
 */
export type LiveFeedEvent =
  | { readonly type: "auth.changed"; readonly payload: AuthStatus }
  | {
      readonly type: "accounts.changed"
      readonly payload: AccountsListResponse
    }
  | { readonly type: "apps.changed"; readonly payload: AppsListResponse }
  | {
      readonly type: "clients.changed"
      readonly payload: ActiveApiClientsResponse
    }
  | {
      readonly type: "upstream.rejection"
      readonly payload: UpstreamRejection | null
    }
  | { readonly type: "boot.state"; readonly payload: BootState }
  | { readonly type: "usage"; readonly payload: UsageSnapshot }
  | { readonly type: "update-available"; readonly payload: LatestUpdate }
  | { readonly type: "sidecar-health"; readonly payload: SidecarHealth }

export type LiveFeedEventType = LiveFeedEvent["type"]

/** Every event type that must be present — the enumeration test asserts against this. */
export const LIVE_FEED_EVENT_TYPES = [
  "auth.changed",
  "accounts.changed",
  "apps.changed",
  "clients.changed",
  "upstream.rejection",
  "boot.state",
  "usage",
  "update-available",
  "sidecar-health",
] as const satisfies ReadonlyArray<LiveFeedEventType>

/**
 * The complete snapshot sent on every (re)connect (spec §1.3 "a complete snapshot
 * on (re)connect so a resumed tab resyncs without a poll"). This is ALSO the shape
 * inlined into the served HTML as `window.__STATE__` for instant paint (§1.4), so
 * the first frame and the first WS frame agree.
 */
export interface LiveFeedSnapshot {
  readonly auth: AuthStatus
  readonly accounts: AccountsListResponse
  readonly apps: AppsListResponse
  readonly clients: ActiveApiClientsResponse
  readonly upstreamRejection: UpstreamRejection | null
  readonly boot: BootState
  readonly usage: UsageSnapshot
  readonly update: UpdateStatusResponse
  readonly health: SidecarHealth
}

/**
 * The state inlined into the served HTML as `window.__STATE__` for instant paint
 * (§1.4): the full snapshot plus a few first-paint-only extras. Declared here (with
 * the snapshot) so BOTH the sidecar's `buildInlineUiState` (routes/ui/inline-state.ts)
 * and the shell's `readInlineState` (proxy/inline-state-client.ts) agree on the shape
 * without the shell importing the sidecar's stateful builder.
 */
export interface InlineUiState {
  /** The full live snapshot (same shape the WS sends on connect). */
  readonly snapshot: LiveFeedSnapshot
  /** The minted session token the tab uses to authenticate the WS (§6.5). */
  readonly sessionToken: string
  /** Server-persisted locale override, off localStorage (§1.4 / i18n.md). */
  readonly locale: string
  /** The discovered bound port so the client derives the WS URL (§1.1). */
  readonly boundPort: number
  /** Per-version update-banner dismissal (§3.2), server-side not localStorage. */
  readonly dismissedUpdateVersion: string | null
}

// TODO(single-window §1.3): these two frame unions cross an untrusted wire and
// feed `parseServerMessage` (live-feed-core.ts) + the inlined `window.__STATE__`.
// The repo convention for wire payloads is Zod-first (const schema + inferred
// type — see settings-types.ts) precisely so a runtime validator exists. When the
// parse/serialize bodies land, promote these to `z.discriminatedUnion("type", …)`
// so `parseServerMessage` validates against a schema instead of hand shape-checks.

/** Frames a tab may send to the sidecar (presence + liveness). */
export type LiveFeedClientMessage =
  | {
      readonly type: "hello"
      readonly tabId: string
      readonly visibility: string
    }
  | { readonly type: "visibility"; readonly visibility: string }
  | { readonly type: "pong" }

/** Frames the sidecar may send to a tab (the feed, plus tray-driven control). */
export type LiveFeedServerMessage =
  | { readonly type: "snapshot"; readonly snapshot: LiveFeedSnapshot }
  | { readonly type: "event"; readonly event: LiveFeedEvent }
  | { readonly type: "close" } // tray dedup: buried tab is told to self-close (§1.2)
  | { readonly type: "ping" }
