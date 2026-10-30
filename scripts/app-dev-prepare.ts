#!/usr/bin/env bun
/**
 * Prepare an isolated `bun run app:dev` session.
 *
 * Each worktree gets a stable data directory and Tauri identifier, while the
 * listener uses the first free development port. A relaunch recognizes the
 * prior sidecar through that profile's session sentinel and replaces it.
 * Explicit COPILOT_API_HOME and MAXIMAL_DEV_PORT values still win.
 */

import { createHash } from "node:crypto"
import { readFileSync, writeFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"

import { resolveAppDir } from "../src/lib/platform/paths"

const RELEASE_PORT = 4141
const FIRST_DEV_PORT = RELEASE_PORT + 1
const LAST_DEV_PORT = RELEASE_PORT + 20
const PORT_RELEASE_TIMEOUT_MS = 8000
const PORT_POLL_INTERVAL_MS = 100

export type PortState = "free" | "maximal" | "other"

type Probe = (port: number) => Promise<PortState>

export interface DevProfile {
  home: string
  identifier: string
}

interface DevProfileSystem {
  platform: NodeJS.Platform
  homedir: string
  appData?: string
}

export interface DevPortSelection {
  port: number
  replaceExisting: boolean
}

export interface PreparedAppDev {
  env: NodeJS.ProcessEnv
  home: string
  identifier: string
  port: number
}

function shortHash(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 12)
}

/** Stable per-worktree profile unless the caller supplies its own home. */
export function resolveDevProfile(
  env: NodeJS.ProcessEnv,
  repoRoot: string,
  system: DevProfileSystem = {
    platform: process.platform,
    homedir: os.homedir(),
    appData: env.APPDATA,
  },
): DevProfile {
  const override = env.COPILOT_API_HOME?.trim()
  const worktreeKey = shortHash(path.resolve(repoRoot))
  const base = resolveAppDir({
    platform: system.platform,
    homedir: system.homedir,
    appData: system.appData,
  })
  const home =
    override ?
      path.resolve(repoRoot, override)
    : path.join(base, "dev", worktreeKey)
  const profileKey = shortHash(path.resolve(home))
  return {
    home,
    identifier: `co.stuffbucket.maximal.dev.${profileKey}`,
  }
}

function parsePort(raw: string): number {
  const port = Number(raw)
  if (!/^\d+$/.test(raw) || port < 1 || port > 65_535) {
    throw new Error(`MAXIMAL_DEV_PORT must be a port number; got "${raw}"`)
  }
  return port
}

/**
 * Use an explicit port exactly, otherwise replace this profile's prior sidecar
 * or take the first free port in the development range.
 */
export async function selectDevPort(
  explicitPort: number | undefined,
  previousPort: number | undefined,
  probe: Probe,
): Promise<DevPortSelection> {
  if (explicitPort !== undefined) {
    return { port: explicitPort, replaceExisting: true }
  }

  if (previousPort !== undefined) {
    const state = await probe(previousPort)
    if (state === "free") {
      return { port: previousPort, replaceExisting: false }
    }
    if (state === "maximal") {
      return { port: previousPort, replaceExisting: true }
    }
  }

  for (let port = FIRST_DEV_PORT; port <= LAST_DEV_PORT; port += 1) {
    if (port !== previousPort && (await probe(port)) === "free") {
      return { port, replaceExisting: false }
    }
  }

  throw new Error(
    `No free development port found from ${FIRST_DEV_PORT} through ${LAST_DEV_PORT}.`,
  )
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM"
  }
}

function runningSessionPort(home: string): number | undefined {
  try {
    const raw: unknown = JSON.parse(
      readFileSync(path.join(home, "session-running"), "utf8"),
    )
    if (typeof raw !== "object" || raw === null) return undefined
    const { pid, port } = raw as { pid?: unknown; port?: unknown }
    if (
      typeof pid !== "number"
      || !Number.isInteger(pid)
      || pid <= 0
      || typeof port !== "number"
      || !Number.isInteger(port)
      || port < 1
      || port > 65_535
      || !processIsAlive(pid)
    ) {
      return undefined
    }
    return port
  } catch {
    return undefined
  }
}

async function probeSidecar(port: number): Promise<PortState> {
  try {
    const res = await fetch(`http://localhost:${port}/`, {
      signal: AbortSignal.timeout(500),
    })
    if (!res.ok) return "other"
    const text = (await res.text()).trim()
    return text === "Server running" ? "maximal" : "other"
  } catch {
    return "free"
  }
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms))
}

async function requestShutdown(port: number): Promise<void> {
  let res: Response
  try {
    res = await fetch(`http://localhost:${port}/_internal/shutdown`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ reason: "app-dev relaunch" }),
      signal: AbortSignal.timeout(2000),
    })
  } catch (error) {
    throw new Error(
      `/_internal/shutdown on :${port} was unreachable: ${error instanceof Error ? error.message : String(error)}`,
    )
  }
  if (!res.ok) {
    throw new Error(
      `/_internal/shutdown on :${port} returned ${res.status}; the running instance may not honor loopback shutdown.`,
    )
  }
}

async function waitForPortRelease(port: number): Promise<void> {
  const deadline = Date.now() + PORT_RELEASE_TIMEOUT_MS
  while (Date.now() < deadline) {
    if ((await probeSidecar(port)) === "free") return
    await sleep(PORT_POLL_INTERVAL_MS)
  }
  throw new Error(
    `:${port} did not become free within ${PORT_RELEASE_TIMEOUT_MS}ms after shutdown.`,
  )
}

/** Tauri overrides for an isolated development app on the selected port. */
export function devConfig(
  port: number,
  identifier: string,
): Record<string, unknown> {
  const config: Record<string, unknown> = {
    productName: "Maximal Dev",
    identifier,
  }
  if (port === RELEASE_PORT) return config

  const origins = [
    `http://localhost:${port}/*`,
    `http://127.0.0.1:${port}/*`,
  ]
  return {
    ...config,
    app: {
      security: {
        // Listing capabilities replaces the capabilities/ directory, so name
        // the existing ones and add the selected development origin.
        capabilities: [
          "default",
          "loopback",
          {
            identifier: "loopback-dev-port",
            description: `The loopback capability for the dev port :${port}.`,
            windows: ["settings", "dashboard"],
            local: false,
            remote: { urls: origins },
            permissions: [
              "core:default",
              "core:window:default",
              "core:window:allow-start-dragging",
              "core:window:allow-internal-toggle-maximize",
              "core:webview:allow-create-webview-window",
              "opener:default",
              "default",
            ],
          },
        ],
      },
    },
  }
}

export async function prepareAppDev(
  env: NodeJS.ProcessEnv,
  repoRoot: string,
): Promise<PreparedAppDev> {
  const profile = resolveDevProfile(env, repoRoot)
  const rawPort = env.MAXIMAL_DEV_PORT?.trim()
  const explicitPort = rawPort ? parsePort(rawPort) : undefined
  const previousPort =
    explicitPort === undefined ? runningSessionPort(profile.home) : undefined
  const selection = await selectDevPort(
    explicitPort,
    previousPort,
    probeSidecar,
  )

  const configPath = path.join(
    repoRoot,
    "shell",
    "src-tauri",
    "tauri.dev.conf.json",
  )
  writeFileSync(
    configPath,
    `${JSON.stringify(devConfig(selection.port, profile.identifier), null, 2)}\n`,
  )

  const state = await probeSidecar(selection.port)
  if (state === "maximal" && selection.replaceExisting) {
    console.log(
      `[app-dev] replacing this profile's maximal on :${selection.port}`,
    )
    await requestShutdown(selection.port)
    await waitForPortRelease(selection.port)
  } else if (state !== "free") {
    const occupant = state === "maximal" ? "another maximal" : "another process"
    throw new Error(
      `:${selection.port} became occupied by ${occupant}; run app:dev again.`,
    )
  }

  console.log(`[app-dev] isolated home: ${profile.home}`)
  console.log(`[app-dev] sidecar port: ${selection.port}`)

  return {
    env: {
      ...env,
      COPILOT_API_HOME: profile.home,
      MAXIMAL_DEV_PORT: String(selection.port),
    },
    home: profile.home,
    identifier: profile.identifier,
    port: selection.port,
  }
}
