import { ControlRpcError } from '@stuffbucket/maximal-core/client'
import { SUPPORTED_PROTOCOL_VERSION } from '@stuffbucket/maximal-core/contract'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { createControlSession } from './control-session'
import type { CoreStatus } from './core'

const originOne = 'http://127.0.0.1:50001'
const originTwo = 'http://127.0.0.1:50002'
const authStatus = { state: 'unauthenticated' } as const
const accounts = { accounts: [], active_key: null }

function discovery(overrides: Record<string, unknown> = {}): unknown {
  return {
    protocolVersion: SUPPORTED_PROTOCOL_VERSION,
    capabilities: {
      methods: [
        'auth/status',
        'auth/start',
        'auth/cancel',
        'auth/signOut',
        'accounts/list',
        'accounts/switch',
        'subscriptions/listen',
      ],
      feed: true,
    },
    identity: { name: 'maximal-core', version: '0.6.3' },
    ...overrides,
  }
}

class FakeClient {
  readonly calls: Array<{ method: string; params?: unknown }> = []
  readonly listeners = new Set<() => void>()
  readonly staleListeners = new Set<() => void>()
  readonly responses = new Map<string, unknown>()
  connected = 0
  closed = 0

  constructor(entries: Record<string, unknown>) {
    for (const [method, response] of Object.entries(entries)) {
      this.responses.set(method, response)
    }
  }

  async call<T>(method: string, params?: unknown): Promise<T> {
    this.calls.push({ method, ...(params === undefined ? {} : { params }) })
    const response = this.responses.get(method)
    if (response instanceof Error) throw response
    return response as T
  }

  onState(listener: () => void): () => void {
    this.listeners.add(listener)
    this.staleListeners.add(listener)
    listener()
    return () => this.listeners.delete(listener)
  }

  emit(): void {
    for (const listener of this.listeners) listener()
  }

  emitStale(): void {
    for (const listener of this.staleListeners) listener()
  }

  async connect(): Promise<void> {
    this.connected += 1
  }

  close(): void {
    this.closed += 1
  }
}

interface HarnessOptions {
  origins?: string[]
  clients: FakeClient[]
}

function createHarness({ origins = [originOne], clients }: HarnessOptions) {
  let originIndex = 0
  let lifecycleListener: ((status: CoreStatus) => void) | null = null
  const onChange = vi.fn()
  const stopLifecycle = vi.fn()
  const logError = vi.fn()
  let clientIndex = 0

  const session = createControlSession({
    awaitOrigin: async () => origins[originIndex] ?? origins.at(-1) ?? originOne,
    onLifecycle: (listener) => {
      lifecycleListener = listener
      return stopLifecycle
    },
    createClient: () => {
      const client = clients[clientIndex]
      clientIndex += 1
      if (!client) throw new Error('unexpected client construction')
      return client
    },
    onChange,
    logError,
  })

  return {
    session,
    onChange,
    stopLifecycle,
    logError,
    clientCount: () => clientIndex,
    ready(origin: string, proxyUrl = 'http://127.0.0.1:4141') {
      originIndex = origins.indexOf(origin)
      if (originIndex < 0) originIndex = origins.length - 1
      lifecycleListener?.({
        phase: 'ready',
        controlOrigin: origin,
        proxyUrl,
        pid: 42,
      })
    },
  }
}

function fullLiveClient(
  overrides: Record<string, unknown> = {},
): FakeClient {
  return new FakeClient({
    'auth/status': authStatus,
    'auth/start': authStatus,
    'auth/cancel': authStatus,
    'auth/signOut': { ok: true },
    'accounts/list': accounts,
    'accounts/switch': { ok: true, key: 'github.com:octocat' },
    ...overrides,
  })
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('control discovery', () => {
  it.each([
    ['wrong protocol', discovery({ protocolVersion: '999' })],
    [
      'wrong identity',
      discovery({ identity: { name: 'other-process', version: '1.0.0' } }),
    ],
    [
      'missing required method',
      discovery({
        capabilities: {
          methods: ['auth/status', 'auth/start', 'auth/signOut'],
          feed: true,
        },
      }),
    ],
    [
      'missing feed',
      discovery({
        capabilities: {
          methods: [
            'auth/status',
            'auth/start',
            'auth/signOut',
            'subscriptions/listen',
          ],
          feed: false,
        },
      }),
    ],
  ])('rejects %s as unsupported', async (_label, response) => {
    const discover = new FakeClient({ 'server/discover': response })
    const harness = createHarness({ clients: [discover] })

    await expect(harness.session.authStatus()).resolves.toMatchObject({
      ok: false,
      error: { reason: 'unsupported_version', retryable: false },
    })
    expect(discover.closed).toBe(1)
  })
})

describe('named control operations', () => {
  it('dispatches only the six allowed wire methods and validates results', async () => {
    const discover = new FakeClient({ 'server/discover': discovery() })
    const live = fullLiveClient()
    const harness = createHarness({ clients: [discover, live] })

    await expect(harness.session.authStatus()).resolves.toEqual({
      ok: true,
      value: authStatus,
    })
    await expect(harness.session.authStart()).resolves.toEqual({
      ok: true,
      value: authStatus,
    })
    await expect(harness.session.authCancel()).resolves.toEqual({
      ok: true,
      value: authStatus,
    })
    await expect(harness.session.authSignOut()).resolves.toEqual({
      ok: true,
      value: null,
    })
    await expect(harness.session.accountsList()).resolves.toEqual({
      ok: true,
      value: accounts,
    })
    await expect(
      harness.session.accountsSwitch('github.com:octocat'),
    ).resolves.toEqual({ ok: true, value: null })

    expect(live.calls).toEqual([
      { method: 'auth/status' },
      { method: 'auth/start' },
      { method: 'auth/cancel' },
      { method: 'auth/signOut' },
      { method: 'accounts/list' },
      {
        method: 'accounts/switch',
        params: { key: 'github.com:octocat' },
      },
    ])
    expect(live.connected).toBe(1)
  })

  it('returns unsupported for an absent optional method without a wire call', async () => {
    const discover = new FakeClient({
      'server/discover': discovery({
        capabilities: {
          methods: [
            'auth/status',
            'auth/start',
            'auth/signOut',
            'subscriptions/listen',
          ],
          feed: true,
        },
      }),
    })
    const live = fullLiveClient()
    const harness = createHarness({ clients: [discover, live] })

    await expect(harness.session.authCancel()).resolves.toEqual({
      ok: false,
      error: {
        reason: 'unsupported',
        message: 'maximal-core does not advertise auth/cancel',
        retryable: false,
      },
    })
    expect(live.calls).toEqual([])
  })

  it('maps invalid operation results to a non-retryable internal failure', async () => {
    const discover = new FakeClient({ 'server/discover': discovery() })
    const live = fullLiveClient({ 'accounts/list': { accounts: 'invalid' } })
    const harness = createHarness({ clients: [discover, live] })

    await expect(harness.session.accountsList()).resolves.toMatchObject({
      ok: false,
      error: { reason: 'internal', retryable: false },
    })
  })
})

describe('control failures', () => {
  it('preserves every published ControlRpcError field', async () => {
    const discover = new FakeClient({ 'server/discover': discovery() })
    const live = fullLiveClient({
      'auth/status': new ControlRpcError(1002, 'Accept updated terms', {
        reason: 'auth_fatal',
        retryable: false,
        requestId: 'req-123',
        remediationUrl: 'https://example.test/remediate',
      }),
    })
    const harness = createHarness({ clients: [discover, live] })

    await expect(harness.session.authStatus()).resolves.toEqual({
      ok: false,
      error: {
        reason: 'auth_fatal',
        message: 'Accept updated terms',
        retryable: false,
        code: 1002,
        requestId: 'req-123',
        remediationUrl: 'https://example.test/remediate',
      },
    })
  })

  it('preserves a transport error message verbatim', async () => {
    const discover = new FakeClient({ 'server/discover': discovery() })
    const live = fullLiveClient({
      'auth/status': new TypeError('fetch failed: ECONNREFUSED'),
    })
    const harness = createHarness({ clients: [discover, live] })

    await expect(harness.session.authStatus()).resolves.toEqual({
      ok: false,
      error: {
        reason: 'transport',
        message: 'fetch failed: ECONNREFUSED',
        retryable: true,
      },
    })
  })
})

describe('sidecar generations', () => {
  it('reuses one client for the same origin and replaces it once for a new origin', async () => {
    const discoverOne = new FakeClient({ 'server/discover': discovery() })
    const liveOne = fullLiveClient()
    const discoverTwo = new FakeClient({ 'server/discover': discovery() })
    const liveTwo = fullLiveClient()
    const harness = createHarness({
      origins: [originOne, originTwo],
      clients: [discoverOne, liveOne, discoverTwo, liveTwo],
    })

    await harness.session.authStatus()
    expect(harness.clientCount()).toBe(2)
    expect(harness.onChange).toHaveBeenCalledTimes(1)

    harness.ready(originOne)
    await harness.session.authStatus()
    expect(harness.clientCount()).toBe(2)

    harness.ready(originTwo)
    await harness.session.authStatus()
    expect(harness.clientCount()).toBe(4)
    expect(liveOne.closed).toBe(1)
    expect(liveTwo.connected).toBe(1)
    expect(harness.onChange).toHaveBeenCalledTimes(2)

    liveOne.emitStale()
    expect(harness.onChange).toHaveBeenCalledTimes(2)
    liveTwo.emit()
    expect(harness.onChange).toHaveBeenCalledTimes(3)
  })

  it('disposes the lifecycle listener and live client once', async () => {
    const discover = new FakeClient({ 'server/discover': discovery() })
    const live = fullLiveClient()
    const harness = createHarness({ clients: [discover, live] })

    await harness.session.authStatus()
    harness.session.dispose()
    harness.session.dispose()

    expect(harness.stopLifecycle).toHaveBeenCalledTimes(1)
    expect(live.closed).toBe(1)
    live.emitStale()
    expect(harness.onChange).toHaveBeenCalledTimes(1)
  })
})
