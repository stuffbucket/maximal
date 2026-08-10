import type {
  AccountsListResponse,
  AuthStatus,
} from '@stuffbucket/maximal-core/settings-types'
import { contextBridge, ipcRenderer } from 'electron'

import { BRIDGE_CHANNELS } from '../shared/bridge-channels.js'
import type {
  ControlResult,
  LifecycleStatus,
} from '../shared/bridge-types.js'

const bridge = {
  /** Base URL where `/v1` is served for external programs (to display/copy). */
  getProxyUrl: (): Promise<string> =>
    ipcRenderer.invoke(BRIDGE_CHANNELS.proxyUrl),
  /** Open a URL in the user's default browser (device-flow verification, etc.). */
  openExternal: (url: string): Promise<void> =>
    ipcRenderer.invoke(BRIDGE_CHANNELS.openExternal, url),
  /** Current renderer-safe sidecar lifecycle state. */
  getCoreStatus: (): Promise<LifecycleStatus> =>
    ipcRenderer.invoke(BRIDGE_CHANNELS.lifecycleCurrent),
  /** Subscribe without exposing Electron's IpcRendererEvent. */
  onCoreStatus: (
    listener: (status: LifecycleStatus) => void,
  ): (() => void) => {
    const handler = (_event: unknown, status: LifecycleStatus): void => {
      listener(status)
    }
    ipcRenderer.on(BRIDGE_CHANNELS.lifecycleChanged, handler)
    return () => {
      ipcRenderer.off(BRIDGE_CHANNELS.lifecycleChanged, handler)
    }
  },
  control: {
    authStatus: (): Promise<ControlResult<AuthStatus>> =>
      ipcRenderer.invoke(BRIDGE_CHANNELS.authStatus),
    authStart: (): Promise<ControlResult<AuthStatus>> =>
      ipcRenderer.invoke(BRIDGE_CHANNELS.authStart),
    authCancel: (): Promise<ControlResult<AuthStatus>> =>
      ipcRenderer.invoke(BRIDGE_CHANNELS.authCancel),
    authSignOut: (): Promise<ControlResult<null>> =>
      ipcRenderer.invoke(BRIDGE_CHANNELS.authSignOut),
    accountsList: (): Promise<ControlResult<AccountsListResponse>> =>
      ipcRenderer.invoke(BRIDGE_CHANNELS.accountsList),
    accountsSwitch: (key: string): Promise<ControlResult<null>> =>
      ipcRenderer.invoke(BRIDGE_CHANNELS.accountsSwitch, key),
    onChange: (listener: () => void): (() => void) => {
      const handler = (): void => {
        listener()
      }
      ipcRenderer.on(BRIDGE_CHANNELS.controlChanged, handler)
      return () => {
        ipcRenderer.off(BRIDGE_CHANNELS.controlChanged, handler)
      }
    },
  },
}

contextBridge.exposeInMainWorld('maximal', bridge)

export type MaximalBridge = typeof bridge
