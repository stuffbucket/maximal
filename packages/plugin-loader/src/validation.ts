import { PluginInventoryError } from "./errors"
import {
  MAX_INVENTORY_DEPTH,
  PLUGIN_INVENTORY_SCHEMA,
  type InventoryMember,
  type PluginDefinition,
  type PluginGroupDefinition,
  type PluginInventoryDocument,
} from "./types"

const ID_PATTERN = /^[a-z][a-z0-9-]{1,31}$/u
function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}
function invalid(source: string, path: string, message: string): never {
  throw new PluginInventoryError(
    "invalid-document",
    `${source}${path ? `:${path}` : ""}: ${message}`,
    { source, path },
  )
}
function record(
  source: string,
  path: string,
  value: unknown,
): Record<string, unknown> {
  if (!isRecord(value)) invalid(source, path, "must be an object")
  return value
}
// eslint-disable-next-line max-params
function knownKeys(
  source: string,
  path: string,
  value: Record<string, unknown>,
  allowed: ReadonlyArray<string>,
): void {
  const set = new Set(allowed)
  const key = Object.keys(value).find((candidate) => !set.has(candidate))
  if (key !== undefined)
    invalid(source, path, `unknown field ${JSON.stringify(key)}`)
}
function id(source: string, path: string, value: unknown): string {
  if (typeof value !== "string" || !ID_PATTERN.test(value))
    invalid(source, path, `must match ${String(ID_PATTERN)}`)
  return value
}
function text(source: string, path: string, value: unknown): string {
  if (typeof value !== "string" || value.length === 0)
    invalid(source, path, "must be non-empty text")
  return value
}

function assertDepth(value: unknown, source: string): void {
  const pending: Array<{ value: unknown; depth: number }> = [
    { value, depth: 0 },
  ]
  while (pending.length > 0) {
    const current = pending.pop()
    if (current === undefined) break
    if (current.depth > MAX_INVENTORY_DEPTH)
      invalid(
        source,
        "",
        `exceeds maximum nesting depth ${MAX_INVENTORY_DEPTH}`,
      )
    if (Array.isArray(current.value))
      for (const child of current.value)
        pending.push({ value: child, depth: current.depth + 1 })
    else if (isRecord(current.value))
      for (const child of Object.values(current.value))
        pending.push({ value: child, depth: current.depth + 1 })
  }
}

function plugin(
  source: string,
  path: string,
  value: unknown,
): PluginDefinition {
  const input = record(source, path, value)
  knownKeys(source, path, input, ["id", "descriptorId", "installationId"])
  return Object.freeze({
    id: id(source, `${path}.id`, input.id),
    descriptorId: id(source, `${path}.descriptorId`, input.descriptorId),
    ...(input.installationId === undefined ?
      {}
    : {
        installationId: id(
          source,
          `${path}.installationId`,
          input.installationId,
        ),
      }),
  })
}
function member(source: string, path: string, value: unknown): InventoryMember {
  const input = record(source, path, value)
  const keys = Object.keys(input)
  if (keys.length !== 1 || (keys[0] !== "plugin" && keys[0] !== "group"))
    invalid(source, path, 'must have exactly one of "plugin" or "group"')
  return keys[0] === "plugin" ?
      Object.freeze({ plugin: id(source, `${path}.plugin`, input.plugin) })
    : Object.freeze({ group: id(source, `${path}.group`, input.group) })
}
// eslint-disable-next-line max-params
function list<T>(
  source: string,
  path: string,
  value: unknown,
  parse: (source: string, path: string, value: unknown) => T,
): ReadonlyArray<T> {
  if (!Array.isArray(value)) invalid(source, path, "must be an array")
  return Object.freeze(
    value.map((item, index) => parse(source, `${path}[${index}]`, item)),
  )
}
function group(
  source: string,
  path: string,
  value: unknown,
): PluginGroupDefinition {
  const input = record(source, path, value)
  knownKeys(source, path, input, ["id", "members"])
  return Object.freeze({
    id: id(source, `${path}.id`, input.id),
    members: list(source, `${path}.members`, input.members, member),
  })
}

/** Validate strict, data-only JSON and return a deeply copied immutable document. */
export function parsePluginInventoryDocument(
  value: unknown,
  source = "inventory",
): PluginInventoryDocument {
  assertDepth(value, source)
  const input = record(source, "", value)
  knownKeys(source, "", input, [
    "$schema",
    "includes",
    "plugins",
    "groups",
    "members",
    "disabled",
  ])
  if (input.$schema !== PLUGIN_INVENTORY_SCHEMA)
    invalid(
      source,
      "$schema",
      `must be ${JSON.stringify(PLUGIN_INVENTORY_SCHEMA)}`,
    )
  const includes =
    input.includes === undefined ?
      undefined
    : list(source, "includes", input.includes, (itemSource, itemPath, item) =>
        text(itemSource, itemPath, item),
      )
  const plugins =
    input.plugins === undefined ?
      undefined
    : list(source, "plugins", input.plugins, plugin)
  const groups =
    input.groups === undefined ?
      undefined
    : list(source, "groups", input.groups, group)
  const members =
    input.members === undefined ?
      undefined
    : list(source, "members", input.members, member)
  const disabled =
    input.disabled === undefined ?
      undefined
    : list(source, "disabled", input.disabled, member)
  return Object.freeze({
    $schema: PLUGIN_INVENTORY_SCHEMA,
    ...(includes === undefined ? {} : { includes }),
    ...(plugins === undefined ? {} : { plugins }),
    ...(groups === undefined ? {} : { groups }),
    ...(members === undefined ? {} : { members }),
    ...(disabled === undefined ? {} : { disabled }),
  })
}
