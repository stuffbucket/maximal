// The shell seam. Today a minimal inline Electron shell; it is shaped like
// maximal-electron's future `runMain(runtime, options)` (maximal-electron#22) so
// swapping to that dependency is a localized change. The shell knows nothing
// maximal-specific — the client injects everything through `options`.
import { BrowserWindow } from 'electron'

export interface ShellOptions {
  preloadPath: string
  windowTitle: string
  width: number
  height: number
  /** Load the renderer (dev-server URL or built index.html) into the window. */
  loadRenderer: (win: BrowserWindow) => void
}

export function runShell(options: ShellOptions): BrowserWindow {
  const win = new BrowserWindow({
    width: options.width,
    height: options.height,
    title: options.windowTitle,
    webPreferences: {
      preload: options.preloadPath,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  })
  options.loadRenderer(win)
  return win
}
