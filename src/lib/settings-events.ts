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

import type { AuthStatus } from "./settings-types"

import { EventBus } from "./event-bus"

export interface SettingsEventMap {
  /** The full new auth status, identical to GET /settings/api/auth/github/status. */
  "auth.changed": AuthStatus
}

export type SettingsEventName = keyof SettingsEventMap

export const settingsEventBus = new EventBus<SettingsEventMap>()
