import { join } from 'node:path'

import { app, BrowserWindow, ipcMain, shell } from 'electron'

import { getBaseUrl, killCore, spawnCore } from './core.js'

async function coreJson(path: string, init?: RequestInit): Promise<unknown> {
  const res = await fetch(`${getBaseUrl()}${path}`, init)
  return res.json()
}

function registerIpc(): void {
  ipcMain.handle('core:status', () => ({ baseUrl: getBaseUrl() }))
  ipcMain.handle('core:auth-status', () => coreJson('/control/auth'))
  ipcMain.handle('core:auth-start', () =>
    coreJson('/control/auth/start', { method: 'POST' }),
  )
  ipcMain.handle('core:open-external', (_e, url: string) => shell.openExternal(url))
}

function createWindow(): void {
  const win = new BrowserWindow({
    width: 760,
    height: 620,
    title: 'Maximal',
    webPreferences: {
      preload: join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  })
  if (typeof MAIN_WINDOW_VITE_DEV_SERVER_URL !== 'undefined' && MAIN_WINDOW_VITE_DEV_SERVER_URL) {
    void win.loadURL(MAIN_WINDOW_VITE_DEV_SERVER_URL)
  } else {
    void win.loadFile(join(__dirname, `../renderer/${MAIN_WINDOW_VITE_NAME}/index.html`))
  }
}

void app.whenReady().then(async () => {
  registerIpc()
  try {
    const { baseUrl, port } = await spawnCore()
    console.log(`[maximal-client] core ready at ${baseUrl} (port ${port}); left :4141 untouched`)
  } catch (err) {
    console.error('[maximal-client] core failed to start:', err)
  }
  createWindow()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  killCore()
  if (process.platform !== 'darwin') app.quit()
})
app.on('before-quit', killCore)
