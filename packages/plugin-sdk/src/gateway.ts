/**
 * The gateway seam: what the app core (`src/`) sees of the plugin system.
 *
 * Cordis-free by construction — this module has no runtime imports at all
 * (only `import type`), so importing it can never pull cordis or plugin code
 * into the core. The only runtime values are `PluginGatewayError` and its
 * guard.
 */
import type {
  PluginStatus,
  ToolAnnotations,
  ToolCallContext,
  ToolDefinitionPublic,
  ToolResult,
} from "./types"

/** Clients Maximal can register a plugin's MCP endpoint with. */
export type PluginClientId = "claude-code"

/** One `config.json` → `plugins.<id>` entry. Absent ⇒ disabled. */
export interface PluginSettingsEntry {
  enabled?: boolean
  config?: unknown
  clients?: Array<PluginClientId>
}

export type PluginSettings = Record<string, PluginSettingsEntry>

export type PluginLifecycle = "disabled" | "starting" | "active" | "failed"

export interface PluginToolSummary {
  name: string
  title?: string
  description: string
  annotations?: ToolAnnotations
}

export interface PluginSnapshot {
  id: string
  displayName: string
  description: string
  homepage?: string
  /** Desired state from the last reconcile. */
  enabled: boolean
  lifecycle: PluginLifecycle
  /** Why the plugin failed (path-qualified config issues, apply error). */
  error?: string
  /** Last `ctx.surface.setStatus` of the running plugin. */
  status?: PluginStatus
  /** Empty unless the plugin is active. */
  tools: Array<PluginToolSummary>
}

export type PluginGatewayEventType = "lifecycle" | "status" | "tools"

export interface PluginGatewayEvent {
  type: PluginGatewayEventType
  pluginId: string
}

export interface PluginGateway {
  /**
   * Start/stop/reload plugin fibers to match `settings`. Serialised; failures
   * are isolated per plugin and reported via `lifecycle: "failed"` + `error`.
   * Unknown ids in `settings` are ignored.
   */
  reconcile(settings: PluginSettings | undefined): Promise<void>
  list(): Array<PluginSnapshot>
  get(id: string): PluginSnapshot | undefined
  /** Throws `unknown-plugin`; returns `[]` while the plugin is not active. */
  listTools(pluginId: string): Array<ToolDefinitionPublic>
  /**
   * Throws `unknown-plugin` / `plugin-inactive` / `unknown-tool`. A tool that
   * throws resolves to `{ isError: true, content: [{ type: "text", text }] }`.
   */
  callTool(
    pluginId: string,
    name: string,
    input: Record<string, unknown>,
    call: ToolCallContext,
  ): Promise<ToolResult>
  /** Throws `unknown-plugin` / `plugin-inactive` / `unknown-action`; rejects if the handler throws. */
  runAction(
    pluginId: string,
    actionId: string,
    signal?: AbortSignal,
  ): Promise<void>
  subscribe(listener: (event: PluginGatewayEvent) => void): () => void
  /** Stops every plugin. Idempotent. */
  dispose(): Promise<void>
}

export type PluginGatewayErrorCode =
  | "unknown-plugin"
  | "plugin-inactive"
  | "unknown-tool"
  | "unknown-action"

export class PluginGatewayError extends Error {
  readonly code: PluginGatewayErrorCode
  readonly pluginId: string

  constructor(code: PluginGatewayErrorCode, pluginId: string, message: string) {
    super(message)
    this.name = "PluginGatewayError"
    this.code = code
    this.pluginId = pluginId
  }
}

/** Structural guard (works across duplicated module copies). */
export function isPluginGatewayError(
  error: unknown,
): error is PluginGatewayError {
  if (error instanceof PluginGatewayError) return true
  if (!(error instanceof Error) || error.name !== "PluginGatewayError")
    return false
  const code: unknown = (error as { code?: unknown }).code
  return (
    code === "unknown-plugin"
    || code === "plugin-inactive"
    || code === "unknown-tool"
    || code === "unknown-action"
  )
}

export {
  type ElicitRequest,
  type ElicitResult,
  type JsonSchemaObject,
  type PluginStatus,
  type PluginStatusAction,
  type PluginStatusState,
  type ToolAnnotations,
  type ToolCallContext,
  type ToolContent,
  type ToolDefinitionPublic,
  type ToolProgress,
  type ToolResult,
} from "./types"
