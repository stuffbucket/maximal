import { randomUUID } from "node:crypto"
import { writeFile } from "node:fs/promises"
import path from "node:path"
import { z } from "zod"

import type { Model } from "~/services/copilot/get-models"

import { currentProfileId } from "~/apps/profile-identity"
import { PATHS } from "~/lib/platform/paths"

import { projectPiModels } from "./models"
import {
  inspectPiProvider,
  PiOwnershipError,
  readPiProviderFile,
  updatePiModels,
} from "./ownership"

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
  journalPath?: string
}

/** Refresh an existing provider, preserving JSONC, unrelated data, and managed ownership. */
export async function syncPiModels(options: SyncPiOptions) {
  const target = {
    filePath: path.resolve(options.filePath),
    journalPath:
      options.journalPath ?? path.join(PATHS.APP_DIR, "pi-routing.json"),
    profileId: currentProfileId(),
  }
  const original = readPiProviderFile(target.filePath)
  const provider = PiProvider.parse(original.provider)
  if (Object.hasOwn(provider, "_maximal")) {
    const inspection = inspectPiProvider(target)
    if (!inspection.enabled)
      throw new PiOwnershipError(
        inspection.conflict ?? "cleanup-required",
        "Cannot refresh an edited provider or a provider owned by another Maximal profile",
      )
  }
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
  const backup = `${target.filePath}.maximal-${Date.now()}-${randomUUID()}.bak`
  await writeFile(backup, original.text, { flag: "wx", mode: 0o600 })
  const written = updatePiModels(target, models, original.text)
  return { ...result, written, backup }
}
