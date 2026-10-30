#!/usr/bin/env bun
/** Prepare the stable, per-worktree profile used by `bun run app:dev`. */

import { randomBytes } from "node:crypto"
import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"

const WORKTREE_ID_FILE = "maximal-worktree-id"
const WORKTREE_ID_PATTERN = /^[a-f0-9]{12}$/
const SESSION_SENTINEL_FILE = "session-running"
const PRIOR_SESSION_EXIT_TIMEOUT_MS = 8000
const PRIOR_SESSION_POLL_INTERVAL_MS = 100
const DEV_CONFIG_RELATIVE_PATH = path.join(
  "shell",
  "src-tauri",
  "target",
  "maximal-config",
  "tauri.dev.conf.json",
)

interface DevProfileSystem {
  platform: NodeJS.Platform
  homedir: string
  appData?: string
  xdgDataHome?: string
}

interface PriorSession {
  pid: number
  port: number
  parentPid?: number
}

interface PriorSessionDependencies {
  processIsAlive: (pid: number) => boolean
  requestShutdown: (port: number) => Promise<void>
  sleep: (ms: number) => Promise<void>
  now: () => number
}

export interface DevProfile {
  home: string
  identifier: string
  worktreeId: string
}

export interface PreparedAppDev extends DevProfile {
  configPath: string
  env: NodeJS.ProcessEnv
}

function gitPath(repoRoot: string, name: string): string {
  const result = Bun.spawnSync({
    cmd: ["git", "rev-parse", "--path-format=absolute", "--git-path", name],
    cwd: repoRoot,
    stdout: "pipe",
    stderr: "pipe",
  })
  if (result.exitCode !== 0) {
    const detail = result.stderr.toString().trim()
    throw new Error(
      `Could not resolve this worktree's Git admin directory${detail ? `: ${detail}` : "."}`,
    )
  }

  const resolved = result.stdout.toString().trim()
  if (!resolved) {
    throw new Error("Git returned an empty worktree admin path.")
  }
  return resolved
}

function readWorktreeId(filePath: string): string {
  const worktreeId = readFileSync(filePath, "utf8").trim()
  if (!WORKTREE_ID_PATTERN.test(worktreeId)) {
    throw new Error(`Invalid Maximal worktree ID in ${filePath}.`)
  }
  return worktreeId
}

/**
 * Return a random identity persisted with this worktree's Git metadata.
 *
 * `git rev-parse --git-path` resolves inside `.git/worktrees/<name>` for a
 * linked worktree, so moving the checkout does not change its identity and
 * removing the worktree removes the identity with it.
 */
export function resolveWorktreeId(
  repoRoot: string,
  createId: () => string = () => randomBytes(6).toString("hex"),
): string {
  const filePath = gitPath(repoRoot, WORKTREE_ID_FILE)
  try {
    return readWorktreeId(filePath)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
  }

  const worktreeId = createId()
  if (!WORKTREE_ID_PATTERN.test(worktreeId)) {
    throw new Error("Generated an invalid Maximal worktree ID.")
  }

  try {
    writeFileSync(filePath, `${worktreeId}\n`, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    })
    return worktreeId
  } catch (error) {
    // Two app:dev launches may prepare the same worktree concurrently. The
    // process that lost the exclusive create uses the winner's identity.
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      return readWorktreeId(filePath)
    }
    throw error
  }
}

/** Resolve Tauri's app-data directory for an identifier without starting it. */
export function resolveTauriAppDataDir(
  identifier: string,
  system: DevProfileSystem,
): string {
  const paths = system.platform === "win32" ? path.win32 : path.posix
  if (system.platform === "win32") {
    const roaming =
      system.appData?.trim() || paths.join(system.homedir, "AppData", "Roaming")
    return paths.join(roaming, identifier)
  }
  if (system.platform === "darwin") {
    return paths.join(
      system.homedir,
      "Library",
      "Application Support",
      identifier,
    )
  }
  const dataHome =
    system.xdgDataHome?.trim() || paths.join(system.homedir, ".local", "share")
  return paths.join(dataHome, identifier)
}

/** Resolve the development app identity and profile metadata directory. */
export function resolveDevProfile(
  env: NodeJS.ProcessEnv,
  worktreeId: string,
  system: DevProfileSystem = {
    platform: process.platform,
    homedir: os.homedir(),
    appData: env.APPDATA,
    xdgDataHome: env.XDG_DATA_HOME,
  },
): DevProfile {
  if (!WORKTREE_ID_PATTERN.test(worktreeId)) {
    throw new Error(`Invalid Maximal worktree ID "${worktreeId}".`)
  }

  // A D-Bus service-name component cannot start with a digit. Prefix the
  // random hexadecimal worktree ID so Linux's single-instance plugin accepts it.
  const identifier = `co.stuffbucket.maximal.dev.maximal-${worktreeId}`
  const explicitHome = env.COPILOT_API_HOME?.trim()
  return {
    home: explicitHome || resolveTauriAppDataDir(identifier, system),
    identifier,
    worktreeId,
  }
}

function positiveInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ?
      value
    : undefined
}

function readPriorSession(
  home: string,
  expectedIdentifier: string,
): PriorSession | undefined {
  try {
    const parsed: unknown = JSON.parse(
      readFileSync(path.join(home, SESSION_SENTINEL_FILE), "utf8"),
    )
    if (typeof parsed !== "object" || parsed === null) return undefined
    const record = parsed as Record<string, unknown>
    const pid = positiveInteger(record.pid)
    const port = positiveInteger(record.port)
    const parentPid = positiveInteger(record.parentPid ?? record.parent_pid)
    const instanceId =
      typeof record.instanceId === "string" ? record.instanceId : undefined
    if (
      pid === undefined
      || port === undefined
      || port > 65_535
      || (instanceId !== undefined && instanceId !== expectedIdentifier)
    ) {
      return undefined
    }
    return { pid, port, ...(parentPid === undefined ? {} : { parentPid }) }
  } catch {
    return undefined
  }
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM"
  }
}

async function requestShutdown(port: number): Promise<void> {
  const response = await fetch(`http://127.0.0.1:${port}/_internal/shutdown`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ reason: "app-dev relaunch" }),
    signal: AbortSignal.timeout(2000),
  })
  if (!response.ok) {
    throw new Error(
      `/_internal/shutdown on :${port} returned ${response.status}.`,
    )
  }
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Gracefully replace this profile's prior shell without probing or scanning
 * ports. The sidecar sentinel supplies its exact port and parent shell PID.
 */
export async function stopPriorDevSession(
  home: string,
  expectedIdentifier: string,
  dependencies: PriorSessionDependencies = {
    processIsAlive,
    requestShutdown,
    sleep,
    now: Date.now,
  },
): Promise<boolean> {
  const session = readPriorSession(home, expectedIdentifier)
  if (session === undefined) return false

  const sidecarAlive = dependencies.processIsAlive(session.pid)
  const parentAlive =
    session.parentPid !== undefined
    && dependencies.processIsAlive(session.parentPid)
  if (!sidecarAlive && !parentAlive) return false

  if (sidecarAlive) {
    await dependencies.requestShutdown(session.port)
  }
  // When the sidecar already died, do not signal the recorded parent PID:
  // a stale sentinel can outlive that shell and the OS can reuse its PID.
  // Development shells exit themselves after sidecar failure; wait for that.

  const deadline = dependencies.now() + PRIOR_SESSION_EXIT_TIMEOUT_MS
  while (dependencies.now() < deadline) {
    const waitingForSidecar = dependencies.processIsAlive(session.pid)
    const waitingForParent =
      session.parentPid !== undefined
      && dependencies.processIsAlive(session.parentPid)
    if (!waitingForSidecar && !waitingForParent) return true
    await dependencies.sleep(PRIOR_SESSION_POLL_INTERVAL_MS)
  }

  throw new Error(
    `Prior app:dev session did not exit within ${PRIOR_SESSION_EXIT_TIMEOUT_MS}ms.`,
  )
}

/** The generated override gives this worktree a distinct app identity. */
export function devConfig(identifier: string): {
  identifier: string
  productName: string
} {
  return { identifier, productName: "Maximal Dev" }
}

export function prepareAppDev(
  env: NodeJS.ProcessEnv,
  repoRoot: string,
): PreparedAppDev {
  const profile = resolveDevProfile(env, resolveWorktreeId(repoRoot))
  const explicitHome = env.COPILOT_API_HOME?.trim()
  const home = explicitHome ? path.resolve(repoRoot, explicitHome) : profile.home
  const configPath = path.join(repoRoot, DEV_CONFIG_RELATIVE_PATH)
  mkdirSync(path.dirname(configPath), { recursive: true })
  writeFileSync(
    configPath,
    `${JSON.stringify(devConfig(profile.identifier), null, 2)}\n`,
  )

  return {
    ...profile,
    home,
    configPath,
    // Do not manufacture a default COPILOT_API_HOME. Tauri and the shell own
    // that location; an explicit relative override is made launch-independent.
    env:
      explicitHome ?
        { ...env, COPILOT_API_HOME: home }
      : { ...env },
  }
}
