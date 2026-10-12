import { randomUUID } from "node:crypto"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { isDeepStrictEqual } from "node:util"
import { z } from "zod"

import { findSetting, parseConfig, replaceSetting, valueAt } from "./toml"

export const CODEX_BASE_URL = "http://127.0.0.1:4141/v1"
const START = "# >>> maximal codex >>>"
const END = "# <<< maximal codex <<<"
const STATE = "# maximal-codex-state: "

const RoutingState = z.object({
  version: z.literal(1),
  provider: z.string(),
  edits: z.array(
    z.object({
      keys: z
        .array(z.string())
        .refine(
          (keys) =>
            (keys.length === 1 || (keys.length === 3 && keys[0] === "profiles"))
            && ["model", "model_provider"].includes(keys.at(-1) ?? ""),
        ),
      before: z.string().nullable(),
      after: z.string(),
      value: z.string(),
    }),
  ),
})

type RoutingState = z.infer<typeof RoutingState>

function routingBlock(state: RoutingState): string {
  const metadata = Buffer.from(JSON.stringify(state)).toString("base64")
  return `\n${START}\n${STATE}${metadata}\n${state.provider}${END}\n`
}

export function codexConfigPath(): string {
  return path.join(
    process.env.CODEX_HOME || path.join(os.homedir(), ".codex"),
    "config.toml",
  )
}

export function readCodexConfig(): string {
  try {
    return fs.readFileSync(codexConfigPath(), "utf8")
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT")
      return ""
    throw new Error(
      "Could not read Codex config.toml. Check its file permissions.",
    )
  }
}

function ownedState(
  text: string,
): { state: RoutingState; block: string } | null {
  const start = text.indexOf(`\n${START}\n`)
  if (start === -1) {
    if (text.includes(START) || text.includes(STATE))
      throw new Error(
        "Codex routing markers were edited. Restore them before changing routing.",
      )
    return null
  }
  const end = text.indexOf(`${END}\n`, start)
  const block = text.slice(start, end + END.length + 1)
  const metadata = block.split("\n")[2]
  try {
    if (
      end === -1
      || !metadata.startsWith(STATE)
      || text.includes(START, start + START.length + 1)
    )
      throw new Error()
    const decoded: unknown = JSON.parse(
      Buffer.from(metadata.slice(STATE.length), "base64").toString("utf8"),
    )
    return { state: RoutingState.parse(decoded), block }
  } catch {
    throw new Error(
      "Codex routing metadata is damaged. Restore it before changing routing.",
    )
  }
}

function effectiveKeys(
  text: string,
  key: "model" | "model_provider",
): Array<string> {
  const document = parseConfig(text)
  const profile = document.profile
  if (typeof profile === "string") {
    const keys = ["profiles", profile, key]
    if (valueAt(document, keys) !== undefined) return keys
  }
  return [key]
}

export function configuredModel(text: string): string | null {
  const value = valueAt(parseConfig(text), effectiveKeys(text, "model"))
  return typeof value === "string" ? value : null
}

export function selectedProvider(text: string): string {
  const value = valueAt(
    parseConfig(text),
    effectiveKeys(text, "model_provider"),
  )
  return typeof value === "string" ? value : "openai"
}

function providerIdOf(provider: string): string {
  const providers = valueAt(parseConfig(provider), ["model_providers"])
  if (
    typeof providers !== "object"
    || providers === null
    || Array.isArray(providers)
  ) {
    throw new Error("Codex routing metadata does not identify a provider.")
  }
  const keys = Object.keys(providers)
  if (keys.length !== 1)
    throw new Error("Codex routing metadata must identify one provider.")
  return keys[0]
}

export function chooseProviderId(text: string): string {
  const owned = ownedState(text)
  if (owned) return providerIdOf(owned.state.provider)
  const document = parseConfig(text)
  let candidate = "maximal-app"
  let suffix = 2
  while (
    valueAt(document, ["model_providers", candidate]) !== undefined
    || referencesProvider(document, candidate)
  ) {
    candidate = `maximal-app-${suffix++}`
  }
  return candidate
}

export function isCodexEnabled(text: string): boolean {
  const owned = ownedState(text)
  if (!owned) return false
  const document = parseConfig(text)
  const providerId = providerIdOf(owned.state.provider)
  return (
    selectedProvider(text) === providerId
    && isDeepStrictEqual(
      valueAt(document, ["model_providers", providerId]),
      valueAt(parseConfig(owned.state.provider), [
        "model_providers",
        providerId,
      ]),
    )
  )
}

export function hasCodexRouting(text: string): boolean {
  return ownedState(text) !== null
}

export function hasUnmanagedProvider(text: string): boolean {
  return (
    !hasCodexRouting(text)
    && valueAt(parseConfig(text), [
      "model_providers",
      selectedProvider(text),
      "base_url",
    ]) === CODEX_BASE_URL
  )
}

function matchesManagedSelection(
  text: string,
  provider: string,
  model: string,
): boolean {
  return (
    isCodexEnabled(text)
    && configuredModel(text) === model
    && providerIdOf(provider) === chooseProviderId(text)
  )
}

export function prepareCodexConfig(
  text: string,
  provider: string,
  model: string,
): string {
  const owned = ownedState(text)
  if (owned) {
    if (matchesManagedSelection(text, provider, model)) {
      if (provider === owned.state.provider) return text
      if (owned.block !== routingBlock(owned.state)) {
        throw new Error(
          "The managed Codex block was edited. Disconnect it before updating the connection.",
        )
      }
      // Change only our intact provider block, preserving the original scalar
      // restore point and later user edits. Never adopt user-edited providers.
      const nextState = { ...owned.state, provider }
      const next = text.replace(owned.block, routingBlock(nextState))
      parseConfig(next)
      return next
    }
    throw new Error(
      "Codex routing has changed. Switch it off before enabling it again.",
    )
  }
  const providerId = providerIdOf(provider)
  if (providerId !== chooseProviderId(text)) {
    throw new Error(
      "Codex provider settings changed. Try enabling routing again.",
    )
  }
  const state: RoutingState = { version: 1, provider, edits: [] }
  let next = text
  for (const [key, value] of [
    ["model_provider", providerId],
    ["model", model],
  ] as const) {
    const keys = effectiveKeys(text, key)
    if (valueAt(parseConfig(text), keys) === value) continue
    const before = findSetting(next, keys)?.text ?? null
    const newline = before?.endsWith("\r\n") ? "\r\n" : "\n"
    const after = `${key} = ${JSON.stringify(value)}${newline}`
    next = replaceSetting(next, keys, { replacement: after, value })
    state.edits.push({ keys, before, after, value })
  }
  next += routingBlock(state)
  const expected = parseConfig(text)
  const restored = revertCodexConfig(next)
  if (
    !isDeepStrictEqual(parseConfig(restored), expected)
    || !isCodexEnabled(next)
    || configuredModel(next) !== model
  ) {
    throw new Error(
      "Could not prepare reversible Codex routing. No settings were changed.",
    )
  }
  return next
}

function referencesProvider(value: unknown, providerId: string): boolean {
  if (typeof value !== "object" || value === null) return false
  return Object.entries(value).some(
    ([key, child]) =>
      (key === "model_provider" && child === providerId)
      || referencesProvider(child, providerId),
  )
}

export function revertCodexConfig(text: string): string {
  const owned = ownedState(text)
  if (!owned) return text
  let next = text
  for (const edit of owned.state.edits.toReversed()) {
    const current = findSetting(next, edit.keys)
    if (current?.text !== edit.after) continue
    const beforeValue =
      edit.before === null ?
        undefined
      : valueAt(
          parseConfig(
            edit.keys.length === 1 ?
              edit.before
            : `[profiles.${JSON.stringify(edit.keys[1])}]\n${edit.before}`,
          ),
          edit.keys,
        )
    next = replaceSetting(next, edit.keys, {
      replacement: edit.before ?? "",
      value: beforeValue,
    })
  }
  const document = parseConfig(next)
  const providerId = providerIdOf(owned.state.provider)
  const providerIsOurs = isDeepStrictEqual(
    valueAt(document, ["model_providers", providerId]),
    valueAt(parseConfig(owned.state.provider), ["model_providers", providerId]),
  )
  const exactBlock = routingBlock(owned.state)
  next =
    (
      providerIsOurs
      && !referencesProvider(document, providerId)
      && owned.block === exactBlock
    ) ?
      next.replace(owned.block, "")
    : next.replace(
        owned.block,
        owned.block
          .split("\n")
          .filter(
            (line) => line !== START && line !== END && !line.startsWith(STATE),
          )
          .join("\n"),
      )
  parseConfig(next)
  return next
}

export function writeCodexConfig(before: string, after: string): void {
  if (before === after) return
  parseConfig(after)
  const filePath = codexConfigPath()
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  if (fs.existsSync(filePath) && fs.lstatSync(filePath).isSymbolicLink()) {
    throw new Error(
      "Codex config.toml is a symlink. Routing was left unchanged.",
    )
  }
  const temporary = `${filePath}.${randomUUID()}.tmp`
  const descriptor = fs.openSync(temporary, "wx", 0o600)
  try {
    try {
      fs.writeFileSync(descriptor, after)
      fs.fsyncSync(descriptor)
    } finally {
      fs.closeSync(descriptor)
    }
    if (readCodexConfig() !== before)
      throw new Error("Codex settings changed during verification. Try again.")
    fs.renameSync(temporary, filePath)
  } finally {
    if (fs.existsSync(temporary)) fs.unlinkSync(temporary)
  }
}
