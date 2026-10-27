/**
 * Claude Code's side of brokered MCP endpoints.
 *
 * Entries live in Claude Code's user scope (`~/.claude.json`, or
 * `$CLAUDE_CONFIG_DIR/.claude.json`) as HTTP servers pointing at Maximal's
 * stable `/mcp/<id>` URL. Adds and removes go through the `claude` CLI so
 * Claude Code writes its own file.
 *
 * Keys never appear on a command line. `claude mcp add-json` gets a SHA-256
 * placeholder in the Authorization header; Maximal then swaps in the real key
 * with one atomic edit of that single header. Claude Code rewrites the file
 * often, so the swap is verified and retried, and the next reconcile repairs
 * any placeholder a lost race left behind.
 *
 * Only entries Maximal recorded as written (`owned`) that still point at
 * Maximal's URL are ever changed or removed; a same-name entry the user
 * already had is reported as skipped.
 */

import consola from "consola"
import { execFileSync } from "node:child_process"
import { createHash } from "node:crypto"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import type {
  McpClientConfigurator,
  McpClientEntry,
  McpReconcileResult,
} from "~/lib/mcp-broker/client-sync"

import {
  isMaximalMcpUrl,
  mcpEndpointUrl,
  parseStdioEntry,
} from "~/lib/mcp-broker/client-sync"
import { atomicWriteJson } from "~/lib/platform/atomic-json"

import { HELPER_LABEL, isProxyBaseUrlConfigured } from "./config"
import { detectClaudeInstalls } from "./detect"

const CLI_TIMEOUT_MS = 20_000
const KEY_SWAP_ATTEMPTS = 3

/** Runs `claude <args>`; throws on failure. */
export type ClaudeCliRunner = (args: Array<string>) => void

export interface ClaudeCodeMcpOptions {
  configPath?: () => string
  /** Undefined runner means no usable `claude` binary was found. */
  runner?: () => ClaudeCliRunner | undefined
  available?: () => boolean
}

export function claudeUserConfigPath(): string {
  const dir = process.env.CLAUDE_CONFIG_DIR
  return dir ?
      path.join(dir, ".claude.json")
    : path.join(os.homedir(), ".claude.json")
}

function defaultRunner(): ClaudeCliRunner | undefined {
  // Windows .cmd/.ps1 shims need a shell, which would put JSON through shell
  // quoting; only a real executable is used.
  const install = detectClaudeInstalls({ readVersion: () => null }).find(
    (candidate) =>
      process.platform !== "win32" || candidate.path.endsWith(".exe"),
  )
  if (!install) return undefined
  return (args) => {
    execFileSync(install.path, args, {
      timeout: CLI_TIMEOUT_MS,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    })
  }
}

function readServers(file: string): Record<string, unknown> {
  try {
    // eslint-disable-next-line unicorn/prefer-json-parse-buffer -- JSON.parse's type only accepts string
    const parsed: unknown = JSON.parse(fs.readFileSync(file, "utf8"))
    const servers = (parsed as { mcpServers?: unknown } | null)?.mcpServers
    return typeof servers === "object" && servers !== null ?
        (servers as Record<string, unknown>)
      : {}
  } catch {
    return {}
  }
}

/** Ours only when it is an HTTP entry for this endpoint's Maximal URL, on
 *  whatever port Maximal used when it was written. */
export function isOwnedMcpEntry(
  value: unknown,
  entry: Pick<McpClientEntry, "id">,
): boolean {
  if (typeof value !== "object" || value === null) return false
  const { type, url } = value as Record<string, unknown>
  return type === "http" && isMaximalMcpUrl(url, entry.id)
}

function authorization(value: unknown): string | undefined {
  const headers = (value as { headers?: Record<string, unknown> } | undefined)
    ?.headers
  const header = headers?.Authorization
  return typeof header === "string" ? header : undefined
}

export function keyPlaceholder(apiKey: string): string {
  return `Bearer ${createHash("sha256").update(apiKey).digest("hex")}`
}

/** The entry as `claude mcp add-json` receives it: never the real key. */
function addJsonPayload(entry: McpClientEntry): string {
  return JSON.stringify({
    type: "http",
    url: entry.url,
    ...(entry.apiKey === undefined ?
      {}
    : { headers: { Authorization: keyPlaceholder(entry.apiKey) } }),
  })
}

function readDocument(file: string): Record<string, unknown> | undefined {
  try {
    // eslint-disable-next-line unicorn/prefer-json-parse-buffer -- JSON.parse's type only accepts string
    const parsed: unknown = JSON.parse(fs.readFileSync(file, "utf8"))
    return typeof parsed === "object" && parsed !== null ?
        (parsed as Record<string, unknown>)
      : undefined
  } catch {
    return undefined
  }
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
function swapInKey(
  file: string,
  entry: McpClientEntry,
  apiKey: string,
): boolean {
  const wanted = `Bearer ${apiKey}`
  return editServers(file, {
    done: (servers) => authorization(servers[entry.id]) === wanted,
    apply: (servers) => {
      const current = servers[entry.id] as Record<string, unknown> | undefined
      if (!current || !isOwnedMcpEntry(current, entry)) return false
      servers[entry.id] = {
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
function removeFromFile(file: string, entry: McpClientEntry): boolean {
  return editServers(file, {
    done: (servers) => !isOwnedMcpEntry(servers[entry.id], entry),
    apply: (servers) => Reflect.deleteProperty(servers, entry.id),
  })
}

function needsReplace(current: unknown, entry: McpClientEntry): boolean {
  // A new port changes the URL, and adding or dropping a header changes the
  // entry's shape; either way, recreate it.
  const { url } = current as { url?: unknown }
  return (
    url !== entry.url
    || (authorization(current) === undefined) !== (entry.apiKey === undefined)
  )
}

export function createClaudeCodeMcp(
  options: ClaudeCodeMcpOptions = {},
): McpClientConfigurator {
  const configPath = options.configPath ?? claudeUserConfigPath
  const getRunner = options.runner ?? defaultRunner
  return {
    clientId: "claude-code",
    apiKeyLabel: HELPER_LABEL,
    // Each session reads the file when it starts, like the base URL that
    // shutdown also reverts (see ./reconcile.ts).
    removeOnShutdown: true,
    available:
      options.available
      ?? (() => isProxyBaseUrlConfigured() && getRunner() !== undefined),
    reconcile(desired, owned, reconcileOptions) {
      return reconcileUserScope({
        file: configPath(),
        desired,
        owned,
        getRunner,
        offline: reconcileOptions?.offline === true,
      })
    },
    existingStdioEntry(id, owned) {
      const value = readServers(configPath())[id]
      if (owned.includes(id) && isOwnedMcpEntry(value, { id })) return undefined
      return parseStdioEntry(value)
    },
  }
}

interface ReconcileInput {
  file: string
  desired: Array<McpClientEntry>
  owned: Array<string>
  getRunner: () => ClaudeCliRunner | undefined
  offline: boolean
}

function reconcileUserScope(input: ReconcileInput): McpReconcileResult {
  const { file, desired, owned } = input
  const existing = readServers(file)
  const result: McpReconcileResult = {
    owned: [],
    added: [],
    removed: [],
    skipped: [],
  }
  let runner: ClaudeCliRunner | undefined
  let runnerResolved = false
  const run = (args: Array<string>): boolean => {
    if (input.offline) return false
    if (!runnerResolved) {
      runner = input.getRunner()
      runnerResolved = true
    }
    if (!runner) return false
    try {
      runner(args)
      return true
    } catch (error) {
      consola.warn(`claude ${args.slice(0, 2).join(" ")} failed`, error)
      return false
    }
  }
  const desiredIds = new Set(desired.map((entry) => entry.id))

  for (const id of owned) {
    if (desiredIds.has(id)) continue
    const ours = { id, label: id, url: mcpEndpointUrl(id) }
    if (!isOwnedMcpEntry(existing[id], ours)) continue
    const removed =
      input.offline ?
        removeFromFile(file, ours)
      : run(["mcp", "remove", "--scope", "user", id])
    if (removed) result.removed.push(id)
    else result.owned.push(id)
  }

  for (const entry of desired) {
    const outcome = reconcileEntry({ entry, existing, owned, file, run })
    if (outcome === "skipped") result.skipped.push(entry.id)
    if (outcome === "added") result.added.push(entry.id)
    if (outcome !== "skipped" && outcome !== "failed") {
      result.owned.push(entry.id)
    }
  }
  return result
}

function reconcileEntry(input: {
  entry: McpClientEntry
  existing: Record<string, unknown>
  owned: Array<string>
  file: string
  run: (args: Array<string>) => boolean
}): "added" | "kept" | "skipped" | "failed" {
  const { entry, existing, owned, file, run } = input
  const current = existing[entry.id]
  const ours = owned.includes(entry.id) && isOwnedMcpEntry(current, entry)
  if (current !== undefined && !ours) return "skipped"

  let added = false
  if (current === undefined || needsReplace(current, entry)) {
    if (
      current !== undefined
      && !run(["mcp", "remove", "--scope", "user", entry.id])
    ) {
      return "kept"
    }
    if (
      !run([
        "mcp",
        "add-json",
        "--scope",
        "user",
        entry.id,
        addJsonPayload(entry),
      ])
    ) {
      return current === undefined ? "failed" : "kept"
    }
    added = current === undefined
  }
  if (entry.apiKey !== undefined && !swapInKey(file, entry, entry.apiKey)) {
    consola.warn(
      `Could not finish writing the key for Claude Code MCP server "${entry.id}"; will retry next time.`,
    )
  }
  return added ? "added" : "kept"
}

export const claudeCodeMcp = createClaudeCodeMcp()
