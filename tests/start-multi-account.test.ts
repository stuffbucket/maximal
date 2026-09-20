/**
 * Boot-time integration for the multi-account registry (slice 3). Unit tests
 * cover the pure registry ops + migration in isolation; these spawn the real
 * `start` subprocess against a fresh COPILOT_API_HOME so the actual boot wiring
 * is exercised — the part no in-process test can reach cleanly because PATHS is
 * captured at import time.
 *
 * Two release-critical paths:
 *   1. A legacy single-record token on disk is migrated into accounts.json on
 *      first boot (so users who signed in before multi-account keep working).
 *   2. A registry with NO active account (e.g. after signing out of the active
 *      one while others remain) boots cleanly to unauthenticated — not a
 *      dead-end or a crash.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"

const cwd = fileURLToPath(new URL("../", import.meta.url))

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

function spawnStart(
  tmpHome: string,
  port: number,
): ReturnType<typeof Bun.spawn> {
  return Bun.spawn({
    cmd: [
      process.execPath,
      "run",
      "./src/main.ts",
      "start",
      "--port",
      String(port),
      "--verbose",
    ],
    cwd,
    env: {
      ...process.env,
      COPILOT_API_HOME: tmpHome,
      COPILOT_API_OAUTH_APP: "",
      COPILOT_API_ENTERPRISE_URL: "",
      GITHUB_TOKEN: "",
    },
    stdout: "pipe",
    stderr: "pipe",
  })
}

async function bootOrThrow(
  proc: ReturnType<typeof Bun.spawn>,
  port: number,
): Promise<void> {
  const up = await waitForPort(port, 5000)
  if (!up) {
    const stderr =
      proc.stderr instanceof ReadableStream ?
        await new Response(proc.stderr).text()
      : ""
    throw new Error(`Server did not bind to ${port} within 5s.\n${stderr}`)
  }
}

describe("boot migrates a legacy token into the registry", () => {
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "maximal-migrate-"))
  const port = 4243 + Math.floor(Math.random() * 100)
  let proc: ReturnType<typeof Bun.spawn> | null = null

  beforeAll(async () => {
    // Seed a legacy single-record token. A `gho_` token is used directly as a
    // Copilot bearer (no /v2/token mint), so boot's Copilot bootstrap fails
    // NON-fatally (a plain 401 from /user or /models, not a
    // CopilotAuthFatalError) — it degrades and KEEPS the on-disk record rather
    // than wiping it, leaving the migrated registry observable.
    fs.writeFileSync(path.join(tmpHome, "github_token"), "gho_legacytoken123")
    proc = spawnStart(tmpHome, port)
    await bootOrThrow(proc, port)
  })

  afterAll(() => {
    proc?.kill("SIGTERM")
    fs.rmSync(tmpHome, { recursive: true, force: true })
  })

  test("writes accounts.json with a migration-tagged active account", () => {
    const registryPath = path.join(tmpHome, "accounts.json")
    expect(fs.existsSync(registryPath)).toBe(true)
    // eslint-disable-next-line unicorn/prefer-json-parse-buffer -- JSON.parse's type only accepts string
    const reg = JSON.parse(fs.readFileSync(registryPath, "utf8")) as {
      schemaVersion: number
      activeKey: string | null
      accounts: Record<
        string,
        { token: string; addedVia: string; host: string }
      >
    }
    expect(reg.schemaVersion).toBe(2)
    const entries = Object.values(reg.accounts)
    expect(entries).toHaveLength(1)
    expect(entries[0]?.addedVia).toBe("migration")
    expect(entries[0]?.token).toBe("gho_legacytoken123")
    // login lookup fails with a garbage token → keyed unknown@github.com, and
    // that key is active.
    expect(reg.activeKey).toBe("unknown@github.com")
  })

  test("server still binds (boot is not blocked by the bad token)", async () => {
    const res = await fetch(`http://127.0.0.1:${port}/`)
    expect(res.status).toBe(200)
  })
})

describe("boot with a registry that has no active account", () => {
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "maximal-noactive-"))
  const port = 4343 + Math.floor(Math.random() * 100)
  let proc: ReturnType<typeof Bun.spawn> | null = null

  beforeAll(async () => {
    // Registry with one INACTIVE account and activeKey: null — the state after
    // signing out of the active account while another remembered account stays.
    // Migration must NOT run (registry already populated), and boot must land
    // unauthenticated rather than dead-end or crash.
    fs.writeFileSync(
      path.join(tmpHome, "accounts.json"),
      JSON.stringify({
        schemaVersion: 2,
        activeKey: null,
        accounts: {
          "bob@github.com": {
            login: "bob",
            host: "github.com",
            token: "gho_bobtoken",
            tokenType: "gho_",
            addedVia: "gh-cli",
            obtainedAt: "2026-01-01T00:00:00.000Z",
          },
        },
      }),
    )
    proc = spawnStart(tmpHome, port)
    await bootOrThrow(proc, port)
  })

  afterAll(() => {
    proc?.kill("SIGTERM")
    fs.rmSync(tmpHome, { recursive: true, force: true })
  })

  test("binds and reports unauthenticated (no active token loaded)", async () => {
    const res = await fetch(`http://127.0.0.1:${port}/_debug/state`)
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      runtime: { github_token_present: boolean }
    }
    expect(body.runtime.github_token_present).toBe(false)
  })

  test("the remembered account is left intact in the registry", () => {
    // eslint-disable-next-line unicorn/prefer-json-parse-buffer -- JSON.parse's type only accepts string
    const raw = fs.readFileSync(path.join(tmpHome, "accounts.json"), "utf8")
    const reg = JSON.parse(raw) as {
      activeKey: string | null
      accounts: Record<string, unknown>
    }
    expect(reg.activeKey).toBeNull()
    expect("bob@github.com" in reg.accounts).toBe(true)
  })
})
