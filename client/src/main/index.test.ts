import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  BRIDGE_CHANNELS,
  INVOKE_CHANNELS,
} from '../shared/bridge-channels'

const {
  browserWindows,
  fakeApp,
  ipcMainHandle,
  onBeforeSendHeaders,
  onHeadersReceived,
  shellOpenExternal,
  webContentsSend,
} = vi.hoisted(() => {
  const listeners = new Map<string, Set<(...args: unknown[]) => void>>()
  const fakeApp = {
    isPackaged: false,
    whenReady: vi.fn(() => Promise.resolve()),
    quit: vi.fn(),
    getPath: vi.fn(() => '/tmp/maximal-client-test'),
    getAppPath: vi.fn(() => '/tmp/maximal-client-test'),
    on(event: string, listener: (...args: unknown[]) => void) {
      if (!listeners.has(event)) listeners.set(event, new Set())
      listeners.get(event)?.add(listener)
      return fakeApp
    },
    emit(event: string, ...args: unknown[]) {
      for (const listener of listeners.get(event) ?? []) listener(...args)
    },
    removeAllListeners() {
      listeners.clear()
    },
  }
  return {
    browserWindows: [] as Array<{
      isDestroyed(): boolean
      webContents: { send: ReturnType<typeof vi.fn> }
    }>,
    fakeApp,
    ipcMainHandle: vi.fn(),
    onBeforeSendHeaders: vi.fn(),
    onHeadersReceived: vi.fn(),
    shellOpenExternal: vi.fn(() => Promise.resolve()),
    webContentsSend: vi.fn(),
  }
})

vi.mock('electron', () => ({
  app: fakeApp,
  BrowserWindow: { getAllWindows: () => browserWindows },
  ipcMain: { handle: ipcMainHandle },
  // Keep spies available to prove index.ts never installs the old shim.
  session: {
    defaultSession: {
      webRequest: { onBeforeSendHeaders, onHeadersReceived },
    },
  },
  shell: { openExternal: shellOpenExternal },
}))

vi.mock('./shell.js', () => ({ runShell: vi.fn() }))

const { killCoreMock, spawnCoreMock, onCoreStatusMock } = vi.hoisted(() => ({
  killCoreMock: vi.fn(),
  spawnCoreMock: vi.fn(() =>
    Promise.resolve({ controlOrigin: '', proxyUrl: '', port: 0, pid: 0 }),
  ),
  onCoreStatusMock: vi.fn(
    (_listener: (status: unknown) => void) => vi.fn(),
  ),
}))

vi.mock('./core.js', () => ({
  awaitProxyUrl: () => Promise.resolve('http://127.0.0.1:4141'),
  currentCoreStatus: () => ({ phase: 'starting' }),
  killCore: killCoreMock,
  spawnCore: spawnCoreMock,
  onCoreStatus: onCoreStatusMock,
}))

const { createControlSessionMock, disposeControlSessionMock } = vi.hoisted(
  () => {
    const disposeControlSessionMock = vi.fn()
    return {
      disposeControlSessionMock,
      createControlSessionMock: vi.fn((_options: { onChange(): void }) => ({
        authStatus: vi.fn(),
        authStart: vi.fn(),
        authCancel: vi.fn(),
        authSignOut: vi.fn(),
        accountsList: vi.fn(),
        accountsSwitch: vi.fn(),
        dispose: disposeControlSessionMock,
      })),
    }
  },
)

vi.mock('./control-session.js', () => ({
  createControlSession: createControlSessionMock,
}))

/** Import a fresh copy of module-scope Electron lifecycle wiring per test. */
async function loadIndexOn(platform: NodeJS.Platform): Promise<void> {
  vi.resetModules()
  killCoreMock.mockClear()
  spawnCoreMock.mockClear()
  ipcMainHandle.mockClear()
  createControlSessionMock.mockClear()
  disposeControlSessionMock.mockClear()
  onBeforeSendHeaders.mockClear()
  onHeadersReceived.mockClear()
  shellOpenExternal.mockClear()
  webContentsSend.mockClear()
  browserWindows.length = 0
  fakeApp.quit.mockClear()
  fakeApp.removeAllListeners()
  Object.defineProperty(process, 'platform', {
    value: platform,
    configurable: true,
  })
  await import('./index.js')
  await Promise.resolve()
  await Promise.resolve()
}

const realPlatform = process.platform

afterEach(() => {
  Object.defineProperty(process, 'platform', {
    value: realPlatform,
    configurable: true,
  })
  vi.clearAllMocks()
})

describe('closed IPC boundary', () => {
  it('registers exactly the named invoke allowlist', async () => {
    await loadIndexOn('darwin')

    expect(ipcMainHandle.mock.calls.map(([channel]) => channel)).toEqual(
      INVOKE_CHANNELS,
    )
    expect(ipcMainHandle).not.toHaveBeenCalledWith(
      'core:origin',
      expect.anything(),
    )
    expect(ipcMainHandle.mock.calls.map(([channel]) => channel)).not.toContain(
      'maximal:control/call',
    )
  })

  it('does not install Electron webRequest header or CORS hooks', async () => {
    await loadIndexOn('darwin')

    expect(onBeforeSendHeaders).not.toHaveBeenCalled()
    expect(onHeadersReceived).not.toHaveBeenCalled()
  })

  it('broadcasts redacted lifecycle state and payload-free control invalidation', async () => {
    await loadIndexOn('darwin')
    browserWindows.push({
      isDestroyed: () => false,
      webContents: { send: webContentsSend },
    })

    const lifecycleListener = onCoreStatusMock.mock.calls[0]?.[0]
    lifecycleListener?.({
      phase: 'ready',
      controlOrigin: 'http://127.0.0.1:54321',
      proxyUrl: 'http://127.0.0.1:4141',
      pid: 42,
    })
    expect(webContentsSend).toHaveBeenCalledWith(
      BRIDGE_CHANNELS.lifecycleChanged,
      {
        phase: 'ready',
        proxyUrl: 'http://127.0.0.1:4141',
        pid: 42,
      },
    )

    createControlSessionMock.mock.calls[0]?.[0].onChange()
    expect(webContentsSend).toHaveBeenCalledWith(
      BRIDGE_CHANNELS.controlChanged,
    )
  })

  it('allows only HTTP(S) URLs through the native external opener', async () => {
    await loadIndexOn('darwin')
    const registration = ipcMainHandle.mock.calls.find(
      ([channel]) => channel === BRIDGE_CHANNELS.openExternal,
    )
    const handler = registration?.[1] as (
      event: unknown,
      url: string,
    ) => Promise<void>

    await expect(handler({}, 'file:///Applications/Utilities/Terminal.app'))
      .rejects.toThrow('External URL must use HTTP or HTTPS')
    await expect(handler({}, 'not a URL')).rejects.toThrow(
      'External URL must be a valid HTTP(S) URL',
    )
    expect(shellOpenExternal).not.toHaveBeenCalled()

    await expect(
      handler({}, 'https://github.com/login/device'),
    ).resolves.toBeUndefined()
    expect(shellOpenExternal).toHaveBeenCalledWith(
      'https://github.com/login/device',
    )
  })

  it('uses the redacted lifecycle channel rather than the legacy channel', async () => {
    await loadIndexOn('darwin')

    expect(INVOKE_CHANNELS).toContain(BRIDGE_CHANNELS.lifecycleCurrent)
    expect(INVOKE_CHANNELS).not.toContain('core:status:current')
  })
})

describe('window-all-closed / before-quit', () => {
  it('on darwin keeps core alive on window close and disposes it on real quit', async () => {
    await loadIndexOn('darwin')

    fakeApp.emit('window-all-closed')
    expect(killCoreMock).not.toHaveBeenCalled()
    expect(disposeControlSessionMock).not.toHaveBeenCalled()
    expect(fakeApp.quit).not.toHaveBeenCalled()

    fakeApp.emit('before-quit')
    expect(disposeControlSessionMock).toHaveBeenCalledTimes(1)
    expect(killCoreMock).toHaveBeenCalledTimes(1)
  })

  it('on non-darwin disposes core control before quitting', async () => {
    await loadIndexOn('win32')

    fakeApp.emit('window-all-closed')

    expect(disposeControlSessionMock).toHaveBeenCalledTimes(1)
    expect(killCoreMock).toHaveBeenCalledTimes(1)
    expect(fakeApp.quit).toHaveBeenCalledTimes(1)
  })

  it('before-quit always disposes control and kills core', async () => {
    await loadIndexOn('darwin')

    fakeApp.emit('before-quit')

    expect(disposeControlSessionMock).toHaveBeenCalledTimes(1)
    expect(killCoreMock).toHaveBeenCalledTimes(1)
  })
})
