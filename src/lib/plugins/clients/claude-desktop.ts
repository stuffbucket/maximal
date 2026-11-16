import consola from "consola"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { isDeepStrictEqual } from "node:util"

import {
  atomicWriteJson,
  claudeDesktopMcpWritable,
  configLibraryConflict,
  DESKTOP_KEY_LABEL,
  getClaude3pDir,
  isConfigLibraryApplied,
} from "~/apps/claude-desktop/config"
import {
  MCP_COMMAND,
  MCP_STDIO_API_KEY_ENV,
  MCP_STDIO_SUBCOMMAND,
  MCP_STDIO_URL_FLAG,
} from "~/lib/mcp-stdio/command"
import {
  AtomicWriteConflictError,
  readFileNoFollow,
} from "~/lib/platform/atomic-json"
import { parseJsonText } from "~/lib/platform/json-text"
import { isPackagedPluginRuntime } from "~/lib/plugins/runner/production"

import {
  isMaximalAggregateMcpUrl,
  type PluginClientApplyResult,
  type PluginClientConfigurator,
  type PluginClientEntry,
  pluginAggregateMcpUrl,
} from "./sync"

const WRITE_ATTEMPTS = 3
export const DESKTOP_SERVER_NAME = "maximal"

export interface ClaudeDesktopPluginClientOptions {
  readonly configPath?: () => string
  readonly integrationOn?: () => boolean
  readonly writable?: () => boolean
  readonly resolveCommand?: () => string | undefined
}

type JsonObject = Record<string, unknown>

function isRecord(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

export function claudeDesktopConfigPath(home: string = os.homedir()): string {
  return path.join(getClaude3pDir(home), "claude_desktop_config.json")
}

/** Resolve only the installed Maximal executable, never Bun or a transient app. */
export function resolveAdapterCommand(
  executable: string = process.execPath,
  exists: (file: string) => boolean = fs.existsSync,
): string | undefined {
  const normalized = executable.replaceAll("\\", "/")
  if (
    !path.isAbsolute(executable)
    || !isPackagedPluginRuntime(executable)
    || normalized.includes("/AppTranslocation/")
    || normalized.startsWith("/Volumes/")
    || !exists(executable)
  ) {
    return undefined
  }
  return executable
}

function commandBasename(command: string): string {
  return command.replaceAll("\\", "/").split("/").at(-1)?.toLowerCase() ?? ""
}

/** Whether this exact Desktop entry carries Maximal's ownership signature. */
export function isMaximalDesktopEntry(name: string, value: unknown): boolean {
  if (name !== DESKTOP_SERVER_NAME || !isRecord(value)) return false
  const command = value.command
  const args = value.args
  if (
    typeof command !== "string"
    || !["maximal", "maximal.exe"].includes(commandBasename(command))
    || !Array.isArray(args)
    || args.length !== 4
  ) {
    return false
  }
  return (
    args[0] === MCP_COMMAND
    && args[1] === MCP_STDIO_SUBCOMMAND
    && args[2] === MCP_STDIO_URL_FLAG
    && isMaximalAggregateMcpUrl(args[3])
  )
}

function readDocument(file: string): { raw: string | null; value: JsonObject } {
  const raw = readFileNoFollow(
    file,
    () => new Error("refusing to read Claude Desktop config: symbolic link"),
  )
  if (raw === null) return { raw, value: {} }
  let parsed: unknown
  try {
    parsed = parseJsonText(raw)
  } catch {
    throw new Error(`Claude Desktop's config can't be read: ${file}`)
  }
  if (!isRecord(parsed)) {
    throw new Error(`Claude Desktop's config isn't a JSON object: ${file}`)
  }
  if (parsed.mcpServers !== undefined && !isRecord(parsed.mcpServers)) {
    throw new Error(`Claude Desktop's mcpServers isn't a JSON object: ${file}`)
  }
  return { raw, value: parsed }
}

function wantedEntry(
  current: unknown,
  desired: ReadonlyArray<PluginClientEntry>,
  command: string,
): JsonObject | undefined {
  const key = desired.at(0)?.apiKey?.trim()
  if (desired.length === 0 || !key) return undefined
  const existing = isRecord(current) ? current : {}
  const existingEnv = isRecord(existing.env) ? existing.env : {}
  return {
    ...existing,
    command,
    args: [
      MCP_COMMAND,
      MCP_STDIO_SUBCOMMAND,
      MCP_STDIO_URL_FLAG,
      pluginAggregateMcpUrl(),
    ],
    env: { ...existingEnv, [MCP_STDIO_API_KEY_ENV]: key },
  }
}

function nextDocument(
  document: JsonObject,
  desired: ReadonlyArray<PluginClientEntry>,
  command: string | undefined,
): { value: JsonObject; result: PluginClientApplyResult } {
  const servers = isRecord(document.mcpServers) ? document.mcpServers : {}
  const current = servers[DESKTOP_SERVER_NAME]
  const owned = isMaximalDesktopEntry(DESKTOP_SERVER_NAME, current)
  const result: PluginClientApplyResult = { written: [], removed: [] }

  if (desired.length > 0 && !command) return { value: document, result }
  const wanted = command ? wantedEntry(current, desired, command) : undefined
  const next = { ...servers }
  if (!wanted) {
    if (!owned) return { value: document, result }
    Reflect.deleteProperty(next, DESKTOP_SERVER_NAME)
    result.removed.push(DESKTOP_SERVER_NAME)
  } else {
    if (current !== undefined && !owned) {
      consola.warn(
        "Claude Desktop already has an MCP server named maximal; left it untouched.",
      )
      return { value: document, result }
    }
    if (isDeepStrictEqual(current, wanted)) return { value: document, result }
    next[DESKTOP_SERVER_NAME] = wanted
    result.written.push(DESKTOP_SERVER_NAME)
  }

  const value = { ...document }
  if (Object.keys(next).length === 0)
    Reflect.deleteProperty(value, "mcpServers")
  else value.mcpServers = next
  return { value, result }
}

function applyToFile(
  file: string,
  desired: ReadonlyArray<PluginClientEntry>,
  command: string | undefined,
): PluginClientApplyResult {
  let last: PluginClientApplyResult = { written: [], removed: [] }
  for (let attempt = 0; attempt < WRITE_ATTEMPTS; attempt += 1) {
    const snapshot = readDocument(file)
    if (snapshot.raw === null && desired.length === 0) return last
    const next = nextDocument(snapshot.value, desired, command)
    if (attempt === 0) last = next.result
    if (next.result.written.length === 0 && next.result.removed.length === 0) {
      return last
    }
    try {
      atomicWriteJson(file, next.value, snapshot.raw)
      return last
    } catch (error) {
      if (!(error instanceof AtomicWriteConflictError)) throw error
    }
  }
  throw new Error("Claude Desktop kept rewriting its config")
}

function unavailableReason(): string {
  const conflict = configLibraryConflict()
  if (conflict === "other-maximal-config") {
    return "Another Maximal profile manages Claude Desktop."
  }
  if (conflict) return "Claude Desktop's configuration needs attention first."
  return "Turn on Claude Desktop in Maximal first."
}

export function createClaudeDesktopPluginClient(
  options: ClaudeDesktopPluginClientOptions = {},
): PluginClientConfigurator {
  const configPath = options.configPath ?? claudeDesktopConfigPath
  const integrationOn = options.integrationOn ?? isConfigLibraryApplied
  const writable = options.writable ?? claudeDesktopMcpWritable
  const command = options.resolveCommand ?? resolveAdapterCommand
  return {
    clientId: "claude-desktop",
    apiKeyLabel: DESKTOP_KEY_LABEL,
    available: integrationOn,
    unavailableReason,
    standalone: () => undefined,
    apply(desired) {
      if (!writable()) return { written: [], removed: [] }
      return applyToFile(configPath(), desired, command())
    },
  }
}

export const claudeDesktopPluginClient = createClaudeDesktopPluginClient()
