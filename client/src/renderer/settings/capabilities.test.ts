import type {
  AccountsListResponse,
  AuthStatus,
} from '@stuffbucket/maximal-core/settings-types'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { MaximalBridge } from '../../preload'
import type {
  ControlFailure,
  ControlResult,
  LifecycleStatus,
} from '../../shared/bridge-types'
import { ControlCallError } from '../shared/control-error'
import {
  createCoreSettingsCapabilities,
  createProxyUrlTracker,
} from './capabilities'

const authStatus: AuthStatus = { state: 'unauthenticated' }
const accounts: AccountsListResponse = { accounts: [], active_key: null }

function success<T>(value: T): ControlResult<T> {
  return { ok: true, value }
}

function failure<T>(error: ControlFailure): ControlResult<T> {
  return { ok: false, error }
}

function fakeBridge(): MaximalBridge {
  return {
    getCoreStatus: vi.fn(async (): Promise<LifecycleStatus> => ({
      phase: 'starting',
    })),
    getProxyUrl: vi.fn(async () => 'http://127.0.0.1:4141'),
    openExternal: vi.fn(async () => {}),
    onCoreStatus: vi.fn(() => () => {}),
    control: {
      authStatus: vi.fn(async () => success(authStatus)),
      authStart: vi.fn(async () => success(authStatus)),
      authCancel: vi.fn(async () => success(authStatus)),
      authSignOut: vi.fn(async () => success(null)),
      accountsList: vi.fn(async () => success(accounts)),
      accountsSwitch: vi.fn(async () => success(null)),
      onChange: vi.fn(() => () => {}),
    },
  }
}

beforeEach(() => {
  window.maximal = fakeBridge()
})

describe('createCoreSettingsCapabilities', () => {
  it('delegates every UI capability to its named bridge operation', async () => {
    const capabilities = createCoreSettingsCapabilities()

    expect(capabilities.kind).toBe('main-bridge')
    await expect(capabilities.account.status()).resolves.toEqual(authStatus)
    await expect(capabilities.account.start()).resolves.toEqual(authStatus)
    await expect(capabilities.account.cancel()).resolves.toEqual(authStatus)
    await expect(capabilities.account.signOut()).resolves.toBeUndefined()
    await expect(capabilities.accounts.list()).resolves.toEqual(accounts)
    await expect(
      capabilities.accounts.switchTo('github.com:octocat'),
    ).resolves.toBeUndefined()
    await expect(capabilities.connection.proxyUrl()).resolves.toBe(
      'http://127.0.0.1:4141',
    )

    expect(window.maximal.control.accountsSwitch).toHaveBeenCalledWith(
      'github.com:octocat',
    )

    const onChange = vi.fn()
    capabilities.subscribe(onChange)
    expect(window.maximal.control.onChange).toHaveBeenCalledWith(onChange)

    await capabilities.openExternal('https://github.com/login/device')
    expect(window.maximal.openExternal).toHaveBeenCalledWith(
      'https://github.com/login/device',
    )
  })

  it('reconstructs preserved bridge failure fields as a local Error', async () => {
    window.maximal.control.authStatus = vi.fn(async () =>
      failure<AuthStatus>({
        reason: 'auth_fatal',
        message: 'Accept updated terms',
        retryable: false,
        code: 1002,
        requestId: 'req-123',
        remediationUrl: 'https://example.test/remediate',
      }),
    )
    const capabilities = createCoreSettingsCapabilities()

    const error = await capabilities.account.status().catch((cause: unknown) =>
      cause,
    )
    expect(error).toBeInstanceOf(ControlCallError)
    expect(error).toMatchObject({
      message: 'Accept updated terms',
      reason: 'auth_fatal',
      retryable: false,
      code: 1002,
      requestId: 'req-123',
      remediationUrl: 'https://example.test/remediate',
    })
  })
})

describe('createProxyUrlTracker', () => {
  it('surfaces a failed seed and recovers when a later ready event arrives', async () => {
    let emitLifecycle = (_status: LifecycleStatus): void => {
      throw new Error('Lifecycle listener was not registered')
    }
    const seedError = new Error('maximal-core is not available')
    const tracker = createProxyUrlTracker(Promise.reject(seedError), {
      onCoreStatus: (listener) => {
        emitLifecycle = listener
        return () => {}
      },
    })

    await Promise.resolve()
    await expect(tracker.current()).rejects.toBe(seedError)

    emitLifecycle({
      phase: 'ready',
      proxyUrl: 'http://127.0.0.1:4142',
      pid: 42,
    })
    await expect(tracker.current()).resolves.toBe(
      'http://127.0.0.1:4142',
    )
  })

  it('keeps a newer ready value when the asynchronous seed resolves late', async () => {
    let resolveSeed!: (url: string) => void
    const seed = new Promise<string>((resolve) => {
      resolveSeed = resolve
    })
    let emitLifecycle = (_status: LifecycleStatus): void => {
      throw new Error('Lifecycle listener was not registered')
    }
    const tracker = createProxyUrlTracker(seed, {
      onCoreStatus: (listener) => {
        emitLifecycle = listener
        return () => {}
      },
    })

    emitLifecycle({
      phase: 'ready',
      proxyUrl: 'http://127.0.0.1:4142',
      pid: 42,
    })
    resolveSeed('http://127.0.0.1:4141')
    await seed
    await Promise.resolve()

    await expect(tracker.current()).resolves.toBe(
      'http://127.0.0.1:4142',
    )
  })
})
