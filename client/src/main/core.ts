import { spawn, type ChildProcess } from 'node:child_process'
import { createServer } from 'node:net'
import { join } from 'node:path'

import { app } from 'electron'

// The well-known port a user's maximal proxy may already occupy. We never bind
// it, and never let core evict it — the client always runs on its own port.
const RESERVED_PROXY_PORT = 4141

let child: ChildProcess | null = null
let baseUrl = ''

export function getBaseUrl(): string {
  return baseUrl
}

function binaryName(): string {
  return process.platform === 'win32' ? 'maximal-core.exe' : 'maximal-core'
}

function coreBinaryPath(): string {
  return app.isPackaged
    ? join(process.resourcesPath, 'bin', binaryName())
    : join(app.getAppPath(), 'resources', 'bin', binaryName())
}

async function findFreePort(): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const srv = createServer()
    srv.once('error', reject)
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address()
      const port = addr && typeof addr === 'object' ? addr.port : 0
      srv.close(() => resolve(port))
    })
  })
}

async function pickPort(): Promise<number> {
  const port = await findFreePort()
  // Belt-and-suspenders: never hand core the reserved proxy port.
  return port === RESERVED_PROXY_PORT ? findFreePort() : port
}

export async function spawnCore(): Promise<{ port: number; baseUrl: string }> {
  const port = await pickPort()
  const dataHome = join(app.getPath('userData'), 'core-home')
  baseUrl = `http://127.0.0.1:${port}`
  child = spawn(coreBinaryPath(), ['start', '--port', String(port)], {
    stdio: ['ignore', 'pipe', 'pipe'],
    // Isolated data dir → its own token store, so signing in here never
    // touches the state of a proxy already running on :4141.
    env: { ...process.env, COPILOT_API_HOME: dataHome },
  })
  child.stdout?.on('data', (b: Buffer) => console.log('[core]', b.toString().trimEnd()))
  child.stderr?.on('data', (b: Buffer) => console.error('[core]', b.toString().trimEnd()))
  child.on('exit', (code) => console.log('[core] exited with', code))
  await waitForReady(baseUrl)
  return { port, baseUrl }
}

async function waitForReady(base: string): Promise<void> {
  for (let attempt = 0; attempt < 120; attempt++) {
    try {
      const res = await fetch(`${base}/control/diagnostics`)
      if (res.ok) return
    } catch {
      // core not up yet — keep polling
    }
    await new Promise((r) => setTimeout(r, 150))
  }
  throw new Error('maximal-core did not become ready in time')
}

export function killCore(): void {
  if (child && !child.killed) {
    child.kill('SIGTERM')
    child = null
  }
}
