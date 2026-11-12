import type { JsonValue } from "@stuffbucket/maximal-plugin-protocol"
import type {
  ModelBinding,
  ModelOperation,
  OperationResult,
  PluginGatewayEvent,
  PluginSettings,
  PluginSnapshot,
  PluginToolListing,
  PluginToolView,
  ServedModel,
  ServerToolEstimate,
  ServerToolSpend,
  ServerToolView,
  ToolPermission,
  ToolResult,
} from "@stuffbucket/maximal-plugin-sdk/gateway"

import { ProtocolError } from "@stuffbucket/maximal-plugin-protocol"

export const GATEWAY_RPC = Object.freeze({
  snapshot: "gateway.snapshot",
  reconcile: "gateway.reconcile",
  callTool: "gateway.call-tool",
  executeOperation: "gateway.execute-operation",
  prepareServerTool: "gateway.prepare-server-tool",
  executeServerTool: "gateway.execute-server-tool",
  releaseServerTool: "gateway.release-server-tool",
  runAction: "gateway.run-action",
  updateConfig: "gateway.update-config",
  setToolPermissions: "gateway.set-tool-permissions",
  importLegacyConfig: "gateway.import-legacy-config",
  releaseUpstreamSession: "mcp.release-upstream-session",
  resourceList: "resources.list",
  resourcePrepare: "resources.prepare",
  resourceCommit: "resources.commit",
  resourceRevoke: "resources.revoke",
  resourceResume: "resources.resume",
} as const)

export const SETTINGS_RPC = Object.freeze({
  snapshot: "settings.snapshot",
  commit: "settings.commit",
  epoch: "settings.epoch",
  transactionSnapshot: "settings.transaction-snapshot",
  transactionCommit: "settings.transaction-commit",
  transactionEpoch: "settings.transaction-epoch",
  transactionFinish: "settings.transaction-finish",
  transactionRollback: "settings.transaction-rollback",
} as const)

export const PROVIDER_RPC = Object.freeze({
  snapshot: "provider.snapshot",
  catalogUpdate: "provider.catalog-update",
  postJson: "provider.post-json",
  quotaWindows: "provider.quota-windows",
  refreshQuotaWindows: "provider.refresh-quota-windows",
} as const)

export const HOST_RPC = Object.freeze({
  snapshot: "host.snapshot",
  openExternal: "host.open-external",
  log: "host.log",
} as const)

export interface GatewayProjectionDto {
  readonly operationRevision: number
  readonly plugins: ReadonlyArray<PluginSnapshot>
  readonly listings: Readonly<
    Partial<Record<string, ReadonlyArray<PluginToolListing>>>
  >
  readonly toolViews: Readonly<
    Partial<Record<string, ReadonlyArray<PluginToolView>>>
  >
  readonly serverTools: ReadonlyArray<ServerToolView>
  readonly servedModels: ReadonlyArray<ServedModel>
  readonly operationTargets: ReadonlyArray<{
    operation: ModelOperation
    model: string
    pluginId: string
    binding: ModelBinding
  }>
}

export type BodyDto =
  | {
      readonly kind: "json"
      readonly value: Readonly<Record<string, JsonValue>>
    }
  | {
      readonly kind: "multipart"
      readonly parts: ReadonlyArray<
        | {
            readonly name: string
            readonly kind: "text"
            readonly value: string
          }
        | {
            readonly name: string
            readonly kind: "blob"
            readonly bytesBase64: string
            readonly mediaType: string
            readonly filename?: string
          }
      >
    }

export interface OperationExecutionDto {
  readonly operationRevision: number
  readonly operation: ModelOperation
  readonly model: string
  readonly pluginId: string
  readonly binding: ModelBinding
  readonly body: BodyDto
  readonly invocationId: string
  readonly providerCallId: string
  readonly sequence: number
  readonly origin:
    | { readonly kind: "http"; readonly client: string }
    | {
        readonly kind: "server-tool"
        readonly tool: string
        readonly sessionId?: string
      }
}

export interface ServerToolCallDto {
  readonly invocationId: string
  readonly sessionId?: string
  readonly model: string
  readonly client: string
  readonly budget?: { readonly plugin: string; readonly tool: string }
  /** Parent-issued opaque identities, consumed in order by nextProviderCall. */
  readonly providerCallIds: ReadonlyArray<string>
}

export interface PreparedServerToolDto {
  readonly preparedId: string
  readonly pluginId: string
  readonly name: string
  readonly estimate?: {
    readonly operation: ModelOperation
    readonly provider?: string
    readonly body: BodyDto
  }
}

export interface ProviderReplyDto {
  readonly reply: JsonValue
  readonly cost?: NonNullable<OperationResult["cost"]>
}

function malformed(message: string): never {
  throw new ProtocolError("malformed", message)
}

export function record(
  value: JsonValue,
  context: string,
): Partial<Record<string, JsonValue>> {
  if (value === null || Array.isArray(value) || typeof value !== "object")
    malformed(`${context} must be an object.`)
  return value
}

// eslint-disable-next-line max-params -- required and optional key sets are distinct protocol constraints
export function exact(
  value: JsonValue,
  context: string,
  required: ReadonlyArray<string>,
  optional: ReadonlyArray<string> = [],
): Partial<Record<string, JsonValue>> {
  const parsed = record(value, context)
  const allowed = new Set([...required, ...optional])
  for (const key of Object.keys(parsed))
    if (!allowed.has(key)) malformed(`${context} has unknown field ${key}.`)
  for (const key of required)
    if (!Object.hasOwn(parsed, key)) malformed(`${context} omitted ${key}.`)
  return parsed
}

export function stringValue(
  value: JsonValue | undefined,
  context: string,
): string {
  if (typeof value !== "string" || value.length === 0)
    malformed(`${context} must be a non-empty string.`)
  return value
}

export function booleanValue(
  value: JsonValue | undefined,
  context: string,
): boolean {
  if (typeof value !== "boolean") malformed(`${context} must be boolean.`)
  return value
}

export function integerValue(
  value: JsonValue | undefined,
  context: string,
): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0)
    malformed(`${context} must be a non-negative safe integer.`)
  return value
}

export function optionalString(
  value: JsonValue | undefined,
  context: string,
): string | undefined {
  if (value === undefined) return undefined
  return stringValue(value, context)
}

function isJsonValue(value: unknown): value is JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean")
    return true
  if (typeof value === "number") return Number.isFinite(value)
  if (Array.isArray(value)) return value.every((item) => isJsonValue(item))
  if (!value || typeof value !== "object") return false
  return Object.values(value).every((item) => isJsonValue(item))
}

export function json(value: unknown, context: string): JsonValue {
  // The protocol intentionally strips undefined optional fields at this boundary.
  // eslint-disable-next-line unicorn/prefer-structured-clone
  const normalized: unknown = JSON.parse(JSON.stringify(value))
  if (!isJsonValue(normalized))
    throw new ProtocolError("malformed", `${context} is not JSON.`)
  return normalized
}

export function parseProjection(value: JsonValue): GatewayProjectionDto {
  const input = exact(value, "Gateway projection", [
    "operationRevision",
    "plugins",
    "listings",
    "toolViews",
    "serverTools",
    "servedModels",
    "operationTargets",
  ])
  if (integerValue(input.operationRevision, "Operation revision") < 0)
    malformed("Operation revision must be non-negative.")
  if (!Array.isArray(input.plugins))
    malformed("Gateway plugins must be an array.")
  if (!Array.isArray(input.serverTools))
    malformed("Gateway server tools must be an array.")
  if (!Array.isArray(input.servedModels))
    malformed("Gateway served models must be an array.")
  if (!Array.isArray(input.operationTargets))
    malformed("Gateway operation targets must be an array.")
  const listings = record(input.listings ?? null, "Gateway listings")
  const toolViews = record(input.toolViews ?? null, "Gateway tool views")
  for (const value of Object.values(listings))
    if (!Array.isArray(value))
      malformed("Gateway listing entry must be an array.")
  for (const value of Object.values(toolViews))
    if (!Array.isArray(value))
      malformed("Gateway tool-view entry must be an array.")
  return structuredClone(input) as unknown as GatewayProjectionDto
}

export function parseGatewayEvent(value: JsonValue): PluginGatewayEvent {
  const input = exact(value, "Gateway event", ["type", "pluginId"], ["notice"])
  stringValue(input.type, "Gateway event type")
  stringValue(input.pluginId, "Gateway event plugin id")
  return structuredClone(input) as unknown as PluginGatewayEvent
}

export function parseToolResult(value: JsonValue): ToolResult {
  const input = record(value, "Tool result")
  if (!Array.isArray(input.content))
    malformed("Tool result content must be an array.")
  return structuredClone(input) as unknown as ToolResult
}

export function parseOperationResult(value: JsonValue): OperationResult {
  const input = exact(
    value,
    "Operation result",
    ["json", "usage", "invocationId", "providerCallId", "sequence"],
    ["cost"],
  )
  record(input.json ?? null, "Operation result JSON")
  record(input.usage ?? null, "Operation result usage")
  stringValue(input.invocationId, "Operation invocation id")
  stringValue(input.providerCallId, "Operation provider call id")
  integerValue(input.sequence, "Operation sequence")
  return structuredClone(input) as unknown as OperationResult
}

export function parsePreparedServerTool(
  value: JsonValue,
): PreparedServerToolDto {
  const input = exact(
    value,
    "Prepared server tool",
    ["preparedId", "pluginId", "name"],
    ["estimate"],
  )
  stringValue(input.preparedId, "Prepared server tool id")
  stringValue(input.pluginId, "Prepared server tool plugin id")
  stringValue(input.name, "Prepared server tool name")
  if (input.estimate !== undefined)
    record(input.estimate, "Server tool estimate")
  return structuredClone(input) as unknown as PreparedServerToolDto
}

export function parseProviderReply(value: JsonValue): ProviderReplyDto {
  const input = exact(value, "Provider reply", ["reply"], ["cost"])
  return structuredClone(input) as unknown as ProviderReplyDto
}

export function parseBooleanResult(value: JsonValue, context: string): boolean {
  return booleanValue(value, context)
}

export function parseNull(value: JsonValue, context: string): void {
  if (value !== null) malformed(`${context} must return null.`)
}

export function parsePermissionChanges(
  value: JsonValue,
): Record<string, ToolPermission | null> {
  const input = record(value, "Tool permission changes")
  for (const [name, permission] of Object.entries(input)) {
    if (
      name.length === 0
      || (permission !== null
        && permission !== "allow"
        && permission !== "ask"
        && permission !== "block")
    )
      malformed("Tool permission changes are invalid.")
  }
  return structuredClone(input) as Record<string, ToolPermission | null>
}

export function parsePluginSettings(
  value: JsonValue,
): PluginSettings | undefined {
  if (value === null) return undefined
  const input = record(value, "Plugin settings")
  for (const [id, entryValue] of Object.entries(input)) {
    if (id.length === 0 || entryValue === undefined)
      malformed("Plugin settings id is invalid.")
    const entry = exact(
      entryValue,
      "Plugin settings entry",
      [],
      ["enabled", "clients"],
    )
    if (entry.enabled !== undefined)
      booleanValue(entry.enabled, "Plugin enabled")
    if (entry.clients !== undefined && !Array.isArray(entry.clients))
      malformed("Plugin clients must be an array.")
  }
  return structuredClone(input) as PluginSettings
}

export async function encodeBody(
  body: Record<string, unknown> | FormData,
): Promise<BodyDto> {
  if (!(body instanceof FormData)) {
    const value = json(body, "Operation body")
    return {
      kind: "json",
      value: record(value, "Operation body") as Readonly<
        Record<string, JsonValue>
      >,
    }
  }
  const encoded: Array<
    | { name: string; kind: "text"; value: string }
    | {
        name: string
        kind: "blob"
        bytesBase64: string
        mediaType: string
        filename?: string
      }
  > = []
  for (const [name, rawValue] of body.entries()) {
    const value: unknown = rawValue
    if (typeof value === "string") encoded.push({ name, kind: "text", value })
    else if (value instanceof Blob) {
      const bytes = new Uint8Array(await value.arrayBuffer())
      const filename =
        "name" in value && typeof value.name === "string" ?
          value.name
        : undefined
      encoded.push({
        name,
        kind: "blob",
        bytesBase64: Buffer.from(bytes).toString("base64"),
        mediaType: value.type,
        ...(filename === undefined || filename.length === 0 ?
          {}
        : { filename }),
      })
    } else throw new Error("Multipart body contains an unsupported value.")
  }
  json({ kind: "multipart", parts: encoded }, "Multipart body")
  return { kind: "multipart", parts: encoded }
}

export function decodeBody(body: BodyDto): Record<string, unknown> | FormData {
  if (body.kind === "json") return structuredClone(body.value)
  const form = new FormData()
  for (const part of body.parts) {
    if (part.kind === "text") form.append(part.name, part.value)
    else {
      const bytes = Uint8Array.from(Buffer.from(part.bytesBase64, "base64"))
      const blob = new Blob([bytes], { type: part.mediaType })
      if (part.filename === undefined) form.append(part.name, blob)
      else form.append(part.name, blob, part.filename)
    }
  }
  return form
}

export function encodeEstimate(
  estimate: ServerToolEstimate | undefined,
): Promise<PreparedServerToolDto["estimate"]> {
  if (!estimate) return Promise.resolve(undefined)
  return encodeBody(estimate.body).then((body) => ({
    operation: estimate.operation,
    ...(estimate.provider === undefined ? {} : { provider: estimate.provider }),
    body,
  }))
}

export function spendEvidence(spend: ServerToolSpend): JsonValue {
  return json(spend, "Server tool spend")
}
