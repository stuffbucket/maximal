import type { PluginClientId } from "@stuffbucket/maximal-plugin-sdk/gateway"

import type { ApiKeyEntry } from "~/lib/config/config"

/** Product names are proper nouns and are shared by Settings and MCP messages. */
export const PLUGIN_CLIENT_NAMES: Readonly<Record<PluginClientId, string>> = {
  "claude-code": "Claude Code",
  "claude-desktop": "Claude Desktop",
  codex: "Codex",
  "copilot-cli": "Copilot CLI",
}

export const PLUGIN_CLIENT_IDS = Object.keys(
  PLUGIN_CLIENT_NAMES,
) as Array<PluginClientId>

export function pluginAppAccessId(clientId: PluginClientId): string {
  return `app:${clientId}`
}

export function pluginConnectionAccessId(connectionId: string): string {
  return `connection:${connectionId}`
}

/**
 * The caller presented an API key Maximal can't attribute to an app or a
 * named connection (disabled, deleted, rotated away, or a legacy bare key).
 * It is always Block: failing open would make revoking an app's key more
 * permissive than blocking the app.
 */
export const PLUGIN_UNIDENTIFIED_ACCESS_ID = "unidentified"

function normalizedLabel(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/gu, "-")
    .replaceAll(/^-|-$/gu, "")
}

/** An app-managed API key belongs to the app row rather than appearing twice. */
export function pluginClientForApiKeyLabel(
  label: string,
): PluginClientId | undefined {
  const normalized = normalizedLabel(label)
  return PLUGIN_CLIENT_IDS.find((clientId) => clientId === normalized)
}

/** Stable access target for an authenticated MCP caller. */
export function pluginAccessIdForApiKey(
  entry: Pick<ApiKeyEntry, "id" | "label">,
): string {
  const clientId = pluginClientForApiKeyLabel(entry.label)
  return clientId ?
      pluginAppAccessId(clientId)
    : pluginConnectionAccessId(entry.id)
}
