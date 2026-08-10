import type { AuthStatus } from '@stuffbucket/maximal-core/settings-types'
import { describe, expect, it, vi } from 'vitest'

import type { MaximalBridge } from '../../preload'
import type {
  ControlResult,
  LifecycleStatus,
} from '../../shared/bridge-types'
import {
  createAuthCapability,
  createCoreLifecycleCapability,
} from './capabilities'

const authStatus: AuthStatus = { state: 'unauthenticated' }

function success<T>(value: T): ControlResult<T> {
  return { ok: true, value }
}

function fakeAuthBridge(): Pick<MaximalBridge, 'control' | 'openExternal'> {
  return {
    openExternal: vi.fn(async () => {}),
    control: {
      authStatus: vi.fn(async () => success(authStatus)),
      authStart: vi.fn(async () => success(authStatus)),
      authCancel: vi.fn(async () => success(authStatus)),
      authSignOut: vi.fn(async () => success(null)),
      accountsList: vi.fn(async () =>
        success({ accounts: [], active_key: null }),
      ),
      accountsSwitch: vi.fn(async () => success(null)),
      onChange: vi.fn(() => () => {}),
    },
  }
}

describe('createAuthCapability', () => {
  it('delegates through named bridge operations and subscriptions', async () => {
    const bridge = fakeAuthBridge()
    const auth = createAuthCapability(bridge)

    expect(auth.kind).toBe('main-bridge')
    await expect(auth.status()).resolves.toEqual(authStatus)
    await expect(auth.start()).resolves.toEqual(authStatus)
    await expect(auth.signOut()).resolves.toBeUndefined()

    const onEvent = vi.fn()
    auth.subscribe(onEvent)
    expect(bridge.control.onChange).toHaveBeenCalledWith(onEvent)

    await auth.openExternal('https://github.com/login/device')
    expect(bridge.openExternal).toHaveBeenCalledWith(
      'https://github.com/login/device',
    )
  })
})

function deferred<T>(): {
  promise: Promise<T>
  resolve(value: T): void
} {
  let resolvePromise!: (value: T) => void
  return {
    promise: new Promise((resolve) => {
      resolvePromise = resolve
    }),
    resolve: resolvePromise,
  }
}

function fakeLifecycleBridge(
  seed: Promise<LifecycleStatus> = Promise.resolve({ phase: 'starting' }),
): {
  bridge: Pick<MaximalBridge, 'onCoreStatus' | 'getCoreStatus'>
  emit(status: LifecycleStatus): void
  listenerCount(): number
} {
  const listeners = new Set<(status: LifecycleStatus) => void>()
  return {
    bridge: {
      getCoreStatus: vi.fn(() => seed),
      onCoreStatus: vi.fn((listener) => {
        listeners.add(listener)
        return () => listeners.delete(listener)
      }),
    },
    emit(status) {
      for (const listener of listeners) listener(status)
    },
    listenerCount: () => listeners.size,
  }
}

describe('createCoreLifecycleCapability', () => {
  it('narrows lifecycle fields and keeps one bounded bridge listener', () => {
    const { bridge, emit, listenerCount } = fakeLifecycleBridge()
    const lifecycle = createCoreLifecycleCapability(bridge)
    const onChange = vi.fn()
    const unsubscribe = lifecycle.subscribe(onChange)

    expect(listenerCount()).toBe(1)
    emit({ phase: 'boot-status', message: 'Downloading model index…' })
    expect(onChange).toHaveBeenLastCalledWith({
      phase: 'boot-status',
      message: 'Downloading model index…',
    })

    emit({
      phase: 'crashed',
      code: 1,
      signal: null,
      attempt: 2,
      willRetry: true,
    })
    const crashed = lifecycle.current()
    expect(crashed).toEqual({ phase: 'crashed', willRetry: true })
    expect(crashed).not.toHaveProperty('code')
    expect(crashed).not.toHaveProperty('signal')
    expect(crashed).not.toHaveProperty('attempt')

    unsubscribe()
    for (let index = 0; index < 5; index += 1) {
      lifecycle.subscribe(vi.fn())()
    }
    expect(listenerCount()).toBe(1)
  })

  it('delivers the current phase immediately to a late subscriber', () => {
    const { bridge, emit } = fakeLifecycleBridge()
    const lifecycle = createCoreLifecycleCapability(bridge)
    emit({
      phase: 'ready',
      proxyUrl: 'http://127.0.0.1:4141',
      pid: 99,
    })

    const onChange = vi.fn()
    lifecycle.subscribe(onChange)
    expect(onChange).toHaveBeenCalledWith({ phase: 'ready' })
  })

  it('does not let a late seed overwrite a newer live transition', async () => {
    const seed = deferred<LifecycleStatus>()
    const { bridge, emit } = fakeLifecycleBridge(seed.promise)
    const lifecycle = createCoreLifecycleCapability(bridge)

    emit({
      phase: 'ready',
      proxyUrl: 'http://127.0.0.1:4141',
      pid: 99,
    })
    seed.resolve({ phase: 'starting' })
    await seed.promise
    await Promise.resolve()

    expect(lifecycle.current()).toEqual({ phase: 'ready' })
  })

  it('disposes its one app bridge listener', () => {
    const { bridge, listenerCount } = fakeLifecycleBridge()
    const lifecycle = createCoreLifecycleCapability(bridge)
    expect(listenerCount()).toBe(1)

    lifecycle.dispose()
    expect(listenerCount()).toBe(0)
  })
})
