import { spawn, type ChildProcess } from 'node:child_process'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'

import { awaitReadyLine, sidecarSpawnEnv } from '@stuffbucket/maximal-core/supervisor'
import { app } from 'electron'

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

/** Spawn one isolated sidecar on an OS-assigned port and wait for its ready line. */
export async function spawnCore(): Promise<{ controlOrigin: string; proxyUrl: string; port: number; pid: number }> {
  const dataHome = join(app.getPath('userData'), 'core-home')
  await mkdir(dataHome, { recursive: true })

  const proc = spawn(coreBinaryPath(), ['start', '--port', '0'], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      COPILOT_API_HOME: dataHome,
      ...sidecarSpawnEnv(),
    },
  })
  child = proc

  proc.stderr?.on('data', (chunk: Buffer) => console.error('[core]', chunk.toString().trimEnd()))
  proc.on('error', (error) => console.error('[core] process error:', error))
  proc.on('exit', (code, signal) => console.log('[core] exited', { code, signal }))

  if (!proc.stdout) {
    proc.kill('SIGTERM')
    child = null
    throw new Error('maximal-core stdout pipe was not created')
  }

  let removeReadinessFailureListeners = () => {}
  const failedBeforeReady = new Promise<never>((_resolve, reject) => {
    const onError = (error: Error) => reject(error)
    const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
      reject(new Error(`maximal-core exited before readiness (code=${String(code)}, signal=${String(signal)})`))
    }
    proc.once('error', onError)
    proc.once('exit', onExit)
    removeReadinessFailureListeners = () => {
      proc.off('error', onError)
      proc.off('exit', onExit)
    }
  })

  try {
    const ready = await Promise.race([
      awaitReadyLine(proc.stdout, {
        onLine: (line) => console.log('[core]', line),
      }),
      failedBeforeReady,
    ])
    removeReadinessFailureListeners()

    if (proc.pid === undefined || ready.pid !== proc.pid) {
      throw new Error(`maximal-core ready-line pid ${ready.pid} did not match spawned pid ${String(proc.pid)}`)
    }

    // awaitReadyLine deliberately leaves stdout open. Keep draining it for the
    // process lifetime or the pipe can fill and block the sidecar on a later log.
    proc.stdout.on('data', (chunk: Buffer) => console.log('[core]', chunk.toString().trimEnd()))

    controlBase = `http://127.0.0.1:${ready.port}`
    // v0.2.0 exposes one listener, so this packaging PoC temporarily reports the
    // same origin for `/v1`. The product contract is two interfaces: private
    // control on port 0, public API preferring 4141 then scanning upward. Adopt
    // the typed controlPort/publicPort ready-line fields when maximal-core#10
    // ships; do not recreate that bind policy in Electron or spawn two cores.
    proxyBase = controlBase
    return { controlOrigin: controlBase, proxyUrl: proxyBase, port: ready.port, pid: ready.pid }
  } catch (error) {
    removeReadinessFailureListeners()
    if (!proc.killed) proc.kill('SIGTERM')
    if (child === proc) child = null
    throw error
  }
}

export function killCore(): void {
  if (child && !child.killed) child.kill('SIGTERM')
  child = null
  controlBase = ''
  proxyBase = ''
}
