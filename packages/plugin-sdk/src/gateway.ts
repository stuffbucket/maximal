/**
 * The gateway seam: what the app core (`src/`) sees of the plugin system.
 *
 * Cordis-free by construction — this module has no runtime imports at all
 * (only `import type`), so importing it can never pull cordis or plugin code
 * into the core. The only runtime values are `PluginGatewayError` and its
 * guard, and the tool-permission wording the host and the MCP layer share.
 */
import type { OperationDispatch } from "./operations"
import type { ServerToolCall, ServerToolView } from "./server-tools"
import type {
  JsonSchemaObject,
  PluginKind,
  PluginManifest,
  PluginNotice,
  PluginStatus,
  PluginToolView,
  ToolAnnotations,
  ToolCallContext,
  ToolDefinitionPublic,
  ToolPermission,
  ToolResult,
} from "./types"

/** Clients Maximal can register a plugin's MCP endpoint with. */
export type PluginClientId = "claude-code"

/**
 * One `config.json` → `plugins.<id>` entry. Absent ⇒ disabled. The plugin's
 * own config lives in its settings file (`updateConfig`), not here.
 */
export interface PluginSettingsEntry {
  enabled?: boolean
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

/**
 * Where `toolViews` comes from: the running plugin (`live`), the last
 * non-empty tool set the plugin registered (`cache`), or nothing (`none`).
 */
export type PluginToolsSource = "live" | "cache" | "none"

export interface PluginSnapshot {
  id: string
  kind: PluginKind
  displayName: string
  description: string
  homepage?: string
  /** The plugin's static manifest (display + connector info; never secrets). */
  manifest: PluginManifest
  /** The plugin's current settings version (`manifest.settingsVersion`). */
  settingsVersion: number
  configSchema?: JsonSchemaObject
  /**
   * The config from the settings file: validated (defaults applied) when
   * valid, else as stored; `undefined` until the file was read or when it
   * is unreadable.
   */
  config: unknown
  /** Desired state from the last reconcile. */
  enabled: boolean
  lifecycle: PluginLifecycle
  /** Why the plugin failed (path-qualified config issues, apply error). */
  error?: string
  /** Last `ctx.surface.setStatus` of the running plugin. */
  status?: PluginStatus
  /** Live tools; empty unless the plugin is active. */
  tools: Array<PluginToolSummary>
  toolsSource: PluginToolsSource
  /** When the cached tool catalog was last refreshed (ISO 8601). */
  catalogUpdatedAt?: string
}

/**
 * `tools`: the MCP-visible tool list may have changed (registration or
 * permission change). `settings`: the plugin's settings file changed
 * (config, permissions). `notice`: the plugin sent a one-off message for the
 * user (`notice` carries it; nothing in the snapshot changes).
 */
export type PluginGatewayEventType =
  | "lifecycle"
  | "status"
  | "tools"
  | "settings"
  | "notice"

export interface PluginGatewayEvent {
  type: PluginGatewayEventType
  pluginId: string
  /** On `notice` events only. */
  notice?: Readonly<PluginNotice>
}

/** A tool as MCP clients see it, with its effective permission. */
export type PluginToolListing = ToolDefinitionPublic & {
  permission: ToolPermission
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
  /**
   * The MCP-facing tool list: every live tool with its effective
   * permission (blocked ones too: the MCP layer marks them as turned off).
   * Throws `unknown-plugin`; returns `[]` while the plugin is not active.
   */
  listTools(pluginId: string): Array<PluginToolListing>
  /**
   * Every tool with its group and effective permission, for Settings: live
   * tools when the plugin is active and has registered some, else the
   * cached catalog (see `PluginSnapshot.toolsSource`). Throws `unknown-plugin`.
   */
  toolViews(pluginId: string): Array<PluginToolView>
  /**
   * Throws `unknown-plugin` / `plugin-inactive` / `unknown-tool`. A tool that
   * throws resolves to `{ isError: true, content: [{ type: "text", text }] }`;
   * so does a call to a blocked tool, or to an `ask` tool without
   * `call.approved` (each saying where to change it in Settings).
   */
  callTool(
    pluginId: string,
    name: string,
    input: Record<string, unknown>,
    call: ToolCallContext,
  ): Promise<ToolResult>
  /**
   * The operation registry's cordis-free view: what enabled plugins serve for
   * `systemone`, `decisions` and `images.*`. Always the same live object.
   */
  operations(): OperationDispatch
  /**
   * Every server tool the active plugins have registered, ordered by name.
   * `[]` when no plugin provides any. The app core offers these to the model
   * in the `/v1/messages` loop. (Server tools take no part in MCP tool
   * permissions: a plugin that wants one switchable puts that in its config
   * and registers or withdraws the tool.)
   */
  serverTools(): Array<ServerToolView>
  /**
   * Run one server tool. Throws `unknown-plugin` / `plugin-inactive` /
   * `unknown-tool`. A tool that throws resolves to
   * `{ isError: true, content: [{ type: "text", text }] }`, like `callTool`.
   * The host sets `call.budget` to the tool's own `{ plugin, tool }`.
   */
  callServerTool(
    pluginId: string,
    name: string,
    input: Record<string, unknown>,
    call: ServerToolCall,
  ): Promise<ToolResult>
  /** Throws `unknown-plugin` / `plugin-inactive` / `unknown-action`; rejects if the handler throws. */
  runAction(
    pluginId: string,
    actionId: string,
    signal?: AbortSignal,
  ): Promise<void>
  /**
   * Validate `config` against the plugin's `Config`, write it to the
   * settings file, and reload the plugin if it is enabled and the config
   * changed. Throws `unknown-plugin`, `invalid-config` (with `issues`), or
   * `settings-unreadable`. An `apply` failure after reload is reported via
   * the snapshot, not thrown.
   */
  updateConfig(pluginId: string, config: unknown): Promise<void>
  /**
   * Set (or with `null`, clear back to the default) per-tool permissions in
   * the settings file. Names need not be currently registered (choices are
   * kept for tools that come back). Never reloads the plugin; emits `tools`
   * and `settings` when anything changed. Throws `unknown-plugin`,
   * `invalid-permissions`, or `settings-unreadable`.
   */
  setToolPermissions(
    pluginId: string,
    changes: Record<string, ToolPermission | null>,
  ): Promise<void>
  /**
   * One-shot migration of a legacy `config.json` → `plugins.<id>.config`
   * value (settings version 1). Writes it only when the settings file has no
   * config yet (migrating it with the plugin's `migrateSettings` first);
   * resolves `true` when written, `false` when the file already had a config.
   * Not validated, so an invalid legacy config surfaces as a `failed` plugin
   * rather than being lost. Throws `unknown-plugin` or `settings-unreadable`.
   */
  importLegacyConfig(pluginId: string, config: unknown): Promise<boolean>
  subscribe(listener: (event: PluginGatewayEvent) => void): () => void
  /** Stops every plugin. Idempotent. */
  dispose(): Promise<void>
}

const GATEWAY_ERROR_CODES = [
  "unknown-plugin",
  "plugin-inactive",
  "unknown-tool",
  "unknown-action",
  "invalid-config",
  "invalid-permissions",
  "settings-unreadable",
] as const

export type PluginGatewayErrorCode = (typeof GATEWAY_ERROR_CODES)[number]

/** One config validation issue; `path` is dotted and relative to the config root (`""` = root). */
export interface PluginConfigIssue {
  path: string
  message: string
}

export class PluginGatewayError extends Error {
  readonly code: PluginGatewayErrorCode
  readonly pluginId: string
  /** Set for `invalid-config`. */
  readonly issues: ReadonlyArray<PluginConfigIssue> | undefined

  // eslint-disable-next-line max-params -- keeps the v1 positional (code, pluginId, message) signature; extras go in options
  constructor(
    code: PluginGatewayErrorCode,
    pluginId: string,
    message: string,
    options?: { issues?: ReadonlyArray<PluginConfigIssue>; cause?: unknown },
  ) {
    super(
      message,
      options?.cause === undefined ? undefined : { cause: options.cause },
    )
    this.name = "PluginGatewayError"
    this.code = code
    this.pluginId = pluginId
    this.issues = options?.issues
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
  return (GATEWAY_ERROR_CODES as ReadonlyArray<unknown>).includes(code)
}

/**
 * Thrown by `OperationDispatch.dispatch` when no enabled plugin serves the
 * model for the operation (the plugin is off, or the id is unknown or
 * ambiguous).
 */
export class OperationUnavailableError extends Error {
  readonly operation: string
  readonly model: string

  constructor(operation: string, model: string) {
    super(`No enabled plugin serves "${model}" for ${operation}.`)
    this.name = "OperationUnavailableError"
    this.operation = operation
    this.model = model
  }
}

/** Structural guard (works across duplicated module copies). */
export function isOperationUnavailableError(
  error: unknown,
): error is OperationUnavailableError {
  return (
    error instanceof OperationUnavailableError
    || (error instanceof Error && error.name === "OperationUnavailableError")
  )
}
export type {
  ModelBinding,
  ModelOperation,
  OperationDispatch,
  OperationRequest,
  OperationResult,
  ServedModel,
} from "./operations"
export type {
  ProviderCall,
  ProviderModelInfo,
  ProviderQuotaWindow,
  ProviderRegistry,
  UpstreamProvider,
} from "./providers"
export type {
  ServerToolBudget,
  ServerToolCall,
  ServerToolOffer,
  ServerToolRender,
  ServerToolView,
} from "./server-tools"
export type {
  ConnectorAuth,
  ConnectorLaneLimits,
  ConnectorLimits,
  ConnectorManifest,
  ConnectorRetryLimits,
  ConnectorTerms,
  ElicitRequest,
  ElicitResult,
  JsonSchemaObject,
  PluginKind,
  PluginManifest,
  PluginStatus,
  PluginStatusAction,
  PluginStatusState,
  PluginToolView,
  ToolAnnotations,
  ToolCallContext,
  ToolContent,
  ToolDefinitionPublic,
  ToolGroup,
  ToolPermission,
  ToolPermissionSource,
  ToolProgress,
  ToolResult,
} from "./types"

/** Where a person changes a connector's tool permissions. */
export function toolPermissionsPlace(connector: string): string {
  return `Maximal → Settings → Integrations → Connectors → ${connector} → Tool permissions`
}

/** Said for a tool set to `block`: turned off, and where to turn it on. */
export function blockedToolText(connector: string, tool: string): string {
  return `${connector}'s ${tool} tool is turned off in Maximal. To use it, turn it on in ${toolPermissionsPlace(connector)}.`
}

/** Said for an `ask` call nobody could approve (the client can't ask). */
export function unapprovedToolText(connector: string, tool: string): string {
  return `${connector}'s ${tool} tool needs your approval for each call, and this app can't ask for it. Allow it in ${toolPermissionsPlace(connector)}, or use an app that supports MCP elicitation.`
}
