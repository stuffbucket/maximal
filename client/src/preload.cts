/**
 * Preload bridge. Exposes a narrow, named surface — the renderer can invoke
 * control methods but never learns the sidecar's port or holds a socket, so a
 * compromised page cannot reach the engine directly.
 */
const { contextBridge, ipcRenderer } = require("electron")

contextBridge.exposeInMainWorld("maximal", {
  call: (method: string, params?: unknown) =>
    ipcRenderer.invoke("control:call", method, params),
  boot: () => ipcRenderer.invoke("control:boot"),
})
