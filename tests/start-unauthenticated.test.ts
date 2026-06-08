/**
 * Boot-time behavior when no GitHub token exists on disk.
 *
 * Regression guard for the "dozens of browser tabs" bug: when the Tauri
 * shell spawned the sidecar with no token cached, the proxy used to fire
 * the GitHub device-code flow (opening a browser) *before* binding 4142,
 * so the dashboard couldn't load to let the user recover. The fix: boot
 * the server unconditionally, leave `state.githubToken` undefined when
 * absent, and gate `/v1/*` and friends with `requireGithubAuth`.
 *
 * This test starts the real `start` subprocess against a fresh
 * `COPILOT_API_HOME` (so no token record exists) and asserts:
 *   1. The port binds within 5s (no auth blocking startup).
 *   2. `/_debug/state` reports `github_token_present: false`.
 *   3. Upstream-touching routes 401 with `{ error: "not_authenticated" }`.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"

const cwd = fileURLToPath(new URL("../", import.meta.url))
const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "maximal-unauth-"))
const port = 4143 + Math.floor(Math.random() * 100)

let proc: ReturnType<typeof Bun.spawn> | null = null

async function waitForPort(p: number, timeoutMs: number): Promise<boolean> {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(`http://127.0.0.1:${p}/`, {
        signal: AbortSignal.timeout(500),
      })
      if (res.ok) return true
    } catch {
      // not listening yet
    }
    await new Promise((r) => setTimeout(r, 100))
  }
  return false
}

beforeAll(async () => {
  proc = Bun.spawn({
    cmd: [
      process.execPath,
      "run",
      "./src/main.ts",
      "start",
      "--port",
      String(port),
      "--verbose", // unlocks /_debug/state
    ],
    cwd,
    env: {
      ...process.env,
      COPILOT_API_HOME: tmpHome,
      COPILOT_API_OAUTH_APP: "",
      COPILOT_API_ENTERPRISE_URL: "",
      // Make sure no env-bearer slips in.
      GITHUB_TOKEN: "",
    },
    stdout: "pipe",
    stderr: "pipe",
  })

  const up = await waitForPort(port, 5000)
  if (!up) {
    // Surface child output to make CI failures debuggable.
    const stderr =
      proc.stderr instanceof ReadableStream ?
        await new Response(proc.stderr).text()
      : ""
    const stdout =
      proc.stdout instanceof ReadableStream ?
        await new Response(proc.stdout).text()
      : ""
    throw new Error(
      `Server did not bind to port ${port} within 5s.\nstdout:\n${stdout}\nstderr:\n${stderr}`,
    )
  }
})

afterAll(() => {
  if (proc) {
    proc.kill("SIGTERM")
  }
  fs.rmSync(tmpHome, { recursive: true, force: true })
})

describe("start in unauthenticated mode", () => {
  test("HTTP server is listening", async () => {
    const res = await fetch(`http://127.0.0.1:${port}/`)
    expect(res.status).toBe(200)
    expect((await res.text()).trim()).toBe("Server running")
  })

  test("GET /status returns the maximal identity marker, no auth needed", async () => {
    // The Claude Code shim probes this to confirm :4141 is really Maximal
    // (vs some other process that grabbed the port). Must work with no API
    // key and even with a bogus one.
    const headerCases: Array<Record<string, string>> = [
      {},
      { "x-api-key": "definitely-not-valid" },
    ]
    for (const headers of headerCases) {
      const res = await fetch(`http://127.0.0.1:${port}/status`, { headers })
      expect(res.status).toBe(200)
      const body = (await res.json()) as {
        service: string
        status: string
        version: string
        uptime_ms: number
        subsystems: {
          copilot: {
            authenticated: boolean
            ready: boolean
            account_type: string
          }
          models: { cached: number }
        }
      }
      // Top level = "Maximal, all up" — the identity + liveness signal.
      expect(body.service).toBe("maximal")
      expect(body.status).toBe("ok")
      expect(typeof body.version).toBe("string")
      expect(body.uptime_ms).toBeGreaterThanOrEqual(0)
      // Subsystems namespace per-part health. This server booted with no
      // GitHub token, so copilot is unauthenticated and not ready —
      // proving the readiness signal reflects real state.
      expect(body.subsystems.copilot.authenticated).toBe(false)
      expect(body.subsystems.copilot.ready).toBe(false)
      expect(typeof body.subsystems.copilot.account_type).toBe("string")
      expect(body.subsystems.models.cached).toBeGreaterThanOrEqual(0)
    }
  })

  test("/_debug/state reports github_token_present: false", async () => {
    const res = await fetch(`http://127.0.0.1:${port}/_debug/state`)
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      runtime: { github_token_present: boolean }
    }
    expect(body.runtime.github_token_present).toBe(false)
  })

  test("POST /v1/messages returns 401 not_authenticated", async () => {
    const res = await fetch(`http://127.0.0.1:${port}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "claude-3-5-sonnet", messages: [] }),
    })
    expect(res.status).toBe(401)
    const body = (await res.json()) as { error: string; hint: string }
    expect(body.error).toBe("not_authenticated")
    expect(body.hint).toContain("Settings")
  })

  test("GET /chat/completions also gates on github auth", async () => {
    const res = await fetch(`http://127.0.0.1:${port}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "gpt-4o", messages: [] }),
    })
    expect(res.status).toBe(401)
    const body = (await res.json()) as { error: string }
    expect(body.error).toBe("not_authenticated")
  })
})
