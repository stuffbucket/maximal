import {
  createPluginGenerationSelectionToken,
  type PluginGenerationSelectionToken,
  type PluginGenerationBuild,
  preparePluginGeneration,
  reloadPluginInventory,
  type ResolvedPluginInventory,
  verifyPluginGeneration,
  PluginGenerationError,
} from "@stuffbucket/maximal-plugin-loader"
import { createHash } from "node:crypto"
import path from "node:path"

import type { TrustedInventoryContext } from "../compose"

import {
  currentPluginGenerationBuild,
  currentPluginGenerationCompatibility,
} from "../generations"

export interface InventoryStagerOptions {
  readonly context: TrustedInventoryContext
  /** The verified packaged superset: the only source of module bytes. */
  readonly base: () => Promise<PluginGenerationSelectionToken | undefined>
  /** Writable parent-owned directory for staged generations. */
  readonly stagingRoot: string
  /** `config.pluginInventory`, read on every selection. */
  readonly configured: () => { readonly entry: string } | undefined
  /** Directory the inventory entry and its includes resolve under. */
  readonly rootDirectory: string
  /**
   * The durably committed generation, if any. After a parent restart this is
   * the only memory of the last good staged generation: an inventory that
   * cannot be loaded keeps it rather than reverting to the packaged one.
   */
  readonly committed?: () => Promise<
    { readonly generationId: string; readonly artifactId?: string } | undefined
  >
  readonly build?: () => PluginGenerationBuild
  readonly log?: (message: string, error: unknown) => void
}

/**
 * Service names the host itself provides: everything a trusted module injects
 * that no trusted module provides.
 */
function hostServices(context: TrustedInventoryContext): Array<string> {
  const provided = new Set(
    [...context.metadata.values()].flatMap((entry) => entry.provides),
  )
  return [
    ...new Set(
      [...context.metadata.values()]
        .flatMap((entry) => entry.inject)
        .filter((name) => !provided.has(name)),
    ),
  ].sort()
}

function stagingKey(
  base: PluginGenerationSelectionToken,
  inventory: ResolvedPluginInventory,
): string {
  return createHash("sha256")
    .update(JSON.stringify([base.generationId, base.manifestSha256, inventory]))
    .digest("hex")
}

/**
 * Selection for managed generations that honors `config.pluginInventory`.
 *
 * With no override the packaged generation is selected as is. With one, the
 * inventory is resolved against the host-owned catalog (it can only choose
 * built-in descriptor ids), and a new immutable generation is staged from the
 * packaged superset's verified artifacts: nothing is imported or executed
 * here, the staged manifest is content-addressed over the chosen inventory,
 * and the result is sealed into a selection token the cutover pipeline takes
 * from there. An unreadable or invalid inventory keeps the last staged
 * generation (or the packaged one), like the in-process reload.
 */
export function createInventorySelector(
  options: InventoryStagerOptions,
): () => Promise<PluginGenerationSelectionToken | undefined> {
  const staged = new Map<
    string,
    { directory: string; manifestSha256: string }
  >()
  let lastGood: ResolvedPluginInventory = options.context.defaultInventory
  let lastStagedKey: string | undefined

  const build = options.build ?? currentPluginGenerationBuild
  const select = async (key: string) => {
    const entry = staged.get(key)
    if (!entry) return undefined
    // Re-verify the sealed bytes on every selection.
    return await createPluginGenerationSelectionToken(
      await verifyPluginGeneration({
        directory: entry.directory,
        trustedRoot: options.stagingRoot,
        expected: currentPluginGenerationCompatibility(),
        expectedManifestSha256: entry.manifestSha256,
      }),
    )
  }

  const recoverCommitted = async () => {
    const committed = await options.committed?.()
    if (
      !committed?.artifactId
      || !/^[a-f0-9]{64}$/.test(committed.generationId)
    )
      return undefined
    try {
      // Only a generation this parent staged (and can still verify) qualifies.
      return await createPluginGenerationSelectionToken(
        await verifyPluginGeneration({
          directory: path.join(options.stagingRoot, committed.generationId),
          trustedRoot: options.stagingRoot,
          expected: currentPluginGenerationCompatibility(),
          expectedManifestSha256: committed.artifactId,
        }),
      )
    } catch {
      return undefined
    }
  }

  const selectOnce = async () => {
    const base = await options.base()
    if (!base) return undefined
    const configured = options.configured()
    if (!configured) {
      lastStagedKey = undefined
      lastGood = options.context.defaultInventory
      return base
    }
    const loaded = await reloadPluginInventory({
      entry: configured.entry,
      rootDirectory: options.rootDirectory,
      fileSystem: options.context.fileSystem,
      catalog: options.context.catalog,
      lastGood,
    })
    if (!loaded.ok) {
      options.log?.(
        `Could not reload plugin inventory ${configured.entry}; keeping the last good generation`,
        loaded.error,
      )
      return (
        (lastStagedKey && (await select(lastStagedKey)))
        || (await recoverCommitted())
        || base
      )
    }
    const key = stagingKey(base, loaded.inventory)
    if (!staged.has(key)) {
      const generation = await stage(options, {
        base,
        inventory: loaded.inventory,
        build: build(),
      })
      staged.set(key, {
        directory: generation.directory,
        manifestSha256: generation.manifestSha256,
      })
    }
    const selected = await select(key)
    // Selections are serialized (below), so nothing else writes these.
    // eslint-disable-next-line require-atomic-updates
    lastGood = loaded.inventory

    lastStagedKey = key
    return selected
  }

  // Selections are serialized: `lastGood` and the staging cache are shared,
  // and two overlapping refreshes must not build the same generation twice.
  let tail: Promise<unknown> = Promise.resolve()
  return () => {
    const run = tail.then(selectOnce, selectOnce)
    tail = run.catch(() => undefined)
    return run
  }
}

async function stage(
  options: InventoryStagerOptions,
  request: {
    readonly base: PluginGenerationSelectionToken
    readonly inventory: ResolvedPluginInventory
    readonly build: PluginGenerationBuild
  },
): Promise<Awaited<ReturnType<typeof verifyPluginGeneration>>> {
  const { base, inventory, build } = request
  const source = await verifyPluginGeneration({
    directory: base.directory,
    trustedRoot: path.dirname(base.directory),
    expected: currentPluginGenerationCompatibility(),
    expectedManifestSha256: base.manifestSha256,
  })
  const targets = inventory.plugins.map((plugin) => {
    const { moduleId } = plugin.descriptor.module
    const module = source.manifest.modules.find(
      (candidate) => candidate.moduleId === moduleId,
    )
    const metadata = options.context.metadata.get(moduleId)
    if (!module || !metadata)
      throw new PluginGenerationError(
        "generation-not-found",
        `The packaged generation has no verified module ${moduleId} for plugin ${plugin.id}.`,
        { pluginId: plugin.id },
      )
    return {
      moduleId,
      entrypoint: path.join(source.directory, module.artifact),
      metadata,
      trustedRoots: [source.directory],
    }
  })
  return await preparePluginGeneration({
    artifactRoot: options.stagingRoot,
    inventory,
    enabledPluginIds: inventory.plugins.map((plugin) => plugin.id),
    hostServices: hostServices(options.context),
    build,
    targets,
  })
}
