/**
 * Runtime-neutral plugin contract types.
 *
 * This module must never import cordis (not even as a type): it is shared by
 * the cordis-facing SDK entry (`./index.ts`) and the cordis-free gateway seam
 * (`./gateway.ts`) that the app core consumes.
 */

/** Stable plugin id: also the MCP server name and the storage directory. */
export const PLUGIN_ID_PATTERN = /^[a-z][a-z0-9-]{1,31}$/

/** Tool name, unique within one plugin (MCP tool-name compatible). */
export const TOOL_NAME_PATTERN = /^[\w-]{1,64}$/

/** Surface action id (e.g. `sign-in`), unique within one plugin. */
export const ACTION_ID_PATTERN = /^[a-z0-9][\w.-]{0,63}$/i

/** Storage file name: a single path segment, no leading dot. */
export const STORAGE_NAME_PATTERN = /^[a-z0-9][\w.-]{0,127}$/i

/** Names of the services the plugin host provides on `ctx`. */
export const PLUGIN_SERVICE_NAMES = [
  "tools",
  "surface",
  "storage",
  "host",
] as const
export type PluginServiceName = (typeof PLUGIN_SERVICE_NAMES)[number]

/** Human-facing plugin metadata shown in Settings. */
export interface PluginMeta {
  readonly displayName: string
  readonly description: string
  readonly homepage?: string
}

/** A JSON Schema object (MCP `inputSchema` / `outputSchema` shape). */
export interface JsonSchemaObject {
  type: "object"
  properties?: Record<string, unknown>
  required?: Array<string>
  [key: string]: unknown
}

/** MCP tool annotations (hints only; never trusted for security decisions). */
export interface ToolAnnotations {
  title?: string
  readOnlyHint?: boolean
  destructiveHint?: boolean
  idempotentHint?: boolean
  openWorldHint?: boolean
}

/** MCP content block (CallToolResult-compatible). */
export type ToolContent =
  | { type: "text"; text: string; [key: string]: unknown }
  | { type: "image"; data: string; mimeType: string; [key: string]: unknown }
  | { type: "audio"; data: string; mimeType: string; [key: string]: unknown }
  | { type: "resource_link"; uri: string; name: string; [key: string]: unknown }
  | {
      type: "resource"
      resource: { uri: string; [key: string]: unknown }
      [key: string]: unknown
    }

/** MCP CallToolResult-compatible tool result. */
export interface ToolResult {
  content: Array<ToolContent>
  structuredContent?: Record<string, unknown>
  isError?: boolean
}

export interface ToolProgress {
  progress: number
  total?: number
  message?: string
}

export interface ElicitRequest {
  message: string
  requestedSchema: JsonSchemaObject
}

export interface ElicitResult {
  action: "accept" | "decline" | "cancel"
  content?: Record<string, unknown>
}

/** Per-call context handed to `ToolDefinition.execute`. */
export interface ToolCallContext {
  /** Aborts when the client cancels or the plugin is stopped. */
  signal: AbortSignal
  /** Downstream MCP session id, when the client has one. */
  sessionId?: string
  /** Present when the client asked for progress notifications. */
  progress?(update: ToolProgress): void
  /** Present when the client supports elicitation. */
  elicit?(request: ElicitRequest): Promise<ElicitResult>
}

/** Public (serialisable) part of a tool definition. */
export interface ToolDefinitionPublic {
  name: string
  title?: string
  description: string
  inputSchema: JsonSchemaObject
  outputSchema?: JsonSchemaObject
  annotations?: ToolAnnotations
}

/** A tool contributed by a plugin through `ctx.tools`. */
export interface ToolDefinition extends ToolDefinitionPublic {
  execute(
    input: Record<string, unknown>,
    call: ToolCallContext,
  ): Promise<ToolResult>
}

export type PluginStatusState = "ready" | "needs-setup" | "working" | "error"

/** Button descriptor shown in Settings; dispatched to a registered action. */
export interface PluginStatusAction {
  id: string
  label: string
  kind?: "primary" | "secondary" | "destructive"
  /** When set, the UI asks for confirmation with this text first. */
  confirm?: string
}

/** What Settings shows for a plugin (last `ctx.surface.setStatus`). */
export interface PluginStatus {
  state: PluginStatusState
  /** Machine code, e.g. `signin-needed`; the UI may localise by code. */
  code: string
  /** English one-liner (fallback text). */
  summary: string
  detail?: string
  facts?: Array<{ label: string; value: string }>
  actions?: Array<PluginStatusAction>
}

/** Handler for a surface action; errors should be reported via status. */
export type PluginActionHandler = (signal: AbortSignal) => Promise<void>

/** Removes a registration. Idempotent and synchronous. */
export type PluginDisposer = () => void

/** `ctx.tools` — tools are namespaced by the calling plugin's id. */
export interface ToolRegistry {
  /**
   * Register one tool for the calling plugin. The registration is bound to
   * the caller's fiber and vanishes when it is disposed. Throws
   * `PluginContractError` (`duplicate-tool` / `invalid-tool`).
   */
  register(definition: ToolDefinition): PluginDisposer
  /**
   * Atomically replace the calling plugin's whole tool set (including tools
   * added with `register`). Validates everything first: a duplicate or
   * invalid definition throws and leaves the previous set untouched.
   */
  registerAll(definitions: ReadonlyArray<ToolDefinition>): PluginDisposer
  /** The calling plugin's currently registered tools. */
  list(): Array<ToolDefinition>
}

/** `ctx.surface` — status and actions shown in Settings. */
export interface PluginSurface {
  setStatus(status: PluginStatus): void
  /** Bound to the caller's fiber. Throws on a duplicate or invalid id. */
  registerAction(id: string, handler: PluginActionHandler): PluginDisposer
}

/** `ctx.storage` — private per-plugin directory (0700, files 0600). */
export interface PluginStorage {
  /** Absolute directory path (may not exist until the first write). */
  readonly dir: string
  /** `undefined` when the file does not exist. */
  readText(name: string): Promise<string | undefined>
  /** Atomic write (temp file + rename), mode 0600. */
  writeText(name: string, text: string): Promise<void>
  /** No-op when the file does not exist. */
  delete(name: string): Promise<void>
}

export interface PluginLogger {
  debug(message: string, ...args: Array<unknown>): void
  info(message: string, ...args: Array<unknown>): void
  warn(message: string, ...args: Array<unknown>): void
  error(message: string, ...args: Array<unknown>): void
}

/** `ctx.host` — capabilities the app provides (composition root). */
export interface HostServices {
  /** Open an http(s) URL in the system browser. */
  openExternal(url: string): Promise<void>
  readonly logger: PluginLogger
  readonly appVersion: string
}
