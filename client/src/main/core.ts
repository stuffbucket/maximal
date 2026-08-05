import { spawn, type ChildProcess } from 'node:child_process'
import { createServer } from 'node:net'
import { join } from 'node:path'

import { app } from 'electron'

// The public proxy port external programs (Codex, other tools) hardcode. We
// PREFER it so the app's `/v1` is reachable, but never evict a listener already
// on it — we fall back to an ephemeral port instead (maximal-core#10).
const PREFERRED_PROXY_PORT = 4141

let child: ChildProcess | null = null
let controlBase = ''
let proxyBase = ''

/** Origin the renderer uses for the JSON-RPC/HTTP+SSE control plane. */
export function controlOrigin(): string {
  return controlBase
}
/** Base URL where `/v1` is served for external programs. */
export function proxyUrl(): string {
  return proxyBase
}

function binaryName(): string {
  return process.platform === 'win32' ? 'maximal-core.exe' : 'maximal-core'
}

function coreBinaryPath(): string {
  return app.isPackaged
    ? join(process.resourcesPath, 'bin', binaryName())
    : join(app.getAppPath(), 'resources', 'bin', binaryName())
}

/** Resolves true if the port is bindable (free) on loopback. */
function probeFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const srv = createServer()
    srv.once('error', () => resolve(false))
    srv.listen(port, '127.0.0.1', () => srv.close(() => resolve(true)))
  })
}

function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer()
    srv.once('error', reject)
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address()
      const port = addr && typeof addr === 'object' ? addr.port : 0
      srv.close(() => resolve(port))
    })
  })
}

// Prefer 4141 so external programs reach the proxy; if it's held (e.g. a maximal
// already running, possibly one the app depends on), fall back to an ephemeral
// port and never evict the existing one.
async function pickProxyPort(): Promise<number> {
  if (await probeFree(PREFERRED_PROXY_PORT)) return PREFERRED_PROXY_PORT
  return findFreePort()
}

export async function spawnCore(): Promise<{ controlOrigin: string; proxyUrl: string; port: number }> {
  const port = await pickProxyPort()
  const dataHome = join(app.getPath('userData'), 'core-home')
  // Interim: maximal-core serves the control plane AND `/v1` on one port. When
  // core supports the two-interface split (maximal-core#10 / #3 ready line), the
  // control plane moves to its own ephemeral port and `controlBase` points there.
  proxyBase = `http://127.0.0.1:${port}`
  controlBase = proxyBase
  child = spawn(coreBinaryPath(), ['start', '--port', String(port)], {
    stdio: ['ignore', 'pipe', 'pipe'],
    // Isolated data dir → its own token store, so signing in here never touches
    // the state of a proxy already running on :4141. Marker lets core know it is
    // app-managed.
    env: { ...process.env, COPILOT_API_HOME: dataHome, MAXIMAL_MANAGED_BY_ELECTRON: '1' },
  })
  child.stdout?.on('data', (b: Buffer) => console.log('[core]', b.toString().trimEnd()))
  child.stderr?.on('data', (b: Buffer) => console.error('[core]', b.toString().trimEnd()))
  child.on('exit', (code) => console.log('[core] exited with', code))
  await waitForReady(controlBase, child)
  return { controlOrigin: controlBase, proxyUrl: proxyBase, port }
}

// Readiness without a ready line: poll the unauthenticated liveness endpoint on
// the port we assigned. (When core emits the {controlPort, proxyPort, pid} ready
// line — maximal-core#3 — this is replaced by parsing that line + a pid match.)
async function waitForReady(base: string, proc: ChildProcess): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt++) {
    if (proc.exitCode !== null) throw new Error(`maximal-core exited early (code ${proc.exitCode})`)
    try {
      const res = await fetch(`${base}/status`)
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
