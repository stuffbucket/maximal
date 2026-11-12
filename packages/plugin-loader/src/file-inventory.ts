import { PluginInventoryError } from "./errors"
import { resolvePluginInventory } from "./resolver"
import {
  InventoryReadFailure,
  MAX_INVENTORY_BYTES,
  MAX_INVENTORY_FILES,
  type InventoryDocumentSource,
  type InventoryFileSystem,
  type InventoryOpenedFile,
  type InventoryReloadResult,
  type PluginCatalog,
  type ResolvedPluginInventory,
} from "./types"
import { parsePluginInventoryDocument } from "./validation"

function safeReference(reference: string, source: string): void {
  if (
    reference.length === 0
    || reference.includes("\\")
    || reference.includes("\0")
    || reference.startsWith("/")
    || /^[a-z][a-z0-9+.-]*:/iu.test(reference)
    || reference
      .split("/")
      .some((part) => part === "" || part === "." || part === "..")
  )
    throw new PluginInventoryError(
      "unsafe-include",
      `${source}: unsafe include ${JSON.stringify(reference)}.`,
      { source, path: "includes" },
    )
}
function readError(source: string, error: unknown): PluginInventoryError {
  if (error instanceof PluginInventoryError) return error
  if (error instanceof InventoryReadFailure) {
    const codes = {
      "not-found": "read-not-found",
      "permission-denied": "read-permission-denied",
      "too-large": "read-too-large",
      io: "read-failed",
    } as const
    return new PluginInventoryError(
      codes[error.code],
      `Could not read inventory ${JSON.stringify(source)}: ${error.message}`,
      { source, cause: error },
    )
  }
  return new PluginInventoryError(
    "read-failed",
    `Inventory adapter failed for ${JSON.stringify(source)}.`,
    { source, cause: error },
  )
}

export async function loadPluginInventory(options: {
  readonly entry: string
  readonly rootDirectory: string
  readonly fileSystem: InventoryFileSystem
  readonly catalog: PluginCatalog
}): Promise<ResolvedPluginInventory> {
  const documents = new Map<string, InventoryDocumentSource>()
  const load = async (opened: InventoryOpenedFile): Promise<void> => {
    if (documents.has(opened.canonicalId)) return
    if (documents.size >= MAX_INVENTORY_FILES)
      throw new PluginInventoryError(
        "expansion-limit",
        `Inventory exceeds ${MAX_INVENTORY_FILES} files.`,
        { source: opened.canonicalId },
      )
    if (new TextEncoder().encode(opened.text).byteLength > MAX_INVENTORY_BYTES)
      throw new PluginInventoryError(
        "read-too-large",
        `Inventory ${opened.canonicalId} exceeds ${MAX_INVENTORY_BYTES} bytes.`,
        { source: opened.canonicalId },
      )
    let raw: unknown
    try {
      raw = JSON.parse(opened.text)
    } catch (cause) {
      throw new PluginInventoryError(
        "invalid-json",
        `${opened.canonicalId}: invalid JSON.`,
        { source: opened.canonicalId, cause },
      )
    }
    const document = parsePluginInventoryDocument(raw, opened.canonicalId)
    const item: InventoryDocumentSource = {
      source: opened.canonicalId,
      document,
      includeSources: [],
    }
    documents.set(opened.canonicalId, item)
    const includeSources: Array<string> = []
    for (const reference of document.includes ?? []) {
      safeReference(reference, opened.canonicalId)
      let child: InventoryOpenedFile
      try {
        child = await options.fileSystem.openInclude({
          rootDirectory: options.rootDirectory,
          parentCanonicalId: opened.canonicalId,
          reference,
          maxBytes: MAX_INVENTORY_BYTES,
        })
      } catch (error) {
        throw readError(reference, error)
      }
      includeSources.push(child.canonicalId)
      await load(child)
    }
    documents.set(opened.canonicalId, {
      ...item,
      includeSources: Object.freeze(includeSources),
    })
  }
  let entry: InventoryOpenedFile
  try {
    entry = await options.fileSystem.openEntry({
      rootDirectory: options.rootDirectory,
      entry: options.entry,
      maxBytes: MAX_INVENTORY_BYTES,
    })
  } catch (error) {
    throw readError(options.entry, error)
  }
  await load(entry)
  try {
    return resolvePluginInventory({
      entry: entry.canonicalId,
      documents: [...documents.values()],
      catalog: options.catalog,
    })
  } catch (error) {
    if (error instanceof PluginInventoryError) throw error
    throw new PluginInventoryError(
      "resolution-failed",
      "Inventory resolution failed.",
      { cause: error },
    )
  }
}

export async function reloadPluginInventory(options: {
  readonly entry: string
  readonly rootDirectory: string
  readonly fileSystem: InventoryFileSystem
  readonly catalog: PluginCatalog
  readonly lastGood: ResolvedPluginInventory
}): Promise<InventoryReloadResult> {
  try {
    return Object.freeze({
      ok: true,
      inventory: await loadPluginInventory(options),
    })
  } catch (error) {
    const controlled =
      error instanceof PluginInventoryError ? error : (
        new PluginInventoryError(
          "resolution-failed",
          "Inventory reload failed.",
          { cause: error },
        )
      )
    return Object.freeze({
      ok: false,
      inventory: options.lastGood,
      error: controlled,
    })
  }
}
