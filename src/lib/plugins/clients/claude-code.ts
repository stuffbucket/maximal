/**
 * Claude Code's side of connector MCP endpoints.
 *
 * Each connector the user sends to Claude Code is an HTTP server in Claude
 * Code's user scope (`~/.claude.json`, or `$CLAUDE_CONFIG_DIR/.claude.json`)
 * named `maximal-<id>` and pointing at Maximal's `/mcp/<id>`, so its tools
 * are `mcp__maximal-<id>__*`. Maximal edits the file itself: one verified
 * atomic write per pass, re-read and retried because Claude Code rewrites
 * the file often. A pass writes only when something differs.
 *
 * An entry is Maximal's when it is named `maximal-<id>` and is an HTTP entry
 * for `/mcp/<id>` on 127.0.0.1 (any port, so a port change rewrites it).
 * Nothing else is changed. Entries stay while Maximal is stopped: Claude
 * Code shows the server as failing to connect, and the name says why.
 *
 * The user's own setup of the same service wins: a Claude Code server or
 * enabled plugin named `<id>` (Microsoft's `workiq`, say) means Maximal adds
 * no `maximal-<id>`, and Settings says why (`standalone`).
 */

import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import {
  getClaudeCodeSettingsPath,
  HELPER_LABEL,
} from "~/apps/claude-code/config"
import { claudeCodeRoutingIntended } from "~/apps/claude-code/reconcile"
import { atomicWriteJson } from "~/lib/platform/atomic-json"
import { parseJsonText } from "~/lib/platform/json-text"

import {
  isMaximalMcpUrl,
  type PluginClientApplyResult,
  type PluginClientConfigurator,
  type PluginClientEntry,
  type StandaloneInstall,
} from "./sync"

const WRITE_ATTEMPTS = 3
export const ENTRY_PREFIX = "maximal-"

export interface ClaudeCodePluginClientOptions {
  configPath?: () => string
  settingsPath?: () => string
  integrationOn?: () => boolean
}

export function claudeUserConfigPath(): string {
  const dir = process.env.CLAUDE_CONFIG_DIR
  return dir ?
      path.join(dir, ".claude.json")
    : path.join(os.homedir(), ".claude.json")
}

/** The name of Maximal's entry for plugin `id`. */
export function entryName(id: string): string {
  return `${ENTRY_PREFIX}${id}`
}

type Servers = Record<string, unknown>

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function readDocument(file: string): Record<string, unknown> | undefined {
  try {
    const parsed: unknown = parseJsonText(fs.readFileSync(file, "utf8"))
    return isRecord(parsed) ? parsed : undefined
  } catch {
    return undefined
  }
}

function readServers(file: string): Servers {
  const servers = readDocument(file)?.mcpServers
  return isRecord(servers) ? servers : {}
}

/** An HTTP entry for plugin `id`'s Maximal URL, on whatever port. */
function pointsAtMaximal(value: unknown, id: string): boolean {
  return (
    isRecord(value) && value.type === "http" && isMaximalMcpUrl(value.url, id)
  )
}

/** Whether `name` → `value` is an entry Maximal wrote (`maximal-<id>`). */
export function isMaximalEntry(name: string, value: unknown): boolean {
  if (!name.startsWith(ENTRY_PREFIX)) return false
  return pointsAtMaximal(value, name.slice(ENTRY_PREFIX.length))
}

function wantedEntry(entry: PluginClientEntry): Record<string, unknown> {
  return {
    type: "http",
    url: entry.url,
    ...(entry.apiKey === undefined ?
      {}
    : { headers: { Authorization: `Bearer ${entry.apiKey}` } }),
  }
}

function sameEntry(current: unknown, wanted: Record<string, unknown>): boolean {
  if (!isRecord(current)) return false
  const { type, url, headers } = current
  return JSON.stringify({ type, url, headers }) === JSON.stringify(wanted)
}

/**
 * The servers map as it should be: Maximal's entries exactly `desired`,
 * legacy entries (named `<id>`, from older versions) removed, everything
 * else untouched. A `maximal-<id>` name the user took for something else
 * is left alone.
 */
function nextServers(
  servers: Servers,
  desired: ReadonlyArray<PluginClientEntry>,
  legacy: ReadonlyArray<string>,
): { servers: Servers; result: PluginClientApplyResult } {
  const next: Servers = { ...servers }
  const result: PluginClientApplyResult = { written: [], removed: [] }
  const wantedNames = new Set(desired.map((entry) => entryName(entry.id)))
  for (const [name, value] of Object.entries(servers)) {
    const stale = isMaximalEntry(name, value) && !wantedNames.has(name)
    const old = legacy.includes(name) && pointsAtMaximal(value, name)
    if (stale || old) {
      Reflect.deleteProperty(next, name)
      result.removed.push(name)
    }
  }
  for (const entry of desired) {
    const name = entryName(entry.id)
    const current = next[name]
    if (current !== undefined && !isMaximalEntry(name, current)) continue
    const wanted = wantedEntry(entry)
    if (sameEntry(current, wanted)) continue
    next[name] = wanted
    result.written.push(name)
  }
  return { servers: next, result }
}

/** One pass over the user config; see the module comment. */
function applyToFile(
  file: string,
  desired: ReadonlyArray<PluginClientEntry>,
  legacy: ReadonlyArray<string>,
): PluginClientApplyResult {
  let last: PluginClientApplyResult = { written: [], removed: [] }
  for (let attempt = 0; attempt < WRITE_ATTEMPTS; attempt += 1) {
    const document = readDocument(file)
    if (!document) {
      // Never replace a config that is there but unreadable (and keep the
      // legacy record for a pass that can read it).
      if (fs.existsSync(file))
        throw new Error(`Claude Code's user config can't be read: ${file}`)
      // Without one, create it only to add something.
      if (desired.length === 0) return last
    }
    const servers = isRecord(document?.mcpServers) ? document.mcpServers : {}
    const { servers: next, result } = nextServers(servers, desired, legacy)
    if (attempt === 0) last = result
    if (result.written.length === 0 && result.removed.length === 0) return last
    atomicWriteJson(
      file,
      { ...document, mcpServers: next },
      { label: "Claude Code user config" },
    )
  }
  throw new Error("Claude Code kept rewriting its user config")
}

/** A user server or enabled plugin named `id`. */
function findStandalone(
  id: string,
  servers: Servers,
  settingsFile: string,
): StandaloneInstall | undefined {
  const wanted = id.toLowerCase()
  const server = Object.keys(servers).find(
    (name) =>
      name.toLowerCase() === wanted && !pointsAtMaximal(servers[name], id),
  )
  if (server !== undefined) return { name: server, source: "server" }
  const plugins = readDocument(settingsFile)?.enabledPlugins
  if (!isRecord(plugins)) return undefined
  const plugin = Object.keys(plugins).find(
    (key) =>
      plugins[key] === true && key.split("@")[0]?.toLowerCase() === wanted,
  )
  return plugin === undefined ? undefined : { name: plugin, source: "plugin" }
}

export function createClaudeCodePluginClient(
  options: ClaudeCodePluginClientOptions = {},
): PluginClientConfigurator {
  const configPath = options.configPath ?? claudeUserConfigPath
  const settingsPath = options.settingsPath ?? getClaudeCodeSettingsPath
  const integrationOn = options.integrationOn ?? claudeCodeRoutingIntended
  return {
    clientId: "claude-code",
    apiKeyLabel: HELPER_LABEL,
    available: integrationOn,
    unavailableReason: () => "Turn on Claude Code in Maximal first.",
    standalone: (id) =>
      findStandalone(id, readServers(configPath()), settingsPath()),
    apply: (desired, legacy) => applyToFile(configPath(), desired, legacy),
  }
}

export const claudeCodePluginClient = createClaudeCodePluginClient()
