import type { ResolvedPlugin } from "./types"

import { PluginModuleLoadError } from "./errors"

export type PluginGeneration = bigint | number | string
export interface PluginGenerationArtifact {
  readonly generation: string
  readonly specifier: string
}
export interface PluginModuleImportAdapter {
  /** Build a unique, immutable artifact containing the whole transitive generation. */
  prepareGeneration(
    plugin: ResolvedPlugin,
    generation: string,
  ): Promise<unknown>
  importModule(specifier: string): Promise<unknown>
}
export interface PluginModuleLoader {
  load(plugin: ResolvedPlugin, generation: PluginGeneration): Promise<unknown>
}
function generationText(value: unknown): string {
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value) || value < 0)
      throw new PluginModuleLoadError(
        "invalid-generation",
        "Generation must be a non-negative safe integer or non-empty string.",
      )
    return String(value)
  }
  if (typeof value === "bigint") {
    if (value < 0n)
      throw new PluginModuleLoadError(
        "invalid-generation",
        "Generation must be non-negative.",
      )
    return String(value)
  }
  if (typeof value === "string" && value.length > 0) return value
  throw new PluginModuleLoadError(
    "invalid-generation",
    "Generation has an invalid runtime type.",
  )
}
function invalidArtifact(
  pluginId: string,
  message: string,
  cause?: unknown,
): never {
  throw new PluginModuleLoadError(
    "invalid-generation-artifact",
    `Plugin ${pluginId} ${message}`,
    { pluginId, ...(cause === undefined ? {} : { cause }) },
  )
}
function validateArtifact(
  value: unknown,
  expected: string,
  pluginId: string,
): PluginGenerationArtifact {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    invalidArtifact(pluginId, "returned a malformed generation artifact.")
  let generation: unknown
  let specifier: unknown
  try {
    const record = value as Record<string, unknown>
    generation = record.generation
    specifier = record.specifier
  } catch (cause) {
    invalidArtifact(
      pluginId,
      "returned an unreadable generation artifact.",
      cause,
    )
  }
  if (
    typeof generation !== "string"
    || generation !== expected
    || typeof specifier !== "string"
    || specifier.length === 0
  )
    invalidArtifact(pluginId, "returned an invalid generation artifact.")
  return Object.freeze({ generation, specifier })
}

export function createPluginModuleLoader(
  adapter: PluginModuleImportAdapter,
): PluginModuleLoader {
  const artifacts = new Map<string, Map<string, string>>()
  return Object.freeze({
    async load(
      plugin: ResolvedPlugin,
      generation: PluginGeneration,
    ): Promise<unknown> {
      const expected = generationText(generation)
      let prepared: unknown
      try {
        prepared = await adapter.prepareGeneration(plugin, expected)
      } catch (cause) {
        throw new PluginModuleLoadError(
          "module-load-failed",
          `Could not prepare plugin ${plugin.id} generation ${expected}.`,
          { pluginId: plugin.id, cause },
        )
      }
      const artifact = validateArtifact(prepared, expected, plugin.id)
      const byGeneration =
        artifacts.get(plugin.descriptor.module.moduleId)
        ?? new Map<string, string>()
      const existing = byGeneration.get(expected)
      if (existing !== undefined && existing !== artifact.specifier)
        throw new PluginModuleLoadError(
          "invalid-generation-artifact",
          `Plugin ${plugin.id} changed the artifact for generation ${expected}.`,
          { pluginId: plugin.id, specifier: artifact.specifier },
        )
      for (const [otherGeneration, specifier] of byGeneration)
        if (otherGeneration !== expected && specifier === artifact.specifier)
          throw new PluginModuleLoadError(
            "invalid-generation-artifact",
            `Plugin ${plugin.id} reused an artifact across generations.`,
            { pluginId: plugin.id, specifier: artifact.specifier },
          )
      byGeneration.set(expected, artifact.specifier)
      artifacts.set(plugin.descriptor.module.moduleId, byGeneration)
      let namespace: unknown
      try {
        namespace = await adapter.importModule(artifact.specifier)
      } catch (cause) {
        throw new PluginModuleLoadError(
          "module-load-failed",
          `Could not import plugin ${plugin.id} generation ${expected}.`,
          { pluginId: plugin.id, specifier: artifact.specifier, cause },
        )
      }
      const exportName = plugin.descriptor.module.export
      if (exportName === undefined) return namespace
      if (
        (typeof namespace !== "object" && typeof namespace !== "function")
        || namespace === null
        || !Object.hasOwn(namespace, exportName)
      )
        throw new PluginModuleLoadError(
          "missing-export",
          `Plugin ${plugin.id} module has no own export ${JSON.stringify(exportName)}.`,
          { pluginId: plugin.id, specifier: artifact.specifier },
        )
      return namespace[exportName as keyof typeof namespace]
    },
  })
}
