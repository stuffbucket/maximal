import type {
  AccountsListResponse,
  AccountSummary,
  AuthStatus,
} from '@stuffbucket/maximal-core/settings-types'

import type { MaximalBridge } from '../../preload'
import { unwrapControlResult } from '../shared/control-error'

export type { AccountsListResponse, AccountSummary, AuthStatus }

/** Narrow UI contract; Electron transport stays inside this adapter. */
export interface SettingsCapabilities {
  readonly kind: 'main-bridge'
  subscribe(onChange: () => void): () => void
  account: {
    status(): Promise<AuthStatus>
    start(): Promise<AuthStatus>
    cancel(): Promise<AuthStatus>
    signOut(): Promise<void>
  }
  accounts: {
    list(): Promise<AccountsListResponse>
    switchTo(key: string): Promise<void>
  }
  connection: {
    /** Base URL where /v1 is served for external programs (to display/copy). */
    proxyUrl(): Promise<string>
  }
  openExternal(url: string): Promise<void>
}

/**
 * Track the public proxy URL across sidecar restarts. A ready event is newer
 * than the asynchronous seed and must not be overwritten when that seed lands.
 */
export function createProxyUrlTracker(
  initialProxyUrlPromise: Promise<string>,
  bridge: Pick<MaximalBridge, 'onCoreStatus'>,
): { current(): Promise<string> } {
  let seeded = false
  let value = ''
  let hasError = false
  let error: unknown
  let waiters: Array<{
    resolve(url: string): void
    reject(cause: unknown): void
  }> = []

  function setValue(url: string): void {
    seeded = true
    value = url
    hasError = false
    error = undefined
    const pending = waiters
    waiters = []
    for (const waiter of pending) waiter.resolve(url)
  }

  function setError(cause: unknown): void {
    if (seeded) return
    hasError = true
    error = cause
    const pending = waiters
    waiters = []
    for (const waiter of pending) waiter.reject(cause)
  }

  bridge.onCoreStatus((status) => {
    if (status.phase === 'ready') setValue(status.proxyUrl)
  })

  void initialProxyUrlPromise.then(
    (url) => {
      if (!seeded && url) setValue(url)
    },
    (cause: unknown) => setError(cause),
  )

  return {
    current: () => {
      if (seeded) return Promise.resolve(value)
      if (hasError) return Promise.reject(error)
      return new Promise((resolve, reject) =>
        waiters.push({ resolve, reject }),
      )
    },
  }
}

/** The single Settings adapter allowed to touch `window.maximal`. */
export function createCoreSettingsCapabilities(): SettingsCapabilities {
  const bridge = window.maximal
  const proxyUrlTracker = createProxyUrlTracker(
    bridge.getProxyUrl(),
    bridge,
  )

  return {
    kind: 'main-bridge',
    subscribe: (onChange) => bridge.control.onChange(onChange),
    account: {
      status: async () =>
        unwrapControlResult(await bridge.control.authStatus()),
      start: async () =>
        unwrapControlResult(await bridge.control.authStart()),
      cancel: async () =>
        unwrapControlResult(await bridge.control.authCancel()),
      signOut: async () => {
        unwrapControlResult(await bridge.control.authSignOut())
      },
    },
    accounts: {
      list: async () =>
        unwrapControlResult(await bridge.control.accountsList()),
      switchTo: async (key) => {
        unwrapControlResult(await bridge.control.accountsSwitch(key))
      },
    },
    connection: {
      proxyUrl: () => proxyUrlTracker.current(),
    },
    openExternal: (url) => bridge.openExternal(url),
  }
}
