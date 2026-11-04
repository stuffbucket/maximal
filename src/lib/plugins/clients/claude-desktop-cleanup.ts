/**
 * One-shot cleanup of the Claude Desktop MCP entries the parked broker
 * strategy wrote.
 *
 * Claude Desktop ran Maximal's endpoints through the broker's stdio adapter
 * (`maximal-mcp-broker[.exe] stdio-adapter --url …/mcp/<id>`), and those
 * entries stayed across restarts. This build ships no broker, so on boot
 * Maximal removes the entries it recorded as its own
 * (`apps.claudeDesktop.mcpServers`) that still run the adapter, then clears
 * the record. Entries the user changed to something else are left alone.
 */

import consola from "consola"
import path from "node:path"

import {
  atomicWriteJson,
  getClaude3pDir,
  readJsonObject,
} from "~/apps/claude-desktop/config"
import { getConfig, writeConfig } from "~/lib/config/config"

const BROKER_NAMES = new Set(["maximal-mcp-broker", "maximal-mcp-broker.exe"])

export function claudeDesktopConfigPath(): string {
  return path.join(getClaude3pDir(), "claude_desktop_config.json")
}

/** An entry that runs the old broker's stdio adapter. */
export function isBrokerAdapterEntry(value: unknown): boolean {
  if (typeof value !== "object" || value === null) return false
  const { command } = value as Record<string, unknown>
  if (typeof command !== "string") return false
  return BROKER_NAMES.has(path.basename(command.replaceAll("\\", "/")))
}

/** Returns the ids it removed. File-only and synchronous; never throws. */
export function removeLegacyClaudeDesktopEntries(
  file: string = claudeDesktopConfigPath(),
): Array<string> {
  try {
    const config = getConfig()
    const desktop = config.apps?.claudeDesktop
    const owned = desktop?.mcpServers
    if (!desktop || owned === undefined) return []

    const removed: Array<string> = []
    const document = readJsonObject(file)
    const servers = document?.mcpServers
    if (document && typeof servers === "object" && servers !== null) {
      const next = { ...(servers as Record<string, unknown>) }
      for (const id of owned) {
        if (!isBrokerAdapterEntry(next[id])) continue
        Reflect.deleteProperty(next, id)
        removed.push(id)
      }
      if (removed.length > 0) {
        atomicWriteJson(file, { ...document, mcpServers: next })
      }
    }

    const cleared = { ...desktop }
    Reflect.deleteProperty(cleared, "mcpServers")
    writeConfig({ ...config, apps: { ...config.apps, claudeDesktop: cleared } })
    if (removed.length > 0) {
      consola.info(
        `Removed old MCP servers from Claude Desktop: ${removed.join(", ")}`,
      )
    }
    return removed
  } catch (error) {
    consola.warn("Could not remove old MCP servers from Claude Desktop", error)
    return []
  }
}
