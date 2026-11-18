import { randomUUID } from "node:crypto"
import { lstat, readFile, rename, rm, writeFile } from "node:fs/promises"
import { z } from "zod"

import type { Model } from "~/services/copilot/get-models"

import { parseJsonText } from "~/lib/platform/json-text"

import { projectPiModels } from "./models"

const PiFile = z
  .object({ providers: z.record(z.string(), z.unknown()) })
  .loose()
const PiProvider = z
  .object({
    baseUrl: z.string(),
    models: z.array(z.object({ id: z.string() }).loose()).optional(),
  })
  .loose()

export interface SyncPiOptions {
  filePath: string
  catalog: ReadonlyArray<Model>
  write?: boolean
  creditUsd?: number
}

/** Replace only an existing Maximal provider's models, preserving its auth and every unrelated setting. */
export async function syncPiModels(options: SyncPiOptions) {
  if (!(await lstat(options.filePath)).isFile()) {
    throw new Error(
      "Pi's models.json must be a regular file; pass --file with the target instead of replacing a symlink",
    )
  }
  const originalText = await readFile(options.filePath, "utf8")
  // Refuse JSONC rather than destroy comments with a parse/stringify rewrite.
  const config = PiFile.parse(parseJsonText(originalText))
  const provider = PiProvider.parse(config.providers.maximal)
  const models = projectPiModels(
    options.catalog,
    provider.baseUrl,
    options.creditUsd,
  )
  if (models.length === 0)
    throw new Error(
      "Copilot returned no eligible Pi models; keeping the existing list",
    )
  const previous = provider.models ?? []
  const oldIds = new Set(previous.map((model) => model.id))
  const newIds = new Set(models.map((model) => model.id))
  const result = {
    models,
    added: models
      .filter((model) => !oldIds.has(model.id))
      .map((model) => model.id),
    removed: previous
      .filter((model) => !newIds.has(model.id))
      .map((model) => model.id),
    changed: JSON.stringify(previous) !== JSON.stringify(models),
    written: false,
    backup: null as string | null,
  }
  if (!options.write || !result.changed) return result
  const next = {
    ...config,
    providers: { ...config.providers, maximal: { ...provider, models } },
  }
  const suffix = `${Date.now()}-${randomUUID()}`
  const backup = `${options.filePath}.maximal-${suffix}.bak`
  const temporary = `${options.filePath}.maximal-${suffix}.tmp`
  try {
    await writeFile(temporary, `${JSON.stringify(next, null, 2)}\n`, {
      flag: "wx",
      mode: 0o600,
    })
    if ((await readFile(options.filePath, "utf8")) !== originalText) {
      throw new Error(
        "Pi's models.json changed during refresh; refusing to overwrite the newer edit",
      )
    }
    await writeFile(backup, originalText, { flag: "wx", mode: 0o600 })
    await rename(temporary, options.filePath)
    return { ...result, written: true, backup }
  } finally {
    await rm(temporary, { force: true })
  }
}
