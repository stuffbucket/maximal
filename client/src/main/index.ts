import { join } from 'node:path'

import { app, BrowserWindow, ipcMain, shell } from 'electron'

import { BRIDGE_CHANNELS } from '../shared/bridge-channels.js'
import { createControlSession, type ControlSession } from './control-session.js'
import {
  type CoreStatus,
  awaitProxyUrl,
  currentCoreStatus,
  killCore,
  onCoreStatus,
  spawnCore,
} from './core.js'
import { toLifecycleStatus } from './lifecycle-status.js'
import { runShell } from './shell.js'

let controlSession: ControlSession | null = null

function openExternalUrl(url: string): Promise<void> {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return Promise.reject(new Error('External URL must be a valid HTTP(S) URL'))
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    return Promise.reject(new Error('External URL must use HTTP or HTTPS'))
  }
  return shell.openExternal(url)
}

function registerIpc(session: ControlSession): void {
  ipcMain.handle(BRIDGE_CHANNELS.lifecycleCurrent, () =>
    toLifecycleStatus(currentCoreStatus()),
  )
  ipcMain.handle(BRIDGE_CHANNELS.proxyUrl, () => awaitProxyUrl())
  ipcMain.handle(BRIDGE_CHANNELS.openExternal, (_event, url: string) =>
    openExternalUrl(url),
  )
  ipcMain.handle(BRIDGE_CHANNELS.authStatus, () => session.authStatus())
  ipcMain.handle(BRIDGE_CHANNELS.authStart, () => session.authStart())
  ipcMain.handle(BRIDGE_CHANNELS.authCancel, () => session.authCancel())
  ipcMain.handle(BRIDGE_CHANNELS.authSignOut, () => session.authSignOut())
  ipcMain.handle(BRIDGE_CHANNELS.accountsList, () => session.accountsList())
  ipcMain.handle(
    BRIDGE_CHANNELS.accountsSwitch,
    (_event, key: string) => session.accountsSwitch(key),
  )
}

function broadcast(channel: string, payload?: unknown): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.isDestroyed()) continue
    if (payload === undefined) win.webContents.send(channel)
    else win.webContents.send(channel, payload)
  }
}

/** Fan renderer-safe lifecycle transitions out to every open window. */
function broadcastCoreStatus(status: CoreStatus): void {
  broadcast(BRIDGE_CHANNELS.lifecycleChanged, toLifecycleStatus(status))
}

function loadRenderer(win: BrowserWindow): void {
  if (
    typeof MAIN_WINDOW_VITE_DEV_SERVER_URL !== 'undefined' &&
    MAIN_WINDOW_VITE_DEV_SERVER_URL
  ) {
    void win.loadURL(MAIN_WINDOW_VITE_DEV_SERVER_URL)
  } else {
    void win.loadFile(
      join(__dirname, `../renderer/${MAIN_WINDOW_VITE_NAME}/index.html`),
    )
  }
}

function createWindow(): void {
  runShell({
    preloadPath: join(__dirname, 'preload.js'),
    title: 'Maximal',
    width: 760,
    height: 620,
    loadRenderer,
  })
}

void app.whenReady().then(async () => {
  controlSession = createControlSession({
    onChange: () => broadcast(BRIDGE_CHANNELS.controlChanged),
  })
  registerIpc(controlSession)

  onCoreStatus((status) => {
    if (status.phase === 'ready') {
      console.log(
        `[maximal-client] core ready — control ${status.controlOrigin}, proxy ${status.proxyUrl}`,
      )
    }
    broadcastCoreStatus(status)
  })

  // Window first, then core, so the renderer can narrate a slow sidecar boot.
  createWindow()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })

  try {
    await spawnCore()
  } catch (error) {
    // `spawnCore()` emits a failed lifecycle state for the in-app problem screen.
    // A native blocking error dialog can prevent `app.quit()` from completing.
    console.error('[maximal-client] core failed to start:', error)
  }
})

// On macOS the sidecar is app-scoped, not window-scoped: closing every window
// leaves it alive so `activate` can reopen immediately. Other platforms quit.
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    controlSession?.dispose()
    killCore()
    app.quit()
  }
})

app.on('before-quit', () => {
  controlSession?.dispose()
  killCore()
})
