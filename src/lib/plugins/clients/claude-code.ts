/**
 * Claude Code's side of plugin MCP endpoints.
 *
 * Entries live in Claude Code's user scope (`~/.claude.json`, or
 * `$CLAUDE_CONFIG_DIR/.claude.json`) as HTTP servers pointing at Maximal's
 * stable `/mcp/<id>` URL, named after the plugin (so Work IQ's tools keep
 * their `mcp__workiq__*` names). Adds and removes go through the `claude`
 * CLI so Claude Code writes its own file.
 *
 * Keys never appear on a command line. `claude mcp add-json` gets a SHA-256
 * placeholder in the Authorization header; Maximal then swaps in the real key
 * with one atomic edit of that single header. Claude Code rewrites the file
 * often, so the swap is verified and retried, and the next reconcile (or
 * Settings read, via `repairKeys`) repairs any placeholder a lost race or a
 * running Claude Code's write-back left behind.
 *
 * Only entries Maximal recorded as written (`owned`) that still point at
 * Maximal's URL are ever changed or removed; a same-name entry the user
 * already had is reported as skipped. Entries are taken out at shutdown and
 * put back at boot: each Claude Code session reads the file when it starts,
 * so a session started while Maximal is down doesn't get a dead server.
 */

import consola from "consola"
import { createHash } from "node:crypto"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import {
  HELPER_LABEL,
  isProxyBaseUrlConfigured,
} from "~/apps/claude-code/config"
import { detectClaudeInstalls } from "~/apps/claude-code/detect"
import { atomicWriteJson } from "~/lib/platform/atomic-json"
import { parseJsonText } from "~/lib/platform/json-text"
import { runFile } from "~/lib/system/run-file"

import {
  isMaximalMcpUrl,
  type PluginClientConfigurator,
  type PluginClientEntry,
  type PluginReconcileResult,
} from "./sync"

const CLI_TIMEOUT_MS = 20_000
const KEY_SWAP_ATTEMPTS = 3

/** Runs `claude <args>`; rejects on failure. */
export type ClaudeCliRunner = (args: Array<string>) => Promise<void>

export interface ClaudeCodePluginClientOptions {
  configPath?: () => string
  /** Undefined runner means no usable `claude` binary was found. */
  runner?: () => Promise<ClaudeCliRunner | undefined>
  available?: () => Promise<boolean>
  integrationOn?: () => boolean
}

export function claudeUserConfigPath(): string {
  const dir = process.env.CLAUDE_CONFIG_DIR
  return dir ?
      path.join(dir, ".claude.json")
    : path.join(os.homedir(), ".claude.json")
}

async function defaultRunner(): Promise<ClaudeCliRunner | undefined> {
  // Windows .cmd/.ps1 shims need a shell, which would put JSON through shell
  // quoting; only a real executable is used. Detection stops at the first
  // `claude` on PATH, so when that is npm's claude.cmd, look again in the
  // places the native installer uses, without PATH.
  const usable = (candidate: { path: string }) =>
    process.platform !== "win32" || candidate.path.endsWith(".exe")
  const install =
    (await detectClaudeInstalls({ readVersion: () => null })).find(
      (candidate) => usable(candidate),
    )
    ?? (process.platform === "win32" ?
      (
        await detectClaudeInstalls({ readVersion: () => null, pathDirs: [] })
      ).find((candidate) => usable(candidate))
    : undefined)
  if (!install) return undefined
  return async (args) => {
    const result = await runFile(install.path, args, {
      timeoutMs: CLI_TIMEOUT_MS,
    })
    if (result.code !== 0) {
      throw new Error(
        result.stderr.trim() || `claude exited with code ${result.code}`,
      )
    }
  }
}

function readDocument(file: string): Record<string, unknown> | undefined {
  try {
    const parsed: unknown = parseJsonText(fs.readFileSync(file, "utf8"))
    return typeof parsed === "object" && parsed !== null ?
        (parsed as Record<string, unknown>)
      : undefined
  } catch {
    return undefined
  }
}

function readServers(file: string): Record<string, unknown> {
  const servers = readDocument(file)?.mcpServers
  return typeof servers === "object" && servers !== null ?
      (servers as Record<string, unknown>)
    : {}
}

/** Ours only when it is an HTTP entry for this plugin's Maximal URL, on
 *  whatever port Maximal used when it was written. */
export function isOwnedMcpEntry(value: unknown, id: string): boolean {
  if (typeof value !== "object" || value === null) return false
  const { type, url } = value as Record<string, unknown>
  return type === "http" && isMaximalMcpUrl(url, id)
}

function authorization(value: unknown): string | undefined {
  const headers = (value as { headers?: Record<string, unknown> } | undefined)
    ?.headers
  const header = headers?.Authorization
  return typeof header === "string" ? header : undefined
}

/** The Authorization value the client config should end up with. */
function bearer(apiKey: string): string {
  return `Bearer ${apiKey}`
}

export function keyPlaceholder(apiKey: string): string {
  return bearer(createHash("sha256").update(apiKey).digest("hex"))
}

/** The entry as `claude mcp add-json` receives it: never the real key. */
function addJsonPayload(entry: PluginClientEntry): string {
  return JSON.stringify({
    type: "http",
    url: entry.url,
    ...(entry.apiKey === undefined ?
      {}
    : { headers: { Authorization: keyPlaceholder(entry.apiKey) } }),
  })
}

/**
 * One verified atomic edit of the user config's `mcpServers`. Claude Code
 * rewrites this file often, so the edit is re-read and retried a few times.
 * `done` says whether the file is already in the wanted state; `apply`
 * mutates the servers map and returns false when it must not proceed.
 */
function editServers(
  file: string,
  edit: {
    done: (servers: Record<string, unknown>) => boolean
    apply: (servers: Record<string, unknown>) => boolean
  },
): boolean {
  for (let attempt = 0; attempt < KEY_SWAP_ATTEMPTS; attempt += 1) {
    const document = readDocument(file)
    if (!document) return false
    const servers = { ...(document.mcpServers as Record<string, unknown>) }
    if (edit.done(servers)) return true
    if (!edit.apply(servers)) return false
    atomicWriteJson(
      file,
      { ...document, mcpServers: servers },
      { label: "Claude Code user config" },
    )
    if (edit.done(readServers(file))) return true
  }
  return false
}

/** Replace only this entry's Authorization header in the user config. */
function swapInKey(file: string, id: string, apiKey: string): boolean {
  const wanted = bearer(apiKey)
  return editServers(file, {
    done: (servers) => authorization(servers[id]) === wanted,
    apply: (servers) => {
      const current = servers[id] as Record<string, unknown> | undefined
      if (!current || !isOwnedMcpEntry(current, id)) return false
      servers[id] = {
        ...current,
        headers: {
          ...(current.headers as Record<string, unknown> | undefined),
          Authorization: wanted,
        },
      }
      return true
    },
  })
}

/** Remove an owned entry without the CLI (shutdown has no time for it). */
function removeFromFile(file: string, id: string): boolean {
  return editServers(file, {
    done: (servers) => !isOwnedMcpEntry(servers[id], id),
    apply: (servers) => Reflect.deleteProperty(servers, id),
  })
}

function needsReplace(current: unknown, entry: PluginClientEntry): boolean {
  // A new port changes the URL, and adding or dropping a header changes the
  // entry's shape; either way, recreate it.
  const { url } = current as { url?: unknown }
  return (
    url !== entry.url
    || (authorization(current) === undefined) !== (entry.apiKey === undefined)
  )
}

export function createClaudeCodePluginClient(
  options: ClaudeCodePluginClientOptions = {},
): PluginClientConfigurator {
  const configPath = options.configPath ?? claudeUserConfigPath
  const getRunner = options.runner ?? defaultRunner
  const integrationOn =
    options.integrationOn ?? (() => isProxyBaseUrlConfigured())
  return {
    clientId: "claude-code",
    apiKeyLabel: HELPER_LABEL,
    available:
      options.available
      ?? (async () => integrationOn() && (await getRunner()) !== undefined),
    unavailableReason: () =>
      integrationOn() ?
        "Maximal could not find a Claude Code program it can run."
      : "Turn on Claude Code in Maximal first.",
    reconcile(desired, owned) {
      return reconcileUserScope({
        file: configPath(),
        desired,
        owned,
        getRunner,
      })
    },
    repairKeys(desired, owned) {
      const file = configPath()
      const existing = readServers(file)
      for (const entry of desired) {
        if (entry.apiKey === undefined || !owned.includes(entry.id)) continue
        const current = existing[entry.id]
        if (!isOwnedMcpEntry(current, entry.id)) continue
        const header = authorization(current)
        // No header at all is a different entry shape; reconcile recreates it.
        if (header === undefined || header === bearer(entry.apiKey)) continue
        if (swapInKey(file, entry.id, entry.apiKey)) {
          consola.info(
            `Put the key back into Claude Code MCP server "${entry.id}"`,
          )
        }
      }
    },
    releaseOffline(owned) {
      return releaseUserScope(configPath(), owned)
    },
  }
}

interface ReconcileInput {
  file: string
  desired: Array<PluginClientEntry>
  owned: Array<string>
  getRunner: () => Promise<ClaudeCliRunner | undefined>
}

type Run = (args: Array<string>) => Promise<boolean>

async function reconcileUserScope(
  input: ReconcileInput,
): Promise<PluginReconcileResult> {
  const { file, desired, owned } = input
  const existing = readServers(file)
  const result: PluginReconcileResult = {
    owned: [],
    added: [],
    removed: [],
    skipped: [],
  }
  let runner: Promise<ClaudeCliRunner | undefined> | undefined
  const run: Run = async (args) => {
    runner ??= input.getRunner()
    const claude = await runner
    if (!claude) return false
    try {
      await claude(args)
      return true
    } catch (error) {
      consola.warn(`claude ${args.slice(0, 2).join(" ")} failed`, error)
      return false
    }
  }
  const desiredIds = new Set(desired.map((entry) => entry.id))

  for (const id of owned) {
    if (desiredIds.has(id)) continue
    if (!isOwnedMcpEntry(existing[id], id)) continue
    if (await run(["mcp", "remove", "--scope", "user", id])) {
      result.removed.push(id)
    } else {
      result.owned.push(id)
    }
  }

  for (const entry of desired) {
    const outcome = await reconcileEntry({ entry, existing, owned, file, run })
    if (outcome === "skipped") result.skipped.push(entry.id)
    if (outcome === "added") result.added.push(entry.id)
    if (outcome !== "skipped" && outcome !== "failed") {
      result.owned.push(entry.id)
    }
  }
  return result
}

/** Remove every owned entry by editing the file: no CLI, no waiting. */
function releaseUserScope(
  file: string,
  owned: Array<string>,
): PluginReconcileResult {
  const existing = readServers(file)
  const result: PluginReconcileResult = {
    owned: [],
    added: [],
    removed: [],
    skipped: [],
  }
  for (const id of owned) {
    if (!isOwnedMcpEntry(existing[id], id)) continue
    if (removeFromFile(file, id)) result.removed.push(id)
    else result.owned.push(id)
  }
  return result
}

async function reconcileEntry(input: {
  entry: PluginClientEntry
  existing: Record<string, unknown>
  owned: Array<string>
  file: string
  run: Run
}): Promise<"added" | "kept" | "skipped" | "failed"> {
  const { entry, existing, owned, file, run } = input
  const current = existing[entry.id]
  const ours = owned.includes(entry.id) && isOwnedMcpEntry(current, entry.id)
  if (current !== undefined && !ours) return "skipped"

  let added = false
  if (current === undefined || needsReplace(current, entry)) {
    if (
      current !== undefined
      && !(await run(["mcp", "remove", "--scope", "user", entry.id]))
    ) {
      return "kept"
    }
    const ran = await run([
      "mcp",
      "add-json",
      "--scope",
      "user",
      entry.id,
      addJsonPayload(entry),
    ])
    // The CLI can write the entry and still fail (a timeout, say). If
    // Maximal's entry is there, carry on as if it had succeeded, so it is
    // recorded as owned and gets its key; otherwise the next pass would take
    // it for the user's own and never touch it again.
    if (!ran && !isOwnedMcpEntry(readServers(file)[entry.id], entry.id)) {
      return current === undefined ? "failed" : "kept"
    }
    added = current === undefined
  }
  if (entry.apiKey !== undefined && !swapInKey(file, entry.id, entry.apiKey)) {
    consola.warn(
      `Could not finish writing the key for Claude Code MCP server "${entry.id}"; will retry next time.`,
    )
  }
  return added ? "added" : "kept"
}

export const claudeCodePluginClient = createClaudeCodePluginClient()
