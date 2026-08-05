import { contextBridge, ipcRenderer } from 'electron'

// The bridge exposes ONLY native powers + the core control-plane origin.
// It is NOT a proxy to core: the renderer talks to core's control plane directly
// over HTTP + SSE using the injected origin (ADR-0023, stuffbucket/maximal).
const bridge = {
  /** The origin of maximal-core's control plane, for direct HTTP+SSE calls. */
  getCoreOrigin: (): Promise<string> => ipcRenderer.invoke('core:origin'),
  /** Base URL where `/v1` is served for external programs (to display/copy). */
  getProxyUrl: (): Promise<string> => ipcRenderer.invoke('core:proxy-url'),
  /** Open a URL in the user's default browser (device-flow verification, etc.). */
  openExternal: (url: string): Promise<void> => ipcRenderer.invoke('native:open-external', url),
}

contextBridge.exposeInMainWorld('maximal', bridge)

export type MaximalBridge = typeof bridge
