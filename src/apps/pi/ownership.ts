import {
  applyEdits,
  findNodeAtLocation,
  getNodeValue,
  modify,
  parseTree,
  type Node,
  type ParseError,
} from "jsonc-parser"
import { createHash } from "node:crypto"
import fs from "node:fs"
import { z } from "zod"

import {
  atomicWriteJson,
  atomicWriteText,
  readFileNoFollow,
} from "~/lib/platform/atomic-json"

export type PiConflict =
  | "existing-provider"
  | "other-maximal-config"
  | "cleanup-required"
export class PiOwnershipError extends Error {
  readonly conflict: PiConflict
  constructor(conflict: PiConflict, message: string) {
    super(message)
    this.conflict = conflict
  }
}

export interface PiTarget {
  filePath: string
  journalPath: string
  profileId: string
}

const Marker = z
  .object({
    version: z.literal(1),
    profileId: z.string().regex(/^[a-f0-9]{64}$/u),
    previous: z.string().nullable(),
    createdProviders: z.boolean(),
    fingerprint: z.string().regex(/^[a-f0-9]{64}$/u),
  })
  .strict()
const Journal = z
  .object({
    version: z.literal(1),
    profileId: z.string(),
    filePath: z.string(),
    before: z.string().nullable(),
    after: z.string(),
  })
  .strict()
type PiMarker = z.infer<typeof Marker>

function conflict(message: string): never {
  throw new PiOwnershipError("cleanup-required", message)
}

function read(filePath: string): string | null {
  return readFileNoFollow(
    filePath,
    () =>
      new PiOwnershipError(
        "cleanup-required",
        "Pi configuration is a symbolic link; select its target explicitly",
      ),
  )
}

function rejectDuplicates(node: Node): void {
  if (node.type === "object") {
    const keys = new Set<string>()
    for (const property of node.children ?? []) {
      const key: unknown = property.children?.[0]?.value
      if (typeof key !== "string" || keys.has(key))
        conflict("Pi configuration has duplicate or invalid keys")
      keys.add(key)
    }
  }
  for (const child of node.children ?? []) rejectDuplicates(child)
}

function document(text: string) {
  const errors: Array<ParseError> = []
  // Retain offsets and the original BOM while parsing JSONC.
  const root = parseTree(text.replace(/^\ufeff/u, " "), errors, {
    allowTrailingComma: true,
  })
  if (!root || root.type !== "object" || errors.length > 0)
    conflict("Pi configuration is not a valid JSON object")
  rejectDuplicates(root)
  const providers = findNodeAtLocation(root, ["providers"])
  if (providers && providers.type !== "object")
    conflict("Pi providers must be an object")
  const node = findNodeAtLocation(root, ["providers", "maximal"])
  if (node && node.type !== "object")
    conflict("Pi's existing Maximal provider is not an object")
  const raw: unknown = node ? getNodeValue(node) : undefined
  const provider =
    node ? z.record(z.string(), z.unknown()).parse(raw) : undefined
  return { root, providers, node, provider }
}

function fingerprint(
  provider: Record<string, unknown>,
  marker: Omit<PiMarker, "fingerprint">,
): string {
  const payload = { ...provider }
  delete payload._maximal
  return createHash("sha256")
    .update(JSON.stringify([payload, marker]))
    .digest("hex")
}

function markerFor(provider: Record<string, unknown>): PiMarker | null {
  if (!Object.hasOwn(provider, "_maximal")) return null
  const parsed = Marker.safeParse(provider._maximal)
  if (!parsed.success) conflict("Pi's Maximal ownership marker is damaged")
  const { fingerprint: expected, ...metadata } = parsed.data
  if (fingerprint(provider, metadata) !== expected)
    conflict(
      "Pi's managed provider was edited outside Maximal; preserving the edit",
    )
  return parsed.data
}

function journalFor(target: PiTarget) {
  const text = read(target.journalPath)
  if (text === null) return null
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    return conflict("Pi's ownership journal is unreadable")
  }
  const parsed = Journal.safeParse(raw)
  if (
    !parsed.success
    || parsed.data.profileId !== target.profileId
    || parsed.data.filePath !== target.filePath
  ) {
    return conflict(
      "Pi's ownership journal belongs to another configuration; disable that integration first",
    )
  }
  return parsed.data
}

function edit(
  text: string,
  value: unknown,
  path = ["providers", "maximal"],
): string {
  return applyEdits(
    text,
    modify(text, path, value, {
      formattingOptions: {
        insertSpaces: !/^\t/mu.test(text),
        tabSize:
          /^ +"/mu.exec(text)?.[0].length ? /^ +/mu.exec(text)?.[0].length : 2,
        eol: text.includes("\r\n") ? "\r\n" : "\n",
      },
    }),
  )
}

function restore(text: string, marker: PiMarker): string {
  const current = document(text)
  if (!current.node) return text
  if (marker.previous !== null) {
    return (
      text.slice(0, current.node.offset)
      + marker.previous
      + text.slice(current.node.offset + current.node.length)
    )
  }
  const next = edit(text, undefined)
  const remaining = document(next).providers
  return marker.createdProviders && remaining?.children?.length === 0 ?
      edit(next, undefined, ["providers"])
    : next
}

/** Inspect ownership without creating files, keys, or enabling routing. */
export function inspectPiProvider(target: PiTarget): {
  enabled: boolean
  conflict: PiConflict | null
} {
  try {
    const text = read(target.filePath)
    const provider = text === null ? undefined : document(text).provider
    if (!provider) return { enabled: false, conflict: null }
    const marker = markerFor(provider)
    if (!marker) return { enabled: false, conflict: "existing-provider" }
    if (marker.profileId !== target.profileId)
      return { enabled: false, conflict: "other-maximal-config" }
    journalFor(target)
    return { enabled: true, conflict: null }
  } catch (error) {
    if (error instanceof PiOwnershipError)
      return { enabled: false, conflict: error.conflict }
    throw error
  }
}

function metadataFor(
  profileId: string,
  text: string,
  existing: PiMarker | null,
): Omit<PiMarker, "fingerprint"> {
  if (existing)
    return {
      version: 1,
      profileId,
      previous: existing.previous,
      createdProviders: existing.createdProviders,
    }
  const current = document(text)
  const previous =
    current.node ?
      text.slice(current.node.offset, current.node.offset + current.node.length)
    : null
  return {
    version: 1,
    profileId,
    previous,
    createdProviders: !current.providers,
  }
}

/** Claim or refresh one provider. Automatic refreshes never adopt unowned data or recreate external deletions. */
export function applyPiProvider(
  target: PiTarget,
  provider: Record<string, unknown>,
  options: {
    claim?: boolean
    adoptExisting?: boolean
    overrideOtherMaximal?: boolean
  } = {},
): boolean {
  const original = read(target.filePath)
  const text = original ?? "{}\n"
  const current = document(text)
  const existing = current.provider && markerFor(current.provider)
  const journal = journalFor(target)
  if (!options.claim && !existing)
    conflict(
      "Pi's managed provider was removed; enable explicitly to recreate it",
    )
  if (
    existing
    && existing.profileId !== target.profileId
    && !options.overrideOtherMaximal
  ) {
    throw new PiOwnershipError(
      "other-maximal-config",
      "Another Maximal profile owns Pi routing",
    )
  }
  if (current.provider && !existing && !options.adoptExisting) {
    throw new PiOwnershipError(
      "existing-provider",
      "Confirm adoption of the existing Maximal provider first",
    )
  }
  const metadata = metadataFor(target.profileId, text, existing ?? null)
  const managed = {
    ...provider,
    _maximal: { ...metadata, fingerprint: fingerprint(provider, metadata) },
  }
  const next = edit(text, managed)
  if (next === original) return false
  let before = original
  if (existing) before = journal ? journal.before : restore(text, existing)
  atomicWriteJson(target.journalPath, {
    version: 1,
    profileId: target.profileId,
    filePath: target.filePath,
    before,
    after: next,
  })
  return atomicWriteText(target.filePath, next, {
    expectedContent: original,
    label: "Pi models.json",
  })
}

/** Restore the adopted provider, or remove our new provider; never undo another person's edits. */
export function revertPiProvider(target: PiTarget): boolean {
  const original = read(target.filePath)
  const provider = original === null ? undefined : document(original).provider
  if (!provider || original === null) {
    fs.rmSync(target.journalPath, { force: true })
    return false
  }
  const marker = markerFor(provider)
  if (!marker) return false
  if (marker.profileId !== target.profileId)
    throw new PiOwnershipError(
      "other-maximal-config",
      "Another Maximal profile owns Pi routing",
    )
  const journal = journalFor(target)
  const next =
    journal?.after === original ? journal.before : restore(original, marker)
  if (next === null) fs.unlinkSync(target.filePath)
  else
    atomicWriteText(target.filePath, next, {
      expectedContent: original,
      label: "Pi models.json",
    })
  fs.rmSync(target.journalPath, { force: true })
  return true
}
