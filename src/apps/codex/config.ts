import { createHash } from "node:crypto"
import fs from "node:fs"
import path from "node:path"
import { parse } from "smol-toml"

import {
  atomicWriteText,
  fsyncDirectory,
  readFileNoFollow,
} from "~/lib/platform/atomic-json"
import { proxyBaseUrl } from "~/lib/start/proxy-port"

export interface CodexAuthInvocation {
  command: string
  args: Array<string>
}

export interface PrepareCodexConfigOptions {
  invocation: CodexAuthInvocation
  createdFile?: boolean
}

export interface PreparedCodexConfig {
  status: "changed" | "unchanged"
  content: string
  providerId: string
}

export interface AppliedCodexConfigFile extends PreparedCodexConfig {
  path: string
  wrote: boolean
}

export type RevertedCodexConfig =
  | {
      status: "changed" | "unchanged"
      content: string
      removeFile?: true
    }
  | {
      status: "cleanup-required"
      content: string
      reasons: Array<"selector-modified" | "provider-modified">
    }

export type RevertedCodexConfigFile = RevertedCodexConfig & {
  path: string
  wrote: boolean
}

interface SelectorRange {
  start: number
  end: number
  statementStart: number
  statementEnd: number
  token: string
}

interface OwnershipState {
  version: 1
  providerId: string
  priorSelectorToken: string | null
  insertedSelector: string | null
  createdFile: boolean
  appendPrefix: string
  fingerprint: string
}

const PROVIDER_ID = "maximal-app"
const BEGIN_MARKER = "# >>> maximal codex routing v1:"
const END_MARKER = "# <<< maximal codex routing"

export class CodexConfigConflictError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "CodexConfigConflictError"
  }
}

function parseConfig(content: string): Record<string, unknown> {
  try {
    return parse(content)
  } catch (error) {
    throw new CodexConfigConflictError(
      `Cannot safely edit malformed Codex config: ${String(error)}`,
    )
  }
}

function newlineFor(content: string): "\n" | "\r\n" {
  return content.includes("\r\n") ? "\r\n" : "\n"
}

function findRootSelector(content: string): SelectorRange | null {
  const firstTable = /^[ \t]*\[/mu.exec(content)
  const rootEnd = firstTable?.index ?? content.length
  const root = content.slice(0, rootEnd)
  const assignment =
    /^[ \t]*model_provider[ \t]*=[ \t]*("(?:\\.|[^"\\])*"|'[^']*')/mu.exec(root)
  if (!assignment) return null

  const token = assignment[1]
  const tokenOffset = assignment[0].lastIndexOf(token)
  const start = assignment.index + tokenOffset
  const end = start + token.length
  const newlineIndex = content.indexOf("\n", end)
  return {
    start,
    end,
    statementStart: assignment.index,
    statementEnd: newlineIndex === -1 ? content.length : newlineIndex + 1,
    token,
  }
}

function encodeState(state: OwnershipState): string {
  return Buffer.from(JSON.stringify(state), "utf8").toString("base64url")
}

function decodeState(encoded: string): OwnershipState {
  try {
    const value = JSON.parse(
      Buffer.from(encoded, "base64url").toString("utf8"),
    ) as Partial<OwnershipState>
    if (
      value.version !== 1
      || typeof value.providerId !== "string"
      || (value.priorSelectorToken !== null
        && typeof value.priorSelectorToken !== "string")
      || (value.insertedSelector !== null
        && typeof value.insertedSelector !== "string")
      || typeof value.createdFile !== "boolean"
      || typeof value.appendPrefix !== "string"
      || typeof value.fingerprint !== "string"
    ) {
      throw new Error("invalid ownership fields")
    }
    return value as OwnershipState
  } catch (error) {
    throw new CodexConfigConflictError(
      `Codex ownership metadata is invalid: ${String(error)}`,
    )
  }
}

function findOwnedBlock(content: string): {
  markerStart: number
  providerStart: number
  endMarkerStart: number
  endMarkerEnd: number
  state: OwnershipState
} | null {
  const markerPattern = new RegExp(
    `^${BEGIN_MARKER.replaceAll(/[.*+?^${}()|[\]\\]/gu, String.raw`\$&`)}([^\\r\\n]+)$`,
    "gmu",
  )
  const matches = [...content.matchAll(markerPattern)]
  if (matches.length === 0) return null
  if (matches.length !== 1) {
    throw new CodexConfigConflictError("Codex ownership markers are duplicated")
  }
  const markerEnd = matches[0].index + matches[0][0].length
  const separatorLength = content.startsWith("\r\n", markerEnd) ? 2 : 1
  const providerStart = markerEnd + separatorLength
  const endMarkerPattern = new RegExp(
    `^${END_MARKER.replaceAll(/[.*+?^${}()|[\]\\]/gu, String.raw`\$&`)}$`,
    "gmu",
  )
  const endMatches = [...content.matchAll(endMarkerPattern)].filter(
    (match) => match.index >= providerStart,
  )
  if (endMatches.length !== 1) {
    throw new CodexConfigConflictError("Codex ownership block is incomplete")
  }
  return {
    markerStart: matches[0].index,
    providerStart,
    endMarkerStart: endMatches[0].index,
    endMarkerEnd: endMatches[0].index + endMatches[0][0].length,
    state: decodeState(matches[0][1]),
  }
}

function chooseProviderId(parsed: Record<string, unknown>): string {
  const reserved = new Set<string>()
  const providers = parsed.model_providers
  if (providers && typeof providers === "object" && !Array.isArray(providers)) {
    for (const providerId of Object.keys(providers)) reserved.add(providerId)
  }

  const visit = (value: unknown): void => {
    if (!value || typeof value !== "object") return
    if (Array.isArray(value)) {
      for (const item of value) visit(item)
      return
    }
    for (const [key, child] of Object.entries(value)) {
      if (key === "model_provider" && typeof child === "string") {
        reserved.add(child)
      }
      visit(child)
    }
  }
  visit(parsed)

  if (!reserved.has(PROVIDER_ID)) return PROVIDER_ID
  for (let suffix = 2; ; suffix += 1) {
    const candidate = `${PROVIDER_ID}-${suffix}`
    if (!reserved.has(candidate)) return candidate
  }
}

/** Codex's Responses endpoint on this run's proxy port. */
function codexBaseUrl(): string {
  return `${proxyBaseUrl()}/v1`
}

function desiredProvider(invocation: CodexAuthInvocation) {
  return {
    name: "Maximal",
    base_url: codexBaseUrl(),
    wire_api: "responses",
    auth: {
      command: invocation.command,
      args: invocation.args,
      timeout_ms: 5000,
      refresh_interval_ms: 300000,
    },
  }
}

function fingerprint(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex")
}

function fingerprintProvider(invocation: CodexAuthInvocation): string {
  return fingerprint(desiredProvider(invocation))
}

function currentProviderFingerprint(
  parsed: Record<string, unknown>,
  providerId: string,
): string | null {
  const providers = parsed.model_providers
  if (!providers || typeof providers !== "object" || Array.isArray(providers)) {
    return null
  }
  const provider = (providers as Record<string, unknown>)[providerId]
  return provider === undefined ? null : fingerprint(provider)
}

function referencesProvider(value: unknown, providerId: string): boolean {
  if (!value || typeof value !== "object") return false
  if (Array.isArray(value)) {
    return value.some((item) => referencesProvider(item, providerId))
  }
  return Object.entries(value).some(
    ([key, child]) =>
      (key === "model_provider" && child === providerId)
      || referencesProvider(child, providerId),
  )
}

function tomlString(value: string): string {
  return JSON.stringify(value)
}

function renderProvider(
  providerId: string,
  invocation: CodexAuthInvocation,
  newline: string,
): string {
  const args = `[${invocation.args.map((arg) => tomlString(arg)).join(",")}]`
  return [
    `[model_providers.${tomlString(providerId)}]`,
    'name = "Maximal"',
    `base_url = ${tomlString(codexBaseUrl())}`,
    'wire_api = "responses"',
    "",
    `[model_providers.${tomlString(providerId)}.auth]`,
    `command = ${tomlString(invocation.command)}`,
    `args = ${args}`,
    "timeout_ms = 5000",
    "refresh_interval_ms = 300000",
  ].join(newline)
}

function hasOwnedSemantics(content: string, state: OwnershipState): boolean {
  const parsed = parseConfig(content)
  return (
    parsed.model_provider === state.providerId
    && currentProviderFingerprint(parsed, state.providerId)
      === state.fingerprint
  )
}

function assertOwnedSemantics(content: string, state: OwnershipState): void {
  if (!hasOwnedSemantics(content, state)) {
    throw new CodexConfigConflictError(
      "Codex routing owned by Maximal has been modified",
    )
  }
}

export function prepareCodexConfig(
  content: string,
  options: PrepareCodexConfigOptions,
): PreparedCodexConfig {
  const parsed = parseConfig(content)
  const owned = findOwnedBlock(content)
  if (owned) {
    assertOwnedSemantics(content, owned.state)
    const nextFingerprint = fingerprintProvider(options.invocation)
    if (owned.state.fingerprint === nextFingerprint) {
      return {
        status: "unchanged",
        content,
        providerId: owned.state.providerId,
      }
    }

    const newline = newlineFor(content)
    const nextState = { ...owned.state, fingerprint: nextFingerprint }
    const block = [
      `${BEGIN_MARKER}${encodeState(nextState)}`,
      renderProvider(owned.state.providerId, options.invocation, newline),
      END_MARKER,
    ].join(newline)
    const next =
      content.slice(0, owned.markerStart)
      + block
      + content.slice(owned.endMarkerEnd)
    assertOwnedSemantics(next, nextState)
    return {
      status: "changed",
      content: next,
      providerId: owned.state.providerId,
    }
  }

  const providerId = chooseProviderId(parsed)
  const selector = findRootSelector(content)
  const newline = newlineFor(content)
  const selected = JSON.stringify(providerId)
  const insertedSelector =
    selector ? null : `model_provider = ${selected}${newline}`
  const transformed =
    selector ?
      content.slice(0, selector.start) + selected + content.slice(selector.end)
    : `model_provider = ${selected}${newline}${content}`
  const appendPrefix =
    transformed.endsWith(newline) ? newline : newline + newline
  const state: OwnershipState = {
    version: 1,
    providerId,
    priorSelectorToken: selector?.token ?? null,
    insertedSelector,
    createdFile: options.createdFile ?? false,
    appendPrefix,
    fingerprint: fingerprintProvider(options.invocation),
  }
  const block = [
    `${BEGIN_MARKER}${encodeState(state)}`,
    renderProvider(providerId, options.invocation, newline),
    END_MARKER,
  ].join(newline)
  const next = transformed + appendPrefix + block
  assertOwnedSemantics(next, state)

  return { status: "changed", content: next, providerId }
}

export function revertCodexConfig(content: string): RevertedCodexConfig {
  const parsed = parseConfig(content)
  const owned = findOwnedBlock(content)
  if (!owned) return { status: "unchanged", content }
  const prefixStart = owned.markerStart - owned.state.appendPrefix.length
  if (
    prefixStart < 0
    || content.slice(prefixStart, owned.markerStart)
      !== owned.state.appendPrefix
  ) {
    throw new CodexConfigConflictError("Codex ownership block moved or changed")
  }

  const withoutBlock =
    content.slice(0, prefixStart) + content.slice(owned.endMarkerEnd)
  const selector = findRootSelector(withoutBlock)
  const selectorOwned = parsed.model_provider === owned.state.providerId
  const reasons: Array<"selector-modified" | "provider-modified"> = []

  if (!selectorOwned) {
    reasons.push("selector-modified")
    if (
      currentProviderFingerprint(parsed, owned.state.providerId)
        !== owned.state.fingerprint
      || referencesProvider(parsed, owned.state.providerId)
    ) {
      reasons.push("provider-modified")
    }
    return { status: "cleanup-required", content, reasons }
  }

  let restored: string
  if (owned.state.priorSelectorToken === null) {
    if (!owned.state.insertedSelector || !selector) {
      throw new CodexConfigConflictError(
        "Codex root model_provider insertion has been modified",
      )
    }
    restored =
      withoutBlock.slice(0, selector.statementStart)
      + withoutBlock.slice(selector.statementEnd)
  } else {
    if (!selector) {
      throw new CodexConfigConflictError(
        "Codex root model_provider assignment is no longer source-editable",
      )
    }
    restored =
      withoutBlock.slice(0, selector.start)
      + owned.state.priorSelectorToken
      + withoutBlock.slice(selector.end)
  }

  const providerModified =
    currentProviderFingerprint(parsed, owned.state.providerId)
      !== owned.state.fingerprint
    || referencesProvider(parseConfig(restored), owned.state.providerId)
  if (providerModified) {
    reasons.push("provider-modified")
    const providerSource = content.slice(
      owned.providerStart,
      owned.endMarkerStart,
    )
    restored += owned.state.appendPrefix + providerSource
  }

  parseConfig(restored)
  if (reasons.length > 0) {
    return { status: "cleanup-required", content: restored, reasons }
  }
  return owned.state.createdFile && restored.length === 0 ?
      { status: "changed", content: restored, removeFile: true }
    : { status: "changed", content: restored }
}

function isErrorCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code
}

function assertNoSymlinkedParent(filePath: string): void {
  try {
    if (fs.lstatSync(path.dirname(filePath)).isSymbolicLink()) {
      throw new CodexConfigConflictError(
        "Refusing to access Codex config through a symbolic link directory",
      )
    }
  } catch (error: unknown) {
    if (!isErrorCode(error, "ENOENT")) throw error
  }
}

function readCodexConfigFile(filePath: string): string | null {
  assertNoSymlinkedParent(filePath)
  return readFileNoFollow(
    filePath,
    () =>
      new CodexConfigConflictError(
        "Refusing to read Codex config through a symbolic link",
      ),
  )
}

export function isCodexConfigFileConfigured(filePath: string): boolean {
  const content = readCodexConfigFile(filePath)
  if (content === null) return false
  parseConfig(content)
  const owned = findOwnedBlock(content)
  return owned ? hasOwnedSemantics(content, owned.state) : false
}

export function applyCodexConfigFile(
  filePath: string,
  options: PrepareCodexConfigOptions,
): AppliedCodexConfigFile {
  const original = readCodexConfigFile(filePath)
  const prepared = prepareCodexConfig(original ?? "", {
    ...options,
    createdFile: original === null,
  })
  const wrote = atomicWriteText(filePath, prepared.content, {
    label: "Codex config",
    expectedContent: original,
  })
  return { ...prepared, path: filePath, wrote }
}

function unlinkAndSyncDirectory(filePath: string): void {
  fs.unlinkSync(filePath)
  fsyncDirectory(path.dirname(filePath))
}

export function revertCodexConfigFile(
  filePath: string,
): RevertedCodexConfigFile {
  const original = readCodexConfigFile(filePath)
  if (original === null) {
    return { status: "unchanged", content: "", path: filePath, wrote: false }
  }
  const reverted = revertCodexConfig(original)
  if (reverted.status === "unchanged") {
    return { ...reverted, path: filePath, wrote: false }
  }
  if (reverted.status === "changed" && reverted.removeFile) {
    if (readCodexConfigFile(filePath) !== original) {
      throw new CodexConfigConflictError(
        "Codex config changed before it could be removed",
      )
    }
    unlinkAndSyncDirectory(filePath)
    return { ...reverted, path: filePath, wrote: true }
  }
  const wrote = atomicWriteText(filePath, reverted.content, {
    label: "Codex config",
    expectedContent: original,
  })
  return { ...reverted, path: filePath, wrote }
}
