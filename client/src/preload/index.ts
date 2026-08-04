import { contextBridge, ipcRenderer } from 'electron'

export interface AuthStatus {
  state: 'authenticated' | 'unauthenticated' | 'device_code_issued' | 'polling' | 'error'
  user_code?: string
  verification_uri?: string
}

const api = {
  coreStatus: (): Promise<{ baseUrl: string }> => ipcRenderer.invoke('core:status'),
  authStatus: (): Promise<AuthStatus> => ipcRenderer.invoke('core:auth-status'),
  authStart: (): Promise<AuthStatus> => ipcRenderer.invoke('core:auth-start'),
  openExternal: (url: string): Promise<void> => ipcRenderer.invoke('core:open-external', url),
}

contextBridge.exposeInMainWorld('maximal', api)

export type MaximalApi = typeof api
