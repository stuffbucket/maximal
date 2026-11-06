import type { StandardSchemaV1 } from "@standard-schema/spec"

import type { PluginConfigIssue } from "../gateway"
import type { PluginInject, PluginModule } from "../index"

import { PluginContractError } from "../errors"
import {
  ACTION_ID_PATTERN,
  PLUGIN_ID_PATTERN,
  PLUGIN_SETTINGS_FILE,
  STORAGE_NAME_PATTERN,
  TOOL_NAME_PATTERN,
  type PluginNotice,
  type PluginStatus,
  type ToolAnnotations,
  type ToolDefinition,
} from "../types"
import { normalizeManifest } from "./manifest"

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

function isStandardSchema(value: unknown): value is StandardSchemaV1 {
  if (
    value === null
    || (typeof value !== "object" && typeof value !== "function")
  )
    return false
  if (!("~standard" in value)) return false
  const standard: unknown = value["~standard"]
  return isRecord(standard) && typeof standard.validate === "function"
}

/** `Array.isArray` that also narrows a `ReadonlyArray`. */
export function isInjectList(
  inject: PluginInject,
): inject is ReadonlyArray<string> {
  return Array.isArray(inject)
}

/** Service names a plugin's `inject` export declares (array or map form). */
export function injectedServices(
  module: Pick<PluginModule, "name" | "inject">,
): Array<string> {
  const entries: Array<unknown> =
    isInjectList(module.inject) ?
      [...module.inject]
    : Object.keys(module.inject)
  if (
    entries.some((entry) => typeof entry !== "string" || entry.length === 0)
  ) {
    throw new PluginContractError(
      "invalid-module",
      `Plugin "${module.name}" has an invalid inject declaration.`,
      {
        pluginId: module.name,
      },
    )
  }
  return entries as Array<string>
}

/**
 * Module-shape gate (monimal `genuinePlugin`): `name` matching
 * `PLUGIN_ID_PATTERN`, a valid `manifest` whose `id` equals `name`,
 * `inject`, Standard Schema `Config`, `apply`, and the optional
 * `migrateSettings` / `defaultToolPermission` functions.
 */
export function validatePluginModule(
  namespace: unknown,
  label = "plugin",
): PluginModule {
  if (namespace === null || typeof namespace !== "object") {
    throw new PluginContractError(
      "invalid-module",
      `${label} is not a module namespace.`,
    )
  }
  const ns = namespace as Record<string, unknown>
  const fail = (message: string): never => {
    throw new PluginContractError("invalid-module", message, {
      ...(typeof ns.name === "string" ? { pluginId: ns.name } : {}),
    })
  }
  if (typeof ns.name !== "string" || !PLUGIN_ID_PATTERN.test(ns.name)) {
    fail(`${label} must export a name matching ${String(PLUGIN_ID_PATTERN)}.`)
  }
  const id = ns.name as string
  normalizeManifest(id, ns.manifest)
  if (!Array.isArray(ns.inject) && !isRecord(ns.inject)) {
    fail(`Plugin "${id}" must export inject.`)
  }
  if (!isStandardSchema(ns.Config)) {
    fail(`Plugin "${id}" must export a Standard Schema Config.`)
  }
  if (typeof ns.apply !== "function") {
    fail(`Plugin "${id}" must export apply.`)
  }
  for (const optional of ["migrateSettings", "defaultToolPermission"]) {
    if (ns[optional] !== undefined && typeof ns[optional] !== "function")
      fail(`Plugin "${id}" export ${optional} must be a function.`)
  }
  const plugin = ns as unknown as PluginModule
  injectedServices(plugin)
  return plugin
}

/** Monimal `assertDependencies`: every injected service must be available. */
export function assertPluginDependencies(
  module: PluginModule,
  available: Iterable<string>,
): void {
  const services = new Set(available)
  const missing = injectedServices(module).filter((name) => !services.has(name))
  if (missing.length > 0) {
    throw new PluginContractError(
      "missing-service",
      `Plugin "${module.name}" requires missing service${missing.length === 1 ? "" : "s"}: ${missing.join(", ")}.`,
      { pluginId: module.name },
    )
  }
}

/** Validate a plugin list: shapes, ids, duplicate ids, injected services. */
export function validatePluginList(
  plugins: ReadonlyArray<unknown>,
  available: Iterable<string>,
): Array<PluginModule> {
  const services = [...available]
  const seen = new Set<string>()
  return plugins.map((candidate, index) => {
    const plugin = validatePluginModule(candidate, `plugins[${index}]`)
    if (seen.has(plugin.name)) {
      throw new PluginContractError(
        "invalid-module",
        `Duplicate plugin id "${plugin.name}".`,
        {
          pluginId: plugin.name,
        },
      )
    }
    seen.add(plugin.name)
    assertPluginDependencies(plugin, services)
    return plugin
  })
}

function issuePath(issue: StandardSchemaV1.Issue): string {
  if (!issue.path || issue.path.length === 0) return ""
  return issue.path
    .map((segment) =>
      String(typeof segment === "object" ? segment.key : segment),
    )
    .join(".")
}

/** Issues as `{ path, message }` with a dotted path relative to the config root. */
export function toConfigIssues(
  issues: ReadonlyArray<StandardSchemaV1.Issue>,
): Array<PluginConfigIssue> {
  return issues.map((issue) => ({
    path: issuePath(issue),
    message: issue.message,
  }))
}

/** Path-qualified issue text, e.g. `workiq.endpoint: Invalid URL` (monimal `PluginSettingsError`). */
export function formatConfigIssues(
  pluginId: string,
  issues: ReadonlyArray<StandardSchemaV1.Issue>,
): string {
  return issues
    .map((issue) => {
      const path = issuePath(issue)
      return `${pluginId}${path ? `.${path}` : ""}: ${issue.message}`
    })
    .join("\n")
}

export type ParsedPluginConfig =
  | { ok: true; value: unknown }
  | {
      ok: false
      message: string
      issues: ReadonlyArray<StandardSchemaV1.Issue>
    }

/**
 * Validate raw settings against the plugin's `Config`. `undefined` is
 * treated as `{}`. Supports sync and async Standard Schemas.
 */
export async function parsePluginConfig(
  module: PluginModule,
  raw: unknown,
): Promise<ParsedPluginConfig> {
  const schema = module.Config
  let result: StandardSchemaV1.Result<unknown>
  try {
    result = await schema["~standard"].validate(raw ?? {})
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    const issues = [{ message: `config validation threw: ${message}` }]
    return {
      ok: false,
      message: formatConfigIssues(module.name, issues),
      issues,
    }
  }
  if (result.issues) {
    return {
      ok: false,
      message: formatConfigIssues(module.name, result.issues),
      issues: result.issues,
    }
  }
  return { ok: true, value: result.value }
}

function isJsonSchemaObject(value: unknown): boolean {
  return isRecord(value) && value.type === "object"
}

const ANNOTATION_KEYS = [
  "readOnlyHint",
  "destructiveHint",
  "idempotentHint",
  "openWorldHint",
] as const

function normalizeAnnotations(
  pluginId: string,
  name: string,
  value: unknown,
): ToolAnnotations | undefined {
  if (value === undefined) return undefined
  if (!isRecord(value)) {
    throw new PluginContractError(
      "invalid-tool",
      `Tool "${pluginId}/${name}" annotations must be an object.`,
      { pluginId },
    )
  }
  const annotations: ToolAnnotations = {}
  if (typeof value.title === "string") annotations.title = value.title
  for (const key of ANNOTATION_KEYS) {
    const hint = value[key]
    if (hint === undefined) continue
    if (typeof hint !== "boolean") {
      throw new PluginContractError(
        "invalid-tool",
        `Tool "${pluginId}/${name}" annotation ${key} must be boolean.`,
        {
          pluginId,
        },
      )
    }
    annotations[key] = hint
  }
  return annotations
}

/** Validate and copy a tool definition (frozen; schemas cloned). */
export function normalizeToolDefinition(
  pluginId: string,
  definition: unknown,
): Readonly<ToolDefinition> {
  const invalid = (message: string): never => {
    throw new PluginContractError("invalid-tool", message, { pluginId })
  }
  if (!isRecord(definition))
    return invalid(
      `Plugin "${pluginId}" registered a tool that is not an object.`,
    )
  const name = definition.name
  if (typeof name !== "string" || !TOOL_NAME_PATTERN.test(name)) {
    return invalid(
      `Plugin "${pluginId}" registered a tool with invalid name ${JSON.stringify(name)}.`,
    )
  }
  if (typeof definition.description !== "string")
    invalid(`Tool "${pluginId}/${name}" needs a description.`)
  if (definition.title !== undefined && typeof definition.title !== "string")
    invalid(`Tool "${pluginId}/${name}" title must be a string.`)
  if (!isJsonSchemaObject(definition.inputSchema))
    invalid(
      `Tool "${pluginId}/${name}" inputSchema must be a JSON Schema with type "object".`,
    )
  if (
    definition.outputSchema !== undefined
    && !isJsonSchemaObject(definition.outputSchema)
  ) {
    invalid(
      `Tool "${pluginId}/${name}" outputSchema must be a JSON Schema with type "object".`,
    )
  }
  if (typeof definition.execute !== "function")
    invalid(`Tool "${pluginId}/${name}" needs an execute function.`)
  const source = definition as unknown as ToolDefinition
  const annotations = normalizeAnnotations(
    pluginId,
    name,
    definition.annotations,
  )
  let inputSchema: ToolDefinition["inputSchema"]
  let outputSchema: ToolDefinition["outputSchema"]
  try {
    inputSchema = structuredClone(source.inputSchema)
    outputSchema =
      source.outputSchema === undefined ?
        undefined
      : structuredClone(source.outputSchema)
  } catch (cause) {
    throw new PluginContractError(
      "invalid-tool",
      `Tool "${pluginId}/${name}" schemas must be plain JSON.`,
      { pluginId, cause },
    )
  }
  // Captured now so later mutation of `source` cannot swap the handler; always
  // invoked with `.call(source, …)` below.
  // eslint-disable-next-line @typescript-eslint/unbound-method
  const execute = source.execute
  return Object.freeze({
    name,
    ...(source.title === undefined ? {} : { title: source.title }),
    description: source.description,
    inputSchema,
    ...(outputSchema === undefined ? {} : { outputSchema }),
    ...(annotations === undefined ? {} : { annotations }),
    execute: (
      input: Record<string, unknown>,
      call: Parameters<ToolDefinition["execute"]>[1],
    ) => execute.call(source, input, call),
  })
}

const STATUS_STATES = new Set(["ready", "needs-setup", "working", "error"])
const ACTION_KINDS = new Set(["primary", "secondary", "destructive"])

const NOTICE_CODE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u
const NOTICE_TEXT_MAX = 500
const NOTICE_PARAMS_MAX = 8

function invalidNotice(pluginId: string, message: string): never {
  throw new PluginContractError(
    "invalid-notice",
    `Plugin "${pluginId}" notice: ${message}`,
    { pluginId },
  )
}

/** Validate a `surface.notify` notice and return a frozen copy of its known fields. */
export function normalizeNotice(
  pluginId: string,
  notice: unknown,
): Readonly<PluginNotice> {
  if (!isRecord(notice)) return invalidNotice(pluginId, "must be an object.")
  const { code, message, params } = notice
  if (typeof code !== "string" || code.length > 64 || !NOTICE_CODE.test(code))
    invalidNotice(pluginId, `invalid code ${JSON.stringify(code)}.`)
  if (
    typeof message !== "string"
    || message.trim() === ""
    || message.length > NOTICE_TEXT_MAX
  )
    invalidNotice(pluginId, "message must be non-empty text.")
  const copy: Record<string, string> = {}
  if (params !== undefined) {
    if (!isRecord(params) || Object.keys(params).length > NOTICE_PARAMS_MAX)
      invalidNotice(pluginId, "params must be a small object of strings.")
    for (const [name, value] of Object.entries(params)) {
      if (typeof value !== "string" || value.length > NOTICE_TEXT_MAX)
        invalidNotice(pluginId, `param ${JSON.stringify(name)} must be text.`)
      copy[name] = value
    }
  }
  return Object.freeze({
    code: code,
    message: message,
    ...(params === undefined ? {} : { params: Object.freeze(copy) }),
  })
}

function invalidStatus(pluginId: string, message: string): never {
  throw new PluginContractError(
    "invalid-status",
    `Plugin "${pluginId}" status: ${message}`,
    { pluginId },
  )
}

function checkStatusFacts(pluginId: string, facts: unknown): void {
  if (!Array.isArray(facts)) invalidStatus(pluginId, "facts must be an array.")
  for (const fact of facts as Array<unknown>) {
    if (
      !isRecord(fact)
      || typeof fact.label !== "string"
      || typeof fact.value !== "string"
    ) {
      invalidStatus(pluginId, "each fact needs string label and value.")
    }
  }
}

function isValidStatusAction(action: unknown): boolean {
  return (
    isRecord(action)
    && typeof action.id === "string"
    && ACTION_ID_PATTERN.test(action.id)
    && typeof action.label === "string"
    && (action.kind === undefined || ACTION_KINDS.has(action.kind as string))
    && (action.confirm === undefined || typeof action.confirm === "string")
  )
}

function checkStatusActions(pluginId: string, actions: unknown): void {
  if (!Array.isArray(actions))
    invalidStatus(pluginId, "actions must be an array.")
  for (const action of actions as Array<unknown>) {
    if (!isValidStatusAction(action)) {
      invalidStatus(
        pluginId,
        "each action needs a valid id, a label, and an optional kind/confirm.",
      )
    }
  }
}

/** Validate and deep-copy a status (frozen). */
export function normalizeStatus(
  pluginId: string,
  status: unknown,
): Readonly<PluginStatus> {
  if (!isRecord(status)) return invalidStatus(pluginId, "must be an object.")
  if (typeof status.state !== "string" || !STATUS_STATES.has(status.state)) {
    invalidStatus(pluginId, `invalid state ${JSON.stringify(status.state)}.`)
  }
  if (typeof status.code !== "string" || status.code.length === 0)
    invalidStatus(pluginId, "code must be a non-empty string.")
  if (typeof status.summary !== "string")
    invalidStatus(pluginId, "summary must be a string.")
  if (status.detail !== undefined && typeof status.detail !== "string")
    invalidStatus(pluginId, "detail must be a string.")
  if (status.facts !== undefined) checkStatusFacts(pluginId, status.facts)
  if (status.actions !== undefined) checkStatusActions(pluginId, status.actions)
  const copy = structuredClone(status) as unknown as PluginStatus
  return deepFreeze(copy)
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    for (const child of Object.values(value)) deepFreeze(child)
    Object.freeze(value)
  }
  return value
}

export function assertActionId(
  pluginId: string,
  id: unknown,
): asserts id is string {
  if (typeof id !== "string" || !ACTION_ID_PATTERN.test(id)) {
    throw new PluginContractError(
      "invalid-action",
      `Plugin "${pluginId}" action id ${JSON.stringify(id)} is invalid.`,
      {
        pluginId,
      },
    )
  }
}

export function assertStorageName(
  pluginId: string,
  name: unknown,
): asserts name is string {
  if (typeof name !== "string" || !STORAGE_NAME_PATTERN.test(name)) {
    throw new PluginContractError(
      "invalid-storage-name",
      `Plugin "${pluginId}" storage name ${JSON.stringify(name)} must match ${String(STORAGE_NAME_PATTERN)}.`,
      { pluginId },
    )
  }
  // Case-insensitive: on macOS/Windows "Settings.json" is the same file.
  if (name.toLowerCase() === PLUGIN_SETTINGS_FILE) {
    throw new PluginContractError(
      "invalid-storage-name",
      `Plugin "${pluginId}" storage name "${name}" is reserved for the host-owned settings file.`,
      { pluginId },
    )
  }
}

export function assertHttpUrl(
  pluginId: string,
  url: unknown,
): asserts url is string {
  let parsed: URL | undefined
  try {
    parsed = typeof url === "string" ? new URL(url) : undefined
  } catch {
    parsed = undefined
  }
  if (
    !parsed
    || (parsed.protocol !== "https:" && parsed.protocol !== "http:")
  ) {
    throw new PluginContractError(
      "invalid-url",
      `Plugin "${pluginId}" may only open http(s) URLs.`,
      { pluginId },
    )
  }
}
