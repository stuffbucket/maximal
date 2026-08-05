import { spawn, type ChildProcess } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { join } from 'node:path'

import { app } from 'electron'

// The public proxy port external programs (Codex, other tools) hardcode. We
// PREFER it so the app's `/v1` is reachable — but only when it's genuinely free.
// If a maximal is already there (the common case: a proxy the user is running),
// we use an ephemeral port and never touch it.
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

// Reliable "is something already serving here?" — an HTTP probe, NOT a bind test.
// A bind test gives false-frees when the occupant uses SO_REUSEPORT (maximal
// does), which would wrongly pick an occupied 4141.
async function portHasServer(port: number): Promise<boolean> {
  try {
    await fetch(`http://127.0.0.1:${port}/status`, { signal: AbortSignal.timeout(600) })
    return true // something answered → occupied; leave it alone
  } catch {
    return false // connection refused / no server → free
  }
}

async function pickProxyPort(): Promise<number> {
  if (!(await portHasServer(PREFERRED_PROXY_PORT))) return PREFERRED_PROXY_PORT
  return findFreePort()
}

export async function spawnCore(): Promise<{ controlOrigin: string; proxyUrl: string; port: number }> {
  const dataHome = join(app.getPath('userData'), 'core-home')
  let port = await pickProxyPort()
  let ok = await startOn(port, dataHome)
  if (!ok && port === PREFERRED_PROXY_PORT) {
    // Race: 4141 got taken between the probe and our spawn. Fall back.
    port = await findFreePort()
    ok = await startOn(port, dataHome)
  }
  if (!ok) throw new Error('maximal-core did not become ready')
  // Interim: maximal-core serves the control plane AND `/v1` on one port. When
  // core supports the two-interface split (maximal-core#10) the control plane
  // moves to its own ephemeral port and `controlBase` points there.
  proxyBase = `http://127.0.0.1:${port}`
  controlBase = proxyBase
  return { controlOrigin: controlBase, proxyUrl: proxyBase, port }
}

// Spawn core on `port`; resolve true only once OUR core (pid match) is serving.
// Returns false if it exits early (e.g. the port turned out to be occupied) so
// the caller can fall back — we never adopt a foreign core on a shared port.
async function startOn(port: number, dataHome: string): Promise<boolean> {
  const base = `http://127.0.0.1:${port}`
  child = spawn(coreBinaryPath(), ['start', '--port', String(port)], {
    stdio: ['ignore', 'pipe', 'pipe'],
    // Isolated data dir → its own token store, so signing in here never touches
    // the state of a proxy already running on :4141.
    env: { ...process.env, COPILOT_API_HOME: dataHome, MAXIMAL_MANAGED_BY_ELECTRON: '1' },
  })
  const proc = child
  let spawnFailed = false
  proc.stdout?.on('data', (b: Buffer) => console.log('[core]', b.toString().trimEnd()))
  proc.stderr?.on('data', (b: Buffer) => console.error('[core]', b.toString().trimEnd()))
  proc.on('exit', (code) => console.log('[core] exited with', code))
  // Without this, a spawn failure (missing/blocked binary) emits an *unhandled*
  // 'error' → uncaught exception → the main process crashes. Handle it so we
  // fail gracefully and the caller can fall back / surface a clean message.
  proc.on('error', (err) => {
    spawnFailed = true
    console.error('[core] spawn failed:', err)
  })

  for (let attempt = 0; attempt < 200; attempt++) {
    if (spawnFailed || proc.exitCode !== null) return false // exited early / never started
    if (await ourCoreServing(base, dataHome, proc.pid, port)) return true
    await new Promise((r) => setTimeout(r, 150))
  }
  return false
}

// Confirm the core answering on `base` is the child WE spawned — not a foreign
// maximal that already owned the port. On an ephemeral port nothing else can be
// there, so a `/status` 200 suffices; on the shared 4141 we additionally require
// the pid written in OUR isolated home to match the spawned child.
async function ourCoreServing(
  base: string,
  dataHome: string,
  pid: number | undefined,
  port: number,
): Promise<boolean> {
  try {
    const res = await fetch(`${base}/status`)
    if (!res.ok) return false
  } catch {
    return false
  }
  if (port !== PREFERRED_PROXY_PORT) return true
  try {
    const written = Number((await readFile(join(dataHome, 'maximal.pid'), 'utf8')).trim())
    return pid !== undefined && written === pid
  } catch {
    return false // our core hasn't written its pid yet → not confirmed ours
  }
}

export function killCore(): void {
  if (child && !child.killed) {
    child.kill('SIGTERM')
    child = null
  }
}
