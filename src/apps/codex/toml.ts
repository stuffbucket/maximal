import { isDeepStrictEqual } from "node:util"

export type TomlDocument = Record<string, unknown>

export function parseConfig(text: string): TomlDocument {
  try {
    return Bun.TOML.parse(text) as TomlDocument
  } catch {
    throw new Error(
      "Codex config.toml is invalid. Fix its TOML before changing routing.",
    )
  }
}

export function valueAt(document: unknown, keys: Array<string>): unknown {
  let value = document
  for (const key of keys) {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      return undefined
    }
    value = (value as TomlDocument)[key]
  }
  return value
}

function assign(
  document: TomlDocument,
  keys: Array<string>,
  value: unknown,
): void {
  const parent = valueAt(document, keys.slice(0, -1)) as TomlDocument
  const key = keys.at(-1)
  if (!key) throw new Error("Missing Codex setting name.")
  if (value === undefined) Reflect.deleteProperty(parent, key)
  else parent[key] = value
}

export function findSetting(
  text: string,
  keys: Array<string>,
): { start: number; end: number; text: string } | null {
  if (valueAt(parseConfig(text), keys) === undefined) return null
  let start = 0
  let end = 0
  for (const line of text.match(/[^\n]*\n|[^\n]+$/gu) ?? []) {
    end += line.length
    let prefix: TomlDocument
    try {
      prefix = Bun.TOML.parse(text.slice(0, end)) as TomlDocument
    } catch {
      continue
    }
    if (valueAt(prefix, keys) !== undefined) {
      return { start, end, text: text.slice(start, end) }
    }
    start = end
  }
  throw new Error("Could not locate the Codex routing setting safely.")
}

export function replaceSetting(
  text: string,
  keys: Array<string>,
  edit: { replacement: string; value: unknown },
): string {
  const { replacement, value } = edit
  const document = parseConfig(text)
  const setting = findSetting(text, keys)
  if (!setting && keys.length !== 1) {
    throw new Error(
      "This Codex profile uses an unsupported TOML layout. No settings were changed.",
    )
  }
  const next =
    setting ?
      text.slice(0, setting.start) + replacement + text.slice(setting.end)
    : replacement + text
  assign(document, keys, value)
  if (!isDeepStrictEqual(parseConfig(next), document)) {
    throw new Error(
      "Could not change Codex routing without affecting other settings. No settings were changed.",
    )
  }
  return next
}
