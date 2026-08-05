import { join } from 'node:path'

import { app, BrowserWindow, dialog, ipcMain, session, shell } from 'electron'

import { controlOrigin, killCore, proxyUrl, spawnCore } from './core.js'
import { runShell } from './shell.js'

// Let the renderer (a foreign origin) talk to the loopback core control plane
// directly over HTTP + SSE. We strip Origin/Referer so core's loopback Origin
// guard treats us as a first-party CLI-style caller, and add a permissive ACAO
// on responses so Chromium lets the renderer read them. Scoped to the core
// origin only. (ADR-0023: renderer talks core directly; no IPC-proxying.)
function installCoreCorsShim(origin: string): void {
  const filter = { urls: [`${origin}/*`] }
  session.defaultSession.webRequest.onBeforeSendHeaders(filter, (details, cb) => {
    const headers = { ...details.requestHeaders }
    delete headers.Origin
    delete headers.origin
    delete headers.Referer
    delete headers.referer
    cb({ requestHeaders: headers })
  })
  session.defaultSession.webRequest.onHeadersReceived(filter, (details, cb) => {
    cb({
      responseHeaders: {
        ...details.responseHeaders,
        'access-control-allow-origin': ['*'],
        'access-control-allow-methods': ['POST, OPTIONS'],
        'access-control-allow-headers': ['content-type, mcp-protocol-version'],
      },
    })
  })
}

function registerIpc(): void {
  // Bridge = native powers + control-origin injection ONLY. No core-data channels.
  ipcMain.handle('core:origin', () => controlOrigin())
  ipcMain.handle('core:proxy-url', () => proxyUrl())
  ipcMain.handle('native:open-external', (_e, url: string) => shell.openExternal(url))
}

function loadRenderer(win: BrowserWindow): void {
  if (typeof MAIN_WINDOW_VITE_DEV_SERVER_URL !== 'undefined' && MAIN_WINDOW_VITE_DEV_SERVER_URL) {
    const rendererUrl = new URL(MAIN_WINDOW_VITE_DEV_SERVER_URL)
    if (process.env.MAXIMAL_RENDERER_PREVIEW === 'workspace') {
      rendererUrl.searchParams.set('preview', 'workspace')
    }
    void win.loadURL(rendererUrl.toString())
  } else {
    void win.loadFile(join(__dirname, `../renderer/${MAIN_WINDOW_VITE_NAME}/index.html`))
  }
}

function createWindow(): void {
  const isMac = process.platform === 'darwin'
  runShell({
    preloadPath: join(__dirname, 'preload.js'),
    title: 'Maximal',
    width: 1280,
    height: 820,
    minWidth: 880,
    minHeight: 560,
    backgroundColor: '#0a0a0a',
    titleBarStyle: isMac ? 'hiddenInset' : 'hidden',
    ...(isMac
      ? { trafficLightPosition: { x: 16, y: 18 } }
      : {
          titleBarOverlay: {
            color: '#0a0a0a',
            symbolColor: '#f5f5f5',
            height: 52,
          },
        }),
    loadRenderer,
  })
}

void app.whenReady().then(async () => {
  registerIpc()
  try {
    const { controlOrigin: origin, proxyUrl: proxy, port } = await spawnCore()
    installCoreCorsShim(origin)
    console.log(`[maximal-client] core ready — control ${origin}, proxy ${proxy} (port ${port})`)
  } catch (err) {
    console.error('[maximal-client] core failed to start:', err)
    dialog.showErrorBox('Maximal could not start', err instanceof Error ? err.message : String(err))
    app.quit()
    return
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
