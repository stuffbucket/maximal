import os from "node:os"
import path from "node:path"

import {
  atomicWriteJson,
  claudeDesktopMcpWritable,
  configLibraryConflict,
  DESKTOP_KEY_LABEL,
  getClaude3pDir,
  isConfigLibraryApplied,
} from "~/apps/claude-desktop/config"
import {
  type ClaudeDesktopManagedMcpServer,
  maximalDesktopManagedMcpServer,
} from "~/apps/claude-desktop/managed-mcp"
import {
  type ClaudeDesktopManagedMcpUpdate,
  updateConfigLibraryManagedMcpServers,
} from "~/apps/claude-desktop/managed-mcp-profile"
import {
  MCP_COMMAND,
  MCP_STDIO_SUBCOMMAND,
  MCP_STDIO_URL_FLAG,
} from "~/lib/mcp-stdio/command"
import {
  AtomicWriteConflictError,
  readFileNoFollow,
} from "~/lib/platform/atomic-json"
import { parseJsonText } from "~/lib/platform/json-text"

import {
  isMaximalAggregateMcpUrl,
  type PluginClientApplyResult,
  type PluginClientConfigurator,
  type PluginClientEntry,
  type PluginClientUnavailableReason,
  pluginAggregateMcpUrl,
} from "./sync"

const WRITE_ATTEMPTS = 3
export const DESKTOP_SERVER_NAME = "maximal"

export interface ClaudeDesktopPluginClientOptions {
  readonly configPath?: () => string
  readonly integrationOn?: () => boolean
  readonly writable?: () => boolean
  readonly updateManagedServers?: (
    servers: ReadonlyArray<ClaudeDesktopManagedMcpServer>,
  ) => ClaudeDesktopManagedMcpUpdate
}

type JsonObject = Record<string, unknown>

function isRecord(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

export function claudeDesktopConfigPath(home: string = os.homedir()): string {
  return path.join(getClaude3pDir(home), "claude_desktop_config.json")
}

function commandBasename(command: string): string {
  return command.replaceAll("\\", "/").split("/").at(-1)?.toLowerCase() ?? ""
}

/** The aggregate stdio entry written by the previous Desktop configurator. */
export function isLegacyMaximalDesktopEntry(
  name: string,
  value: unknown,
): boolean {
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

/** Remove only the signed stdio entry older Maximal builds projected. */
function removeLegacyEntry(file: string): boolean {
  for (let attempt = 0; attempt < WRITE_ATTEMPTS; attempt += 1) {
    const snapshot = readDocument(file)
    if (snapshot.raw === null) return false
    const servers =
      isRecord(snapshot.value.mcpServers) ? snapshot.value.mcpServers : {}
    const current = servers[DESKTOP_SERVER_NAME]
    if (!isLegacyMaximalDesktopEntry(DESKTOP_SERVER_NAME, current)) return false
    const nextServers = { ...servers }
    Reflect.deleteProperty(nextServers, DESKTOP_SERVER_NAME)
    const nextDocument = { ...snapshot.value }
    if (Object.keys(nextServers).length === 0) {
      Reflect.deleteProperty(nextDocument, "mcpServers")
    } else {
      nextDocument.mcpServers = nextServers
    }
    try {
      atomicWriteJson(file, nextDocument, snapshot.raw)
      return true
    } catch (error) {
      if (!(error instanceof AtomicWriteConflictError)) throw error
    }
  }
  throw new Error("Claude Desktop kept rewriting its config")
}

function wantedServers(
  desired: ReadonlyArray<PluginClientEntry>,
): Array<ClaudeDesktopManagedMcpServer> {
  const key = desired.at(0)?.apiKey?.trim()
  if (desired.length === 0 || !key) return []
  return [maximalDesktopManagedMcpServer(pluginAggregateMcpUrl(), key)]
}

function applyManagedServers(
  desired: ReadonlyArray<PluginClientEntry>,
  update: NonNullable<ClaudeDesktopPluginClientOptions["updateManagedServers"]>,
  legacyFile: string,
): PluginClientApplyResult {
  const wanted = wantedServers(desired)
  const changed = update(wanted)
  const removedLegacy = removeLegacyEntry(legacyFile)
  return {
    written:
      changed === "written" || (removedLegacy && wanted.length > 0) ?
        [DESKTOP_SERVER_NAME]
      : [],
    removed:
      changed === "removed" || (removedLegacy && wanted.length === 0) ?
        [DESKTOP_SERVER_NAME]
      : [],
  }
}

function unavailableReason(): PluginClientUnavailableReason {
  const conflict = configLibraryConflict()
  if (conflict === "other-maximal-config") {
    return {
      kind: "custom",
      reason: "Another Maximal profile manages Claude Desktop.",
    }
  }
  if (conflict) {
    return {
      kind: "custom",
      reason: "Claude Desktop's configuration needs attention first.",
    }
  }
  return { kind: "app-off" }
}

export function createClaudeDesktopPluginClient(
  options: ClaudeDesktopPluginClientOptions = {},
): PluginClientConfigurator {
  const configPath = options.configPath ?? claudeDesktopConfigPath
  const integrationOn = options.integrationOn ?? isConfigLibraryApplied
  const writable = options.writable ?? claudeDesktopMcpWritable
  const update =
    options.updateManagedServers ?? updateConfigLibraryManagedMcpServers
  return {
    clientId: "claude-desktop",
    apiKeyLabel: DESKTOP_KEY_LABEL,
    available: integrationOn,
    unavailableReason,
    standalone: () => undefined,
    apply(desired) {
      if (!writable()) return { written: [], removed: [] }
      return applyManagedServers(desired, update, configPath())
    },
  }
}

export const claudeDesktopPluginClient = createClaudeDesktopPluginClient()
