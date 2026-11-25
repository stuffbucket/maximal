import type {
  ConnectorAuth,
  ConnectorLaneLimits,
  ConnectorLimits,
  ConnectorManifest,
  ConnectorRetryLimits,
  JsonSchemaObject,
  PluginManifest,
} from "../types"

import { PluginContractError } from "../errors"
import { PLUGIN_KINDS, type PluginKind } from "../types"

type JsonRecord = Record<string, unknown>

function isRecord(value: unknown): value is JsonRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

function isPlainObject(value: object): boolean {
  const proto: unknown = Object.getPrototypeOf(value)
  return proto === Object.prototype || proto === null
}

/**
 * Path of the first value that does not survive `JSON.stringify` unchanged
 * (functions, symbols, bigints, non-finite numbers, class instances,
 * cycles, `undefined` array items), or `undefined` when `value` is plain
 * JSON. `undefined` object properties are allowed (they mean "absent").
 */
export function nonJsonPath(
  value: unknown,
  path = "",
  seen = new Set<object>(),
): string | undefined {
  const here = path || "(root)"
  if (value === null || typeof value === "string" || typeof value === "boolean")
    return undefined
  if (typeof value === "number")
    return Number.isFinite(value) ? undefined : here
  if (typeof value !== "object" || seen.has(value)) return here
  if (!Array.isArray(value) && !isPlainObject(value)) return here
  seen.add(value)
  try {
    return Array.isArray(value) ?
        nonJsonItem(value as Array<unknown>, path, seen)
      : nonJsonEntry(value as JsonRecord, path, seen)
  } finally {
    seen.delete(value)
  }
}

function nonJsonItem(
  items: Array<unknown>,
  path: string,
  seen: Set<object>,
): string | undefined {
  for (const [index, item] of items.entries()) {
    const itemPath = `${path}[${index}]`
    if (item === undefined) return itemPath
    const found = nonJsonPath(item, itemPath, seen)
    if (found !== undefined) return found
  }
  return undefined
}

function nonJsonEntry(
  record: JsonRecord,
  path: string,
  seen: Set<object>,
): string | undefined {
  for (const [key, item] of Object.entries(record)) {
    if (item === undefined) continue
    const found = nonJsonPath(item, path ? `${path}.${key}` : key, seen)
    if (found !== undefined) return found
  }
  return undefined
}

function isHttpUrl(value: unknown): value is string {
  if (typeof value !== "string") return false
  try {
    const { protocol } = new URL(value)
    return protocol === "https:" || protocol === "http:"
  } catch {
    return false
  }
}

/** A bare `host` or `host:port` (what `URL.host` gives), lower case. */
function isHost(value: unknown): value is string {
  if (typeof value !== "string" || value === "") return false
  try {
    return new URL(`https://${value}`).host === value
  } catch {
    return false
  }
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0
}

function isStringList(value: unknown): value is Array<string> {
  return Array.isArray(value) && value.every((item) => isNonEmptyString(item))
}

function isNonNegative(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
}

const LIMIT_NUMBERS = [
  "maxConcurrency",
  "minConcurrency",
  "maxQueue",
  "queueTimeoutMs",
  "fetchBatchSize",
  "progressIntervalMs",
] as const
const RETRY_NUMBERS = ["attempts", "jitter", "maxWaitMs", "budgetMs"] as const
const LANE_NUMBERS = ["maxConcurrency", "minIntervalMs"] as const
/** Lane names: short identifiers (`teams`, `outlook`, …). */
const LANE_NAME = /^[a-z][\w-]{0,31}$/i

class ManifestReader {
  readonly id: string

  constructor(id: string) {
    this.id = id
  }

  fail(message: string): never {
    throw new PluginContractError(
      "invalid-manifest",
      `Plugin "${this.id}" manifest: ${message}`,
      { pluginId: this.id },
    )
  }

  display(
    value: JsonRecord,
  ): Pick<PluginManifest, "displayName" | "description" | "homepage"> {
    const { displayName, description, homepage } = value
    if (!isNonEmptyString(displayName))
      this.fail("displayName must be a non-empty string.")
    if (typeof description !== "string")
      this.fail("description must be a string.")
    if (homepage !== undefined && !isHttpUrl(homepage))
      this.fail("homepage must be an http(s) URL.")
    return {
      displayName: displayName,
      description: description,
      ...(homepage === undefined ? {} : { homepage: homepage }),
    }
  }

  settingsVersion(value: unknown): number {
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1)
      this.fail("settingsVersion must be a positive integer.")
    return value
  }

  configSchema(value: unknown): JsonSchemaObject | undefined {
    if (value === undefined) return undefined
    if (!isRecord(value) || value.type !== "object")
      this.fail('configSchema must be a JSON Schema with type "object".')
    return structuredClone(value) as JsonSchemaObject
  }

  auth(value: unknown): ConnectorAuth {
    if (!isRecord(value)) return this.fail("connector.auth must be an object.")
    switch (value.type) {
      case "entra": {
        if (!isNonEmptyString(value.clientId))
          this.fail("connector.auth.clientId must be a non-empty string.")
        if (!isHttpUrl(value.authority))
          this.fail("connector.auth.authority must be an http(s) URL.")
        if (!isStringList(value.scopes) || value.scopes.length === 0)
          this.fail("connector.auth.scopes must be a non-empty string list.")
        if (!isHttpUrl(value.redirectUri))
          this.fail("connector.auth.redirectUri must be an http(s) URL.")
        return {
          type: "entra",
          clientId: value.clientId,
          authority: value.authority,
          scopes: [...value.scopes],
          redirectUri: value.redirectUri,
        }
      }
      case "mcp-oauth": {
        if (value.clientId !== undefined && !isNonEmptyString(value.clientId))
          this.fail("connector.auth.clientId must be a non-empty string.")
        if (value.scopes !== undefined && !isStringList(value.scopes))
          this.fail("connector.auth.scopes must be a string list.")
        return {
          type: "mcp-oauth",
          ...(value.clientId === undefined ? {} : { clientId: value.clientId }),
          ...(value.scopes === undefined ? {} : { scopes: [...value.scopes] }),
        }
      }
      case "none": {
        return { type: "none" }
      }
      default: {
        return this.fail(
          'connector.auth.type must be "entra", "mcp-oauth" or "none".',
        )
      }
    }
  }

  /** Copy the known non-negative number fields of `value` (absent ones stay absent). */
  numbers<K extends string>(
    value: JsonRecord,
    keys: ReadonlyArray<K>,
    where: string,
  ): Partial<Record<K, number>> {
    const out: Partial<Record<K, number>> = {}
    for (const key of keys) {
      const item = value[key]
      if (item === undefined) continue
      if (!isNonNegative(item))
        this.fail(`${where}.${key} must be a non-negative number.`)
      out[key] = item
    }
    return out
  }

  record(value: unknown, where: string): JsonRecord {
    return isRecord(value) ? value : this.fail(`${where} must be an object.`)
  }

  retryLimits(value: unknown): ConnectorRetryLimits {
    const where = "connector.limits.retry"
    const retry = this.record(value, where)
    const out: ConnectorRetryLimits = this.numbers(retry, RETRY_NUMBERS, where)
    const { fallbackDelaysMs, retryWritesOn429 } = retry
    if (fallbackDelaysMs !== undefined) {
      if (
        !Array.isArray(fallbackDelaysMs)
        || !fallbackDelaysMs.every((item) => isNonNegative(item))
      )
        this.fail(
          `${where}.fallbackDelaysMs must be a list of non-negative numbers.`,
        )
      out.fallbackDelaysMs = [...fallbackDelaysMs]
    }
    if (retryWritesOn429 !== undefined) {
      if (typeof retryWritesOn429 !== "boolean")
        this.fail(`${where}.retryWritesOn429 must be a boolean.`)
      out.retryWritesOn429 = retryWritesOn429
    }
    return out
  }

  limits(value: unknown): ConnectorLimits | undefined {
    if (value === undefined) return undefined
    const where = "connector.limits"
    const limits = this.record(value, where)
    const out: ConnectorLimits = this.numbers(limits, LIMIT_NUMBERS, where)
    if (limits.lanes !== undefined) {
      const lanes: Record<string, ConnectorLaneLimits> = {}
      for (const [name, lane] of Object.entries(
        this.record(limits.lanes, `${where}.lanes`),
      )) {
        if (!LANE_NAME.test(name))
          this.fail(
            `${where}.lanes has an invalid lane name ${JSON.stringify(name)}.`,
          )
        const laneWhere = `${where}.lanes.${name}`
        lanes[name] = this.numbers(
          this.record(lane, laneWhere),
          LANE_NUMBERS,
          laneWhere,
        )
      }
      out.lanes = lanes
    }
    if (limits.retry !== undefined) out.retry = this.retryLimits(limits.retry)
    return out
  }

  allowedHosts(value: unknown): Array<string> | undefined {
    if (value === undefined) return undefined
    if (!Array.isArray(value) || !value.every((host) => isHost(host)))
      this.fail(
        'connector.allowedHosts must be a list of lower-case hosts ("host" or "host:port").',
      )
    return [...value]
  }

  connector(kind: PluginKind, value: unknown): ConnectorManifest | undefined {
    if (kind !== "connector") {
      if (value !== undefined)
        this.fail('connector is only allowed when kind is "connector".')
      return undefined
    }
    if (!isRecord(value))
      return this.fail('kind "connector" requires a connector section.')
    if (value.transport !== "streamable-http")
      this.fail('connector.transport must be "streamable-http".')
    if (!isHttpUrl(value.endpoint))
      this.fail("connector.endpoint must be an http(s) URL.")
    const allowedHosts = this.allowedHosts(value.allowedHosts)
    const auth = this.auth(value.auth)
    const limits = this.limits(value.limits)
    const base: ConnectorManifest = {
      transport: "streamable-http",
      endpoint: value.endpoint,
      ...(allowedHosts === undefined ? {} : { allowedHosts }),
      auth,
      ...(limits === undefined ? {} : { limits }),
    }
    const { terms } = value
    if (terms === undefined) return base
    if (!isRecord(terms) || !isHttpUrl(terms.url))
      this.fail("connector.terms.url must be an http(s) URL.")
    const { label } = terms
    if (label !== undefined && typeof label !== "string")
      this.fail("connector.terms.label must be a string.")
    return {
      ...base,
      terms: {
        url: terms.url,
        ...(label === undefined ? {} : { label: label }),
      },
    }
  }
}

export function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    for (const child of Object.values(value)) deepFreeze(child)
    Object.freeze(value)
  }
  return value
}

/**
 * Validate a plugin's `manifest` export and return a frozen copy holding
 * only the known fields. Throws `PluginContractError` (`invalid-manifest`).
 */
export function normalizeManifest(
  id: string,
  value: unknown,
): Readonly<PluginManifest> {
  const reader = new ManifestReader(id)
  if (!isRecord(value)) return reader.fail("must be an object.")
  const badPath = nonJsonPath(value)
  if (badPath !== undefined)
    reader.fail(`must be JSON-serialisable (offending value at ${badPath}).`)
  if (value.id !== id)
    reader.fail(`id ${JSON.stringify(value.id)} must equal the module name.`)
  const kind = value.kind as PluginKind
  if (!PLUGIN_KINDS.includes(kind))
    reader.fail(`kind must be one of ${PLUGIN_KINDS.join(", ")}.`)
  const display = reader.display(value)
  const settingsVersion = reader.settingsVersion(value.settingsVersion)
  const configSchema = reader.configSchema(value.configSchema)
  const connector = reader.connector(kind, value.connector)
  return deepFreeze({
    id,
    kind,
    ...display,
    settingsVersion,
    ...(configSchema === undefined ? {} : { configSchema }),
    ...(connector === undefined ? {} : { connector }),
  })
}
