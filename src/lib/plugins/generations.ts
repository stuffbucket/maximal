import {
  PLUGIN_API_VERSION,
  PLUGIN_RUNNER_PROTOCOL_VERSION,
  PluginGenerationError,
  PluginGenerationRepository,
  type GenerationCompatibility,
  type PluginGenerationBuild,
  type PluginGenerationSelectionToken,
} from "@stuffbucket/maximal-plugin-loader"
import { createHash } from "node:crypto"
import { realpathSync } from "node:fs"
import { readFile } from "node:fs/promises"
import path from "node:path"

import { PATHS } from "~/lib/platform/paths"
import {
  BUILD_CHANNEL,
  BUILD_GIT_SHA,
  BUILD_VERSION,
} from "~/lib/update/build-info"

export interface PluginGenerationPaths {
  readonly root: string
  readonly committed: string
}

export function pluginGenerationPaths(
  appDirectory: string = PATHS.APP_DIR,
): PluginGenerationPaths {
  const root = path.join(appDirectory, "plugin-generations")
  return Object.freeze({
    root,
    committed: path.join(root, "committed.json"),
  })
}

export function currentPluginGenerationCompatibility(): GenerationCompatibility {
  return Object.freeze({
    maximal: BUILD_VERSION,
    protocol: PLUGIN_RUNNER_PROTOCOL_VERSION,
    pluginApi: PLUGIN_API_VERSION,
    runtime: `bun:${Bun.version}`,
    platform: process.platform,
    architecture: process.arch,
  })
}

export function currentPluginGenerationBuild(): PluginGenerationBuild {
  const compatibility = currentPluginGenerationCompatibility()
  return Object.freeze({
    ...compatibility,
    id: `${BUILD_VERSION}:${BUILD_CHANNEL}:${BUILD_GIT_SHA ?? "source"}`,
  })
}

/** Production locations used by raw, package-manager, and Tauri artifacts. */
export function packagedBuiltInGenerationRoots(
  executable: string = process.execPath,
): ReadonlyArray<string> {
  const executableDirectories = new Set([path.dirname(executable)])
  try {
    executableDirectories.add(path.dirname(realpathSync(executable)))
  } catch {
    // The supplied path can be a test fixture or an already-removed executable.
  }
  return Object.freeze(
    [
      process.env.MAXIMAL_PLUGIN_BUILTINS_DIR,
      ...[...executableDirectories].flatMap((directory) => [
        path.join(directory, "plugin-builtins"),
        path.resolve(directory, "../libexec/plugin-builtins"),
        path.resolve(directory, "../Resources/plugin-builtins"),
        path.resolve(directory, "../resources/plugin-builtins"),
      ]),
      process.platform === "linux" ?
        "/usr/lib/maximal/plugin-builtins"
      : undefined,
    ].filter((candidate): candidate is string => candidate !== undefined),
  )
}

/**
 * Parent selection only: verifies packaged bytes and returns the sealed token
 * Phase 3 must pass to the runner. This never imports or executes plugin code.
 */
export async function selectPackagedBuiltInGeneration(
  root: string,
): Promise<PluginGenerationSelectionToken | undefined> {
  const repository = new PluginGenerationRepository({
    artifactRoot: root,
    commitFile: path.join(root, "committed.json"),
    compatibility: currentPluginGenerationCompatibility(),
  })
  return repository.selectCommitted()
}

export async function selectedGenerationInventoryDigest(
  token: PluginGenerationSelectionToken,
): Promise<string> {
  const bytes = new Uint8Array(
    await readFile(path.join(token.directory, "manifest.json")),
  )
  const digest = createHash("sha256").update(bytes).digest("hex")
  if (digest !== token.manifestSha256)
    throw new PluginGenerationError(
      "artifact-changed",
      "Selected plugin generation manifest changed before runner spawn.",
    )
  const value: unknown = JSON.parse(new TextDecoder().decode(bytes))
  if (
    value === null
    || typeof value !== "object"
    || !("inventoryDigest" in value)
    || typeof value.inventoryDigest !== "string"
  )
    throw new PluginGenerationError(
      "invalid-manifest",
      "Selected plugin generation has no inventory digest.",
    )
  return value.inventoryDigest
}

export async function selectAvailablePackagedBuiltInGeneration(
  roots: ReadonlyArray<string> = packagedBuiltInGenerationRoots(),
): Promise<PluginGenerationSelectionToken | undefined> {
  for (const root of roots) {
    try {
      const selected = await selectPackagedBuiltInGeneration(root)
      if (selected !== undefined) return selected
    } catch (error) {
      if (
        !(error instanceof PluginGenerationError)
        || error.code !== "generation-not-found"
      )
        throw error
    }
  }
  return undefined
}
