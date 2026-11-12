import path from "node:path"

/**
 * The host-owned per-plugin settings file `<storage dir>/<id>/settings.json`:
 * envelope parsing, settings-version migration, config validation, tool
 * permissions and the cached tool catalog. Shared by the plugin host and the
 * `/testing` harness so both negotiate settings identically.
 */
import type { PluginModule } from "../index"
import type { PluginStorageBackend } from "./services"

import {
  isToolPermission,
  PLUGIN_SETTINGS_FILE,
  TOOL_NAME_PATTERN,
  toolGroup,
  type PluginManifest,
  type PluginToolView,
  type ToolDefinitionPublic,
  type ToolPermission,
  type ToolPermissionSource,
} from "../types"
import { nonJsonPath } from "./manifest"
import { parsePluginConfig, type ParsedPluginConfig } from "./validate"

/** Envelope version written to `$schema`. */
export const PLUGIN_SETTINGS_SCHEMA = "maximal-plugin-settings/1"

const SCHEMA_PREFIX = "maximal-plugin-settings/"
const MAX_SETTINGS_BYTES = 1024 * 1024
const UNSAFE_KEYS = new Set(["__proto__", "constructor", "prototype"])

/** Last non-empty tool set a plugin registered. */
export interface ToolCatalog {
  /** ISO 8601. */
  updatedAt: string
  tools: Array<ToolDefinitionPublic>
}

/** Host-owned `tools` section (connectors and extensions alike). */
export interface PluginSettingsTools {
  /** Explicit choices only, keyed by tool name. Unknown values are preserved but ignored. */
  permissions?: Record<string, string>
  catalog?: ToolCatalog
  [key: string]: unknown
}

/** `settings.json` as stored. Unknown keys are preserved on write. */
export interface PluginSettingsDocument {
  $schema: string
  plugin: string
  /** The plugin's settings version the `config` is shaped for. */
  version: number
  /** Plugin-owned; validated by the plugin's `Config`. Absent ⇒ `{}`. */
  config?: unknown
  tools?: PluginSettingsTools
  [key: string]: unknown
}

/** Raised for a settings file that must not be used or overwritten. */
export class PluginSettingsFileError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options)
    this.name = "PluginSettingsFileError"
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

function unsafeKey(value: unknown): string | undefined {
  if (value === null || typeof value !== "object") return undefined
  for (const [key, child] of Object.entries(value)) {
    if (UNSAFE_KEYS.has(key)) return key
    const nested = unsafeKey(child)
    if (nested !== undefined) return nested
  }
  return undefined
}

/** A fresh, empty document for `manifest` (current settings version). */
export function newSettingsDocument(
  manifest: Pick<PluginManifest, "id" | "settingsVersion">,
): PluginSettingsDocument {
  return {
    $schema: PLUGIN_SETTINGS_SCHEMA,
    plugin: manifest.id,
    version: manifest.settingsVersion,
  }
}

function isPublicTool(value: unknown): value is ToolDefinitionPublic {
  const objectSchema = (schema: unknown) =>
    isRecord(schema) && schema.type === "object"
  return (
    isRecord(value)
    && typeof value.name === "string"
    && TOOL_NAME_PATTERN.test(value.name)
    && typeof value.description === "string"
    && (value.title === undefined || typeof value.title === "string")
    && objectSchema(value.inputSchema)
    && (value.outputSchema === undefined || objectSchema(value.outputSchema))
    && (value.annotations === undefined || isRecord(value.annotations))
  )
}

function readCatalogValue(value: unknown): ToolCatalog | undefined {
  if (
    !isRecord(value)
    || typeof value.updatedAt !== "string"
    || !Array.isArray(value.tools)
    || !value.tools.every((tool) => isPublicTool(tool))
  )
    return undefined
  return { updatedAt: value.updatedAt, tools: value.tools }
}

function readToolsSection(
  value: unknown,
  invalid: (message: string) => never,
): PluginSettingsTools | undefined {
  if (value === undefined) return undefined
  if (!isRecord(value)) return invalid('"tools" must be an object')
  const tools: PluginSettingsTools = { ...value }
  const { permissions } = value
  if (
    permissions !== undefined
    && (!isRecord(permissions)
      || !Object.values(permissions).every((item) => typeof item === "string"))
  )
    invalid('"tools.permissions" must map tool names to strings')
  // The catalog is only a cache: a malformed one is dropped, not fatal.
  const catalog = readCatalogValue(value.catalog)
  if (catalog === undefined) delete tools.catalog
  else tools.catalog = catalog
  return tools
}

/**
 * Parse and check a settings file's text. Throws `PluginSettingsFileError`
 * for anything the host must neither use nor overwrite: invalid JSON, an
 * unknown or newer envelope, another plugin's file, a bad `version` or a
 * malformed `tools.permissions`.
 */
export function parseSettingsDocument(
  pluginId: string,
  text: string,
  label = PLUGIN_SETTINGS_FILE,
): PluginSettingsDocument {
  const invalid = (message: string): never => {
    throw new PluginSettingsFileError(
      `Plugin settings file ${label} ${message}. Fix or delete it; Maximal will not overwrite it.`,
    )
  }
  if (Buffer.byteLength(text) > MAX_SETTINGS_BYTES)
    invalid("is larger than 1 MiB")
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch (error) {
    invalid(
      `is not valid JSON (${error instanceof Error ? error.message : String(error)})`,
    )
  }
  if (!isRecord(value)) return invalid("is not a JSON object")
  const unsafe = unsafeKey(value)
  if (unsafe !== undefined) invalid(`contains the unsafe key "${unsafe}"`)
  const schema = value.$schema
  if (schema !== PLUGIN_SETTINGS_SCHEMA) {
    invalid(
      typeof schema === "string" && schema.startsWith(SCHEMA_PREFIX) ?
        `was written by a newer Maximal (${schema})`
      : `is not a Maximal plugin settings file ("$schema" must be "${PLUGIN_SETTINGS_SCHEMA}")`,
    )
  }
  if (value.plugin !== pluginId)
    invalid(`belongs to plugin ${JSON.stringify(value.plugin)}`)
  const { version } = value
  if (
    typeof version !== "number"
    || !Number.isSafeInteger(version)
    || version < 1
  )
    invalid('has an invalid "version" (expected a positive integer)')
  const tools = readToolsSection(value.tools, invalid)
  const document = { ...value } as PluginSettingsDocument
  if (tools === undefined) delete document.tools
  else document.tools = tools
  return document
}

/** Stable, readable serialisation (envelope keys first, 2-space indent). */
export function serializeSettingsDocument(
  document: PluginSettingsDocument,
): string {
  const { $schema, plugin, version, config, tools, ...rest } = document
  return `${JSON.stringify(
    {
      $schema,
      plugin,
      version,
      ...(config === undefined ? {} : { config }),
      ...(tools === undefined ? {} : { tools }),
      ...rest,
    },
    null,
    2,
  )}\n`
}

/**
 * Bring `document` to the plugin's current settings version with its
 * `migrateSettings` export (config carried over unchanged when absent).
 * Throws `PluginSettingsFileError` when the file is newer than the plugin or
 * the migration throws / returns non-JSON. Never mutates `document`.
 */
export async function migrateSettingsDocument(
  module: Pick<PluginModule, "migrateSettings">,
  manifest: Pick<PluginManifest, "id" | "settingsVersion">,
  document: PluginSettingsDocument,
): Promise<{ document: PluginSettingsDocument; migrated: boolean }> {
  const target = manifest.settingsVersion
  if (document.version === target) return { document, migrated: false }
  if (document.version > target) {
    throw new PluginSettingsFileError(
      `Plugin "${manifest.id}" settings are version ${document.version}, newer than this version of the plugin supports (${target}). Update Maximal, or delete the settings file.`,
    )
  }
  let config: unknown = document.config
  if (module.migrateSettings) {
    try {
      config = await module.migrateSettings(document.version, document.config)
    } catch (error) {
      throw new PluginSettingsFileError(
        `Plugin "${manifest.id}" could not migrate its settings from version ${document.version}: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      )
    }
    if (config !== undefined && nonJsonPath(config) !== undefined) {
      throw new PluginSettingsFileError(
        `Plugin "${manifest.id}" migrateSettings returned a value that is not plain JSON.`,
      )
    }
  }
  const { config: _previous, ...rest } = document
  return {
    document: {
      ...rest,
      version: target,
      ...(config === undefined ? {} : { config }),
    },
    migrated: true,
  }
}

export type LoadedPluginSettings =
  | {
      ok: true
      document: PluginSettingsDocument
      /** The file existed on disk. */
      exists: boolean
      /** The document was migrated (and, when the config is valid, written back). */
      migrated: boolean
      /** `document.config` validated against the plugin's `Config`. */
      parsed: ParsedPluginConfig
      /** Set when the post-migration write-back failed (the migrated document is still used). */
      writeError?: string
    }
  | {
      ok: false
      /** Why the file cannot be used. The host never overwrites it. */
      error: string
    }

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Read → envelope check → migrate → validate config → write back when
 * migrated and valid (never when invalid or unreadable).
 */
export async function loadPluginSettings(
  backend: PluginStorageBackend,
  module: PluginModule,
  manifest: Pick<PluginManifest, "id" | "settingsVersion">,
): Promise<LoadedPluginSettings> {
  const { id } = manifest
  const label = path.join(backend.dir(id), PLUGIN_SETTINGS_FILE)
  let text: string | undefined
  try {
    text = await backend.readText(id, PLUGIN_SETTINGS_FILE)
  } catch (error) {
    return {
      ok: false,
      error: `Plugin settings file ${label} could not be read (${errorText(error)}). Maximal will not overwrite it.`,
    }
  }
  let document: PluginSettingsDocument
  let migrated: boolean
  try {
    ;({ document, migrated } = await migrateSettingsDocument(
      module,
      manifest,
      text === undefined ?
        newSettingsDocument(manifest)
      : parseSettingsDocument(id, text, label),
    ))
  } catch (error) {
    return { ok: false, error: errorText(error) }
  }
  const parsed = await parsePluginConfig(module, document.config)
  let writeError: string | undefined
  if (migrated && parsed.ok) {
    try {
      await backend.writeText(
        id,
        PLUGIN_SETTINGS_FILE,
        serializeSettingsDocument(document),
      )
    } catch (error) {
      writeError = errorText(error)
    }
  }
  return {
    ok: true,
    document,
    exists: text !== undefined,
    migrated,
    parsed,
    ...(writeError === undefined ? {} : { writeError }),
  }
}

/** Write `document` through `backend` (atomic in the file backend). */
export async function writePluginSettings(
  backend: PluginStorageBackend,
  document: PluginSettingsDocument,
): Promise<void> {
  await backend.writeText(
    document.plugin,
    PLUGIN_SETTINGS_FILE,
    serializeSettingsDocument(document),
  )
}

/** Public, serialisable copy of a tool definition (schemas cloned). */
export function toPublicTool(tool: ToolDefinitionPublic): ToolDefinitionPublic {
  return {
    name: tool.name,
    ...(tool.title === undefined ? {} : { title: tool.title }),
    description: tool.description,
    inputSchema: structuredClone(tool.inputSchema),
    ...(tool.outputSchema === undefined ?
      {}
    : { outputSchema: structuredClone(tool.outputSchema) }),
    ...(tool.annotations === undefined ?
      {}
    : { annotations: { ...tool.annotations } }),
  }
}

/** Explicit (user) permissions from a document. */
export function storedPermissions(
  document: PluginSettingsDocument | undefined,
): Readonly<Record<string, string>> {
  return document?.tools?.permissions ?? {}
}

/**
 * Effective permission: explicit (settings file) > plugin
 * `defaultToolPermission` > host default (`allow` for a read-only tool,
 * `ask` for anything that may change something). A throwing or invalid
 * plugin default is ignored.
 */
export function resolveToolPermission(
  module: Pick<PluginModule, "defaultToolPermission">,
  tool: ToolDefinitionPublic,
  explicit: Readonly<Record<string, string>>,
): { permission: ToolPermission; permissionSource: ToolPermissionSource } {
  const stored =
    Object.hasOwn(explicit, tool.name) ? explicit[tool.name] : undefined
  if (isToolPermission(stored))
    return { permission: stored, permissionSource: "user" }
  if (module.defaultToolPermission) {
    try {
      const fallback: unknown = module.defaultToolPermission(toPublicTool(tool))
      if (isToolPermission(fallback))
        return { permission: fallback, permissionSource: "plugin" }
    } catch {
      // A broken plugin default never blocks the host default.
    }
  }
  return {
    permission: toolGroup(tool) === "read-only" ? "allow" : "ask",
    permissionSource: "default",
  }
}

export function toolView(
  module: Pick<PluginModule, "defaultToolPermission">,
  tool: ToolDefinitionPublic,
  explicit: Readonly<Record<string, string>>,
): PluginToolView {
  return {
    ...toPublicTool(tool),
    group: toolGroup(tool),
    ...resolveToolPermission(module, tool, explicit),
  }
}

/** Error text for a malformed `setToolPermissions` change set, or `undefined`. */
export function permissionChangesError(changes: unknown): string | undefined {
  if (!isRecord(changes)) return "Permission changes must be an object."
  for (const [name, value] of Object.entries(changes)) {
    if (!TOOL_NAME_PATTERN.test(name))
      return `Invalid tool name ${JSON.stringify(name)}.`
    if (value !== null && !isToolPermission(value))
      return `Invalid permission ${JSON.stringify(value)} for tool "${name}" (expected "allow", "ask", "block" or null).`
  }
  return undefined
}

/**
 * Apply validated permission changes to `document` (mutates; `null`
 * removes the explicit choice). Returns whether anything changed.
 */
export function applyPermissionChanges(
  document: PluginSettingsDocument,
  changes: Readonly<Record<string, ToolPermission | null>>,
): boolean {
  const permissions = { ...document.tools?.permissions }
  let changed = false
  for (const [name, value] of Object.entries(changes)) {
    if (value === null) {
      if (!Object.hasOwn(permissions, name)) continue
      // eslint-disable-next-line @typescript-eslint/no-dynamic-delete -- keyed by tool name
      delete permissions[name]
    } else {
      if (permissions[name] === value) continue
      permissions[name] = value
    }
    changed = true
  }
  if (!changed) return false
  const tools: PluginSettingsTools = { ...document.tools }
  if (Object.keys(permissions).length > 0) tools.permissions = permissions
  else delete tools.permissions
  if (Object.keys(tools).length > 0) document.tools = tools
  else delete document.tools
  return true
}

/** Store `tools` as the cached catalog (mutates `document`). */
export function setToolCatalog(
  document: PluginSettingsDocument,
  tools: ReadonlyArray<ToolDefinitionPublic>,
  now: Date = new Date(),
): void {
  document.tools = {
    ...document.tools,
    catalog: {
      updatedAt: now.toISOString(),
      tools: tools.map((tool) => toPublicTool(tool)),
    },
  }
}
