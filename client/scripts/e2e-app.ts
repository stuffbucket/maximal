/**
 * Harness: the whole maximal app, end to end.
 *
 * **A harness, not a test head.** It launches the *real* Electron client —
 * `dist/main.js`, the real window, the real preload bridge, the real renderer —
 * and drives it from outside through the Chrome DevTools Protocol. Nothing in
 * `src/` is modified, stubbed, or aware this exists. There is no alternate UI
 * and no test-only code path; if this passes, what passed is the shipping app.
 *
 * It is the only check that covers the full chain in one go:
 *
 *   Electron main → spawn maximal-core sidecar → ready-line → bound port
 *     → IPC bridge → renderer → JSON-RPC control call → rendered state
 *
 * Every layer below has its own coverage in core (`bun run e2e` there), but
 * each one verifies a seam in isolation. A client can pass every unit test and
 * still show a blank window because the preload path was wrong or the renderer
 * threw before its first paint — this is what notices that.
 *
 * Run with `bun run e2e:app`. Requires a window server (a normal macOS login
 * session); it is not runnable over a bare SSH connection.
 */
import { spawn } from "node:child_process"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const here = dirname(fileURLToPath(import.meta.url))
const clientDir = join(here, "..")

/** A fixed port is fine: this is a debugging channel the harness owns for the
 *  few seconds the app is up, not something the app binds in normal use. */
const CDP_PORT = 9333
const LAUNCH_TIMEOUT_MS = 45_000

let failed = false
const check = (label: string, ok: boolean, detail: string): void => {
  if (!ok) failed = true
  console.log(`${ok ? "ok  " : "FAIL"}  ${label.padEnd(14)} ${detail}`)
}

console.log("\ne2e:app — the real Electron client, driven end to end\n")

const electron = spawn(
  join(clientDir, "node_modules", ".bin", "electron"),
  [join(clientDir, "dist", "main.js"), `--remote-debugging-port=${CDP_PORT}`],
  { cwd: clientDir, stdio: ["ignore", "pipe", "pipe"] },
)

const appLog: Array<string> = []
const collect = (chunk: Buffer): void => {
  for (const line of String(chunk).split("\n")) {
    if (line.trim()) appLog.push(line)
  }
}
electron.stdout.on("data", collect)
electron.stderr.on("data", collect)

/** Poll CDP until the renderer window exists. The window is created only after
 *  the sidecar announces readiness, so this waiting *is* the assertion that the
 *  supervisor got a bound port. */
async function awaitPageTarget(): Promise<{ webSocketDebuggerUrl: string; url: string } | null> {
  const deadline = Date.now() + LAUNCH_TIMEOUT_MS
  while (Date.now() < deadline) {
    if (electron.exitCode !== null) return null
    try {
      const res = await fetch(`http://127.0.0.1:${CDP_PORT}/json`)
      const targets = (await res.json()) as Array<{
        type: string
        url: string
        webSocketDebuggerUrl: string
      }>
      const page = targets.find((t) => t.type === "page")
      if (page) return page
    } catch {
      // Not listening yet — Electron is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 500))
  }
  return null
}

/** Minimal CDP client. Only `Runtime.evaluate` is needed, so this stays a
 *  request/response map rather than a dependency. */
function connect(url: string): Promise<{
  evaluate: (expression: string) => Promise<unknown>
  close: () => void
}> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url)
    let nextId = 0
    const pending = new Map<number, (value: unknown) => void>()

    ws.onmessage = (event) => {
      const msg = JSON.parse(String(event.data)) as {
        id?: number
        result?: { result?: { value?: unknown } }
      }
      if (typeof msg.id === "number" && pending.has(msg.id)) {
        pending.get(msg.id)?.(msg.result?.result?.value)
        pending.delete(msg.id)
      }
    }
    ws.onerror = () => reject(new Error("CDP socket failed"))
    ws.onopen = () => {
      resolve({
        evaluate: (expression) =>
          new Promise((res) => {
            const id = ++nextId
            pending.set(id, res)
            ws.send(
              JSON.stringify({
                id,
                method: "Runtime.evaluate",
                params: { expression, awaitPromise: true, returnByValue: true },
              }),
            )
          }),
        close: () => ws.close(),
      })
    }
  })
}

try {
  const page = await awaitPageTarget()
  check(
    "window",
    page !== null,
    page ?
      "opened, and only after the sidecar reported ready"
    : `no window within ${LAUNCH_TIMEOUT_MS}ms — ${appLog.slice(-3).join(" | ") || "no output"}`,
  )
  if (!page) throw new Error("app never opened a window")

  check(
    "renderer",
    page.url.endsWith("renderer/index.html"),
    page.url.replace(clientDir, "…"),
  )

  const cdp = await connect(page.webSocketDebuggerUrl)

  // The supervised sidecar must be on an ephemeral port, never 4141 — that one
  // belongs to a user-run engine serving external tools (maximal#408).
  const bootRaw = (await cdp.evaluate(
    `window.maximal.boot().then((b) => JSON.stringify(b))`,
  )) as string
  const boot = JSON.parse(bootRaw) as {
    port: number | null
    pid: number | null
    lines: Array<string>
  }
  check(
    "sidecar",
    boot.port !== null && boot.port > 0 && boot.port !== 4141 && boot.pid !== null,
    `127.0.0.1:${boot.port} pid=${boot.pid} (ephemeral, not 4141)`,
  )
  check(
    "boot relay",
    boot.lines.length > 0,
    `${boot.lines.length} boot lines reached the host (a slow start can show progress)`,
  )

  // A live round-trip through every layer at once.
  const healthRaw = (await cdp.evaluate(
    `window.maximal.call('health').then((r) => JSON.stringify(r))`,
  )) as string
  const health = JSON.parse(healthRaw) as {
    ok: boolean
    result?: { ok: boolean; version: string }
    error?: string
  }
  check(
    "round-trip",
    health.ok && health.result?.ok === true,
    health.ok ?
      `renderer → IPC → JSON-RPC → engine v${health.result?.version}`
    : `failed — ${health.error ?? "unknown"}`,
  )

  // What the user actually sees. A window that opened but rendered an error
  // state is still a broken app, and every check above would have passed.
  const paintedRaw = (await cdp.evaluate(`JSON.stringify({
    engine: document.getElementById('engine')?.textContent ?? '',
    protocol: document.getElementById('protocol')?.textContent ?? '',
    auth: document.getElementById('auth')?.textContent ?? '',
  })`)) as string
  const painted = JSON.parse(paintedRaw) as Record<string, string>

  check(
    "painted",
    painted.protocol.startsWith("v2") && painted.protocol.includes("methods"),
    `protocol: "${painted.protocol}"`,
  )
  check(
    "discovered",
    !painted.protocol.includes("unavailable"),
    "the renderer learned the method set from server/discover, not a hardcoded list",
  )
  check(
    "auth state",
    painted.auth.length > 0 && painted.auth !== "error",
    `auth: "${painted.auth}" (unauthenticated is correct on a fresh isolated home)`,
  )

  check(
    "alive",
    electron.exitCode === null,
    "app survived the exchange",
  )

  cdp.close()
} catch (error) {
  check("harness", false, error instanceof Error ? error.message : String(error))
} finally {
  electron.kill("SIGTERM")
  // The app stops its sidecar on quit; give that path a moment to run so the
  // harness does not leave an engine behind.
  await new Promise((resolve) => setTimeout(resolve, 1500))
  if (electron.exitCode === null) electron.kill("SIGKILL")
}

console.log("")
process.exit(failed ? 1 : 0)
