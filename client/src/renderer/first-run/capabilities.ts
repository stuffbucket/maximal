import type { AuthStatus } from '@stuffbucket/maximal-core/settings-types'

import type { MaximalBridge } from '../../preload'
import type { LifecycleStatus } from '../../shared/bridge-types'
import { unwrapControlResult } from '../shared/control-error'

/** Narrow UI-facing capabilities keep Electron transport out of components. */
export type { AuthStatus }

export interface AuthCapability {
  readonly kind: 'main-bridge'
  status(): Promise<AuthStatus>
  start(): Promise<AuthStatus>
  signOut(): Promise<void>
  subscribe(onEvent: () => void): () => void
  openExternal(url: string): Promise<void>
}

export function createAuthCapability(
  bridge: Pick<MaximalBridge, 'control' | 'openExternal'>,
): AuthCapability {
  return {
    kind: 'main-bridge',
    status: async () => unwrapControlResult(await bridge.control.authStatus()),
    start: async () => unwrapControlResult(await bridge.control.authStart()),
    signOut: async () => {
      unwrapControlResult(await bridge.control.authSignOut())
    },
    subscribe: (onEvent) => bridge.control.onChange(onEvent),
    openExternal: (url) => bridge.openExternal(url),
  }
}

/** Lifecycle fields needed to narrate first-run boot and recovery. */
export type BootPhase =
  | { phase: 'starting' }
  | { phase: 'boot-status'; message: string }
  | { phase: 'ready' }
  | { phase: 'crashed'; willRetry: boolean }
  | { phase: 'restarting' }
  | { phase: 'failed'; reason: string }
  | { phase: 'stopped' }

export interface CoreLifecycleCapability {
  readonly kind: 'live'
  current(): BootPhase
  subscribe(onChange: (phase: BootPhase) => void): () => void
  dispose(): void
}

function toBootPhase(status: LifecycleStatus): BootPhase {
  switch (status.phase) {
    case 'starting':
      return { phase: 'starting' }
    case 'boot-status':
      return { phase: 'boot-status', message: status.message }
    case 'ready':
      return { phase: 'ready' }
    case 'crashed':
      return { phase: 'crashed', willRetry: status.willRetry }
    case 'restarting':
      return { phase: 'restarting' }
    case 'failed':
      return { phase: 'failed', reason: status.reason }
    case 'stopped':
      return { phase: 'stopped' }
  }
}

/**
 * Seed from current lifecycle state, then fan one bridge listener out to local
 * subscribers. A live event wins over a slower seed promise.
 */
export function createCoreLifecycleCapability(
  bridge: Pick<MaximalBridge, 'onCoreStatus' | 'getCoreStatus'>,
): CoreLifecycleCapability {
  let phase: BootPhase = { phase: 'starting' }
  let seeded = false
  const listeners = new Set<(phase: BootPhase) => void>()

  function apply(status: LifecycleStatus): void {
    seeded = true
    phase = toBootPhase(status)
    for (const listener of listeners) listener(phase)
  }

  const unsubscribeBridge = bridge.onCoreStatus(apply)

  void bridge
    .getCoreStatus()
    .then((status) => {
      if (!seeded) apply(status)
    })
    .catch((error: unknown) => {
      if (!seeded) {
        apply({
          phase: 'failed',
          reason: error instanceof Error ? error.message : String(error),
        })
      }
    })

  return {
    kind: 'live',
    current: () => phase,
    dispose: unsubscribeBridge,
    subscribe(onChange) {
      listeners.add(onChange)
      onChange(phase)
      return () => {
        listeners.delete(onChange)
      }
    },
  }
}

export interface FirstRunCapabilities {
  readonly kind: 'main-bridge'
  auth: AuthCapability
  lifecycle: CoreLifecycleCapability
  dispose(): void
}

/** The single adapter in first-run that is allowed to touch `window.maximal`. */
export function createFirstRunCapabilities(): FirstRunCapabilities {
  const auth = createAuthCapability(window.maximal)
  const lifecycle = createCoreLifecycleCapability(window.maximal)
  return {
    kind: 'main-bridge',
    auth,
    lifecycle,
    dispose() {
      lifecycle.dispose()
    },
  }
}
