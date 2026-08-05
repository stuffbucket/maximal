/**
 * Electron main process — supervises the maximal-core sidecar.
 *
 * The engine is a separate process, not a library: core ships a binary and
 * speaks a loopback control plane, so this owns the process lifecycle and
 * nothing else. Everything about the wire format comes from core's published
 * contract, so this file cannot drift from it (stuffbucket/maximal#408).
 *
 * Ordering here is load-bearing. The window is only created once the sidecar has
 * announced readiness, because the renderer's first act is a control call — a
 * window shown earlier would render an error state for the half-second the
 * engine takes to bind, which is exactly the "blank starting…" experience the
 * boot-status relay exists to avoid.
 */
import { spawn } from "node:child_process"
import { mkdirSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

import {
  awaitReadyLine,
  sidecarSpawnEnv,
  SidecarExitedError,
  SidecarReadyTimeoutError,
} from "@stuffbucket/maximal-core/supervisor"
import { app, BrowserWindow, ipcMain } from "electron"

const here = dirname(fileURLToPath(import.meta.url))

type SpawnedSidecar = ReturnType<typeof spawnSidecarProcess>

interface Sidecar {
  child: SpawnedSidecar
  port: number
  pid: number
}

let sidecar: Sidecar | null = null
const bootLines: Array<string> = []

/**
 * Where the sidecar keeps its state.
 *
 * Deliberately NOT the user's default home: a desktop-spawned engine is an
 * isolated instance (maximal-core#2), so it can never fight a `maximal start`
 * the user runs themselves for their CLI tools.
 */
function isolatedHome(): string {
  const dir = join(homedir(), ".local", "share", "maximal-client")
  mkdirSync(dir, { recursive: true })
  return dir
}

function sidecarCommand(): { cmd: string; args: Array<string> } {
  // Port 0: let the OS choose. A supervised sidecar must never claim 4141 —
  // that belongs to a user-run engine serving external tools (maximal#408).
  const args = ["start", "--port", "0"]
  const packaged = process.env.MAXIMAL_SIDECAR_PATH
  if (packaged) return { cmd: packaged, args }
  // Dev: run core from the installed dependency's source.
  return {
    cmd: "bun",
    args: [
      join(here, "..", "node_modules", "@stuffbucket", "maximal-core", "src", "main.ts"),
      ...args,
    ],
  }
}

function spawnSidecarProcess(cmd: string, args: Array<string>) {
  return spawn(cmd, args, {
    env: {
      ...process.env,
      ...sidecarSpawnEnv(),
      COPILOT_API_HOME: isolatedHome(),
    },
    stdio: ["ignore", "pipe", "pipe"] as const,
  })
}

async function startSidecar(): Promise<Sidecar> {
  const { cmd, args } = sidecarCommand()
  const child = spawnSidecarProcess(cmd, args)

  try {
    const ready = await awaitReadyLine(child.stdout, {
      timeoutMs: 30_000,
      onLine: (line) => bootLines.push(line),
    })
    // The host owns stdout from here. Stop draining and the pipe buffer fills,
    // blocking the sidecar on its next write.
    child.stdout.resume()
    child.stderr.resume()
    return { child, port: ready.port, pid: ready.pid }
  } catch (error) {
    child.kill("SIGKILL")
    if (error instanceof SidecarExitedError) {
      throw new Error("The maximal engine exited before it finished starting.")
    }
    if (error instanceof SidecarReadyTimeoutError) {
      throw new Error("The maximal engine did not start in time.")
    }
    throw error
  }
}

function stopSidecar(): void {
  if (!sidecar) return
  sidecar.child.kill("SIGTERM")
  sidecar = null
}

/**
 * Renderer bridge. The renderer never learns the port or talks to the engine
 * directly — it names a method, main forwards it. That keeps the sidecar
 * unreachable from page context even if the renderer is ever compromised.
 */
function registerIpc(): void {
  ipcMain.handle("control:call", async (_event, method: string, params?: unknown) => {
    if (!sidecar) return { ok: false, error: "The engine is not running." }
    const res = await fetch(`http://127.0.0.1:${sidecar.port}/control/rpc`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: Date.now(), method, ...(params ? { params } : {}) }),
    })
    const body = (await res.json()) as { result?: unknown; error?: { message: string } }
    return body.error ? { ok: false, error: body.error.message } : { ok: true, result: body.result }
  })

  ipcMain.handle("control:boot", () => ({
    port: sidecar?.port ?? null,
    pid: sidecar?.pid ?? null,
    lines: bootLines.slice(-20),
  }))
}

async function createWindow(): Promise<void> {
  const win = new BrowserWindow({
    width: 720,
    height: 520,
    title: "maximal",
    webPreferences: {
      preload: join(here, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  })
  await win.loadFile(join(here, "renderer", "index.html"))
}

app.whenReady().then(async () => {
  registerIpc()
  sidecar = await startSidecar()
  await createWindow()
})

app.on("window-all-closed", () => {
  stopSidecar()
  app.quit()
})

// The engine must not outlive its supervisor. Core also runs a parent-pid
// watchdog, but killing it here makes the common path deterministic.
app.on("before-quit", stopSidecar)
process.on("exit", stopSidecar)
