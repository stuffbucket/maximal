import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import { BRIDGE_CHANNELS } from '../shared/bridge-channels'
import type { MaximalBridge } from './index'

const { exposeInMainWorld, invoke, on, off } = vi.hoisted(() => ({
  exposeInMainWorld: vi.fn(),
  invoke: vi.fn(() => Promise.resolve(undefined)),
  on: vi.fn(),
  off: vi.fn(),
}))

vi.mock('electron', () => ({
  contextBridge: { exposeInMainWorld },
  ipcRenderer: { invoke, on, off },
}))

let bridge: MaximalBridge

beforeAll(async () => {
  await import('./index.js')
  expect(exposeInMainWorld).toHaveBeenCalledTimes(1)
  bridge = exposeInMainWorld.mock.calls[0]?.[1] as MaximalBridge
})

beforeEach(() => {
  invoke.mockClear()
  on.mockClear()
  off.mockClear()
})

describe('preload bridge allowlist', () => {
  it('exposes exactly the documented deep key set', () => {
    expect(Object.keys(bridge).sort()).toEqual([
      'control',
      'getCoreStatus',
      'getProxyUrl',
      'onCoreStatus',
      'openExternal',
    ])
    expect(Object.keys(bridge.control).sort()).toEqual([
      'accountsList',
      'accountsSwitch',
      'authCancel',
      'authSignOut',
      'authStart',
      'authStatus',
      'onChange',
    ])
    expect(bridge).not.toHaveProperty('getCoreOrigin')
  })

  it('delegates every invoke method to its one named channel', async () => {
    await bridge.getCoreStatus()
    await bridge.getProxyUrl()
    await bridge.openExternal('https://github.com/login/device')
    await bridge.control.authStatus()
    await bridge.control.authStart()
    await bridge.control.authCancel()
    await bridge.control.authSignOut()
    await bridge.control.accountsList()
    await bridge.control.accountsSwitch('github.com:octocat')

    expect(invoke.mock.calls).toEqual([
      [BRIDGE_CHANNELS.lifecycleCurrent],
      [BRIDGE_CHANNELS.proxyUrl],
      [BRIDGE_CHANNELS.openExternal, 'https://github.com/login/device'],
      [BRIDGE_CHANNELS.authStatus],
      [BRIDGE_CHANNELS.authStart],
      [BRIDGE_CHANNELS.authCancel],
      [BRIDGE_CHANNELS.authSignOut],
      [BRIDGE_CHANNELS.accountsList],
      [BRIDGE_CHANNELS.accountsSwitch, 'github.com:octocat'],
    ])
  })

  it('wraps lifecycle payloads and removes only its own listener', () => {
    const listener = vi.fn()
    const unsubscribe = bridge.onCoreStatus(listener)
    const handler = on.mock.calls[0]?.[1] as (
      event: unknown,
      status: { phase: 'starting' },
    ) => void

    handler({ raw: 'electron-event' }, { phase: 'starting' })
    expect(listener).toHaveBeenCalledWith({ phase: 'starting' })

    unsubscribe()
    expect(on).toHaveBeenCalledWith(
      BRIDGE_CHANNELS.lifecycleChanged,
      handler,
    )
    expect(off).toHaveBeenCalledWith(
      BRIDGE_CHANNELS.lifecycleChanged,
      handler,
    )
    expect(invoke).not.toHaveBeenCalled()
  })

  it('wraps payload-free control changes and unsubscribes locally', () => {
    const listener = vi.fn()
    const unsubscribe = bridge.control.onChange(listener)
    const handler = on.mock.calls[0]?.[1] as () => void

    handler()
    expect(listener).toHaveBeenCalledTimes(1)

    unsubscribe()
    expect(on).toHaveBeenCalledWith(BRIDGE_CHANNELS.controlChanged, handler)
    expect(off).toHaveBeenCalledWith(BRIDGE_CHANNELS.controlChanged, handler)
    expect(invoke).not.toHaveBeenCalled()
  })
})
