/**
 * Settings event bus (ADR-0007) — the producer side of the shell's live
 * update channel. Replaces the shell's per-section poll loops: instead of
 * the Tauri webview re-fetching `/settings/api/*` every couple of seconds,
 * the sidecar pushes a typed event the instant observable state changes and
 * the shell renders it.
 *
 * This module is intentionally tiny and dependency-light (only the generic
 * EventBus + the wire types) so producers across the codebase can publish
 * without importing the SSE route or the shell. The SSE adapter in
 * `src/routes/settings/events.ts` is the sole consumer; it subscribes here
 * and writes each event out to the connected shell.
 *
 * Initial scope is `auth.changed` (the sign-in smoothness win). The map is
 * shaped to grow — accounts.changed, apps.changed, clients.changed,
 * upstream.rejection, boot.state — per ADR-0007's event list, each payload
 * being the same shape its corresponding GET endpoint returns.
 */

import type { AuthStatus } from "~/lib/config/settings-types"

import { EventBus } from "~/lib/runtime-state/event-bus"

export interface SettingsEventMap {
  /** The full new auth status, identical to GET /settings/api/auth/github/status. */
  "auth.changed": AuthStatus
}

export const settingsEventBus = new EventBus<SettingsEventMap>()

/**
 * Projector indirection (cycle-breaker). The canonical `AuthStatus` is built
 * by `auth-controller.getAuthStatus()`, which imports `state`. But `state`
 * itself needs to emit `auth.changed` when the upstream-rejection sidecar
 * changes mid-session (that field rides on the auth status). A direct
 * `state → auth-controller` import would be a cycle, so instead the
 * controller registers its projector here at module load, and ANY producer
 * (the controller's own transitions, or state.ts on a rejection change)
 * calls `emitAuthChanged()` to publish the current snapshot.
 *
 * No-op until the projector is registered (e.g. a rejection recorded before
 * the controller module has loaded) — best-effort, never throws.
 */
let authStatusProjector: (() => AuthStatus) | null = null

export function registerAuthStatusProjector(project: () => AuthStatus): void {
  authStatusProjector = project
}

export function emitAuthChanged(): void {
  if (authStatusProjector) {
    settingsEventBus.publish("auth.changed", authStatusProjector())
  }
}

/**
 * Publish a ONE-SHOT `auth.changed` carrying the transient
 * `notify_on_reconnect` flag on top of the current projected status. Used by the
 * network-recovery path: the sidecar can't fire an OS notification directly (the
 * Tauri shell owns native notifications and reads them off this payload — same
 * model as `last_upstream_rejection`), so recovery from a long outage rides a
 * single event with `notify_on_reconnect: true` and the shell fires the toast.
 *
 * The flag lives ONLY on this emitted event — `getAuthStatus()` (and thus the
 * GET endpoint + every other `auth.changed`) never carries it, so steady state
 * and the initial SSE snapshot stay clean and the shell can't re-fire on a
 * reconnect it already handled. Best-effort: no subscriber → no-op.
 */
export function emitAuthChangedWithReconnect(): void {
  if (!authStatusProjector) return
  const status = authStatusProjector()
  // The transient flag only makes sense on the two variants that carry the
  // network signal; other states can't be in a recovering-from-outage moment.
  if (status.state === "authenticated" || status.state === "unauthenticated") {
    settingsEventBus.publish("auth.changed", {
      ...status,
      notify_on_reconnect: true,
    })
    return
  }
  settingsEventBus.publish("auth.changed", status)
}
