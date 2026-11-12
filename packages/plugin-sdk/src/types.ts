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

/** Names of the built-in services the plugin host always provides on `ctx`. */
export const PLUGIN_SERVICE_NAMES = [
  "tools",
  "surface",
  "storage",
  "host",
] as const
export type PluginServiceName = (typeof PLUGIN_SERVICE_NAMES)[number]

/**
 * Services the host application provides on `ctx` besides the built-in ones
 * (`PluginHostOptions.services.extra`). Empty here: the module that defines a
 * service merges it in with
 * `declare module "@stuffbucket/maximal-plugin-sdk" { interface AppServices { name: Type } }`,
 * and a plugin that lists the name in `inject` then sees it typed on `ctx`.
 */
// eslint-disable-next-line @typescript-eslint/no-empty-object-type -- declaration-merging hook
export interface AppServices {}

/** Reserved storage name of the host-owned per-plugin settings file. */
export const PLUGIN_SETTINGS_FILE = "settings.json"

/**
 * Kinds of plugin. A `connector` exposes tools to MCP clients and gets
 * host-managed tool permissions. An `extension` has no MCP endpoint and is not
 * listed in Settings. A `model` has no MCP endpoint either, but is listed in
 * Settings with its enable toggle and config form.
 */
export const PLUGIN_KINDS = ["connector", "extension", "model"] as const
export type PluginKind = (typeof PLUGIN_KINDS)[number]

/** How a connector authenticates to its upstream. Public identifiers only — never secrets. */
export type ConnectorAuth =
  | {
      type: "entra"
      clientId: string
      authority: string
      scopes: ReadonlyArray<string>
      redirectUri: string
    }
  | { type: "mcp-oauth"; clientId?: string; scopes?: ReadonlyArray<string> }
  | { type: "none" }

/** Terms the user must accept before the connector is used (host-managed gate). */
export interface ConnectorTerms {
  url: string
  label?: string
}

/** Concurrency and spacing for one lane of a connector's upstream calls. */
export interface ConnectorLaneLimits {
  /** In-flight calls in this lane. */
  maxConcurrency?: number
  /** Least time between the starts of two calls in this lane (ms). */
  minIntervalMs?: number
}

/** Retry numbers for throttled upstream calls. */
export interface ConnectorRetryLimits {
  /** Attempts in total, the first included. */
  attempts?: number
  /** Fallback waits between attempts when the server gives no `Retry-After` (ms). */
  fallbackDelaysMs?: ReadonlyArray<number>
  /** Equal jitter on fallback waits, as a fraction (0.25 ⇒ ±25%). */
  jitter?: number
  /** Longest single wait; a longer `Retry-After` fails fast instead (ms). */
  maxWaitMs?: number
  /** Queueing plus backoff per call (ms). */
  budgetMs?: number
  /** Retry a write the server refused with 429 (it was not carried out). */
  retryWritesOn429?: boolean
}

/**
 * Rate-limiting numbers for a connector's upstream (all optional; the
 * connector kit supplies defaults). Behaviour (which tool is a read, which
 * lane a call uses) is code, not manifest.
 */
export interface ConnectorLimits {
  /** In-flight upstream calls across all clients. */
  maxConcurrency?: number
  /** Floor when throttling halves the concurrency. */
  minConcurrency?: number
  lanes?: Record<string, ConnectorLaneLimits>
  /** Calls waiting for a slot across all clients; more fail at once. */
  maxQueue?: number
  /** Longest wait for a slot (ms). */
  queueTimeoutMs?: number
  retry?: ConnectorRetryLimits
  /** Most paths per upstream batch read (0: never split). */
  fetchBatchSize?: number
  /** Least time between two progress notifications while waiting (ms). */
  progressIntervalMs?: number
}

/** The upstream a connector talks to. Required iff `kind === "connector"`. */
export interface ConnectorManifest {
  transport: "streamable-http"
  /** Default upstream endpoint; the plugin's config may override it. */
  endpoint: string
  /**
   * Hosts (`host` or `host:port`, lower case) a config override of the
   * endpoint may name, besides the default endpoint's host. Overrides must
   * be `https:`.
   */
  allowedHosts?: ReadonlyArray<string>
  auth: ConnectorAuth
  terms?: ConnectorTerms
  /** Rate-limiting numbers (optional). */
  limits?: ConnectorLimits
}

/**
 * Static, JSON-serialisable description of a plugin (the `manifest` export).
 * `id` must equal the module's `name` export.
 */
export interface PluginManifest {
  id: string
  kind: PluginKind
  displayName: string
  description: string
  homepage?: string
  /** Version of the plugin's settings shape (positive integer); see `migrateSettings`. */
  settingsVersion: number
  /** JSON Schema of `Config`, for the Settings form (e.g. `z.toJSONSchema(Config)`). */
  configSchema?: JsonSchemaObject
  connector?: ConnectorManifest
}

/**
 * Per-tool permission. Stored as a string so further states can be added
 * without a settings migration.
 *
 * - `allow`: clients call it as they would any tool (their own approval
 *   rules still apply).
 * - `ask`: a person approves every call: the client's own prompt where it
 *   can be required (Claude Code), else Maximal asks through the client
 *   (MCP elicitation), else the call is refused.
 * - `block`: still listed, marked as turned off; every call is refused with
 *   where to turn it on.
 */
export const TOOL_PERMISSIONS = ["allow", "ask", "block"] as const
export type ToolPermission = (typeof TOOL_PERMISSIONS)[number]

/** Where a tool's effective permission came from. */
export type ToolPermissionSource = "user" | "plugin" | "default"

export type ToolGroup = "read-only" | "write-delete" | "other"

/** Tool with its permission group and effective permission (Settings view). */
export interface PluginToolView extends ToolDefinitionPublic {
  group: ToolGroup
  permission: ToolPermission
  permissionSource: ToolPermissionSource
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
  /**
   * Set by the app when a tool set to `ask` was approved for this call (by
   * the client's own prompt or Maximal's question). The host refuses an
   * `ask` call without it.
   */
  approved?: boolean
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
  /**
   * Set while the plugin needs the person now (a pairing request waiting for
   * approval, say). The app may then call attention to it outside Settings:
   * the menu-bar tray lists each action so it can be taken from there. Omit
   * it, or leave it out of the next status, when nothing is waiting. Each
   * action id must be one the plugin has registered with `registerAction`,
   * and should stay the same for the same thing (not a counter), so a menu
   * item that has gone stale still reaches the right target.
   */
  attention?: PluginAttention
}

/** What a plugin needs the person to look at now; see `PluginStatus.attention`. */
export interface PluginAttention {
  /** English one-liner, for what is waiting. */
  summary: string
  /** What the person can do about it; the labels are shown as they are. */
  actions: Array<PluginStatusAction>
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

/**
 * A one-off message for the person using Maximal, shown as a native
 * notification by the desktop app. For changes worth interrupting for (a
 * sign-in that now works, a sign-in that won't survive a restart), not for
 * status: Settings shows that.
 */
export interface PluginNotice {
  /** Machine code (`a-z`, `0-9`, `-`); the app may word known codes in the user's language. */
  code: string
  /** English text, used when the app has no wording for `code`. */
  message: string
  /** Values for the app's wording, such as `account`. */
  params?: Record<string, string>
}

/** `ctx.surface` — status and actions shown in Settings. */
export interface PluginSurface {
  setStatus(status: PluginStatus): void
  /** Best effort: the host may drop notices, and outside the desktop app nothing shows them. */
  notify(notice: PluginNotice): void
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
  /**
   * The port Maximal itself serves on, for plugins that hand it to something
   * else (a FigJam panel that calls Maximal for models). Read it when
   * needed: the port can differ between runs.
   */
  maximalPort(): number
}

/**
 * Permission group of a tool: `readOnlyHint` ⇒ `read-only`, else
 * `destructiveHint` ⇒ `write-delete`, else `other`.
 */
export function toolGroup(
  tool: Pick<ToolDefinitionPublic, "annotations">,
): ToolGroup {
  if (tool.annotations?.readOnlyHint === true) return "read-only"
  if (tool.annotations?.destructiveHint === true) return "write-delete"
  return "other"
}

export function isToolPermission(value: unknown): value is ToolPermission {
  return (TOOL_PERMISSIONS as ReadonlyArray<unknown>).includes(value)
}
