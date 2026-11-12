import type { PluginGateway } from "@stuffbucket/maximal-plugin-sdk/gateway"

import consola from "consola"
import path from "node:path"

import { getConfig } from "~/lib/config/config"
import { PATHS } from "~/lib/platform/paths"

import type { PluginStateBroker } from "../state-broker"
import type { RunnerCommandEnvironment } from "./contracts"
import type {
  ProductionGenerationManagerOptions,
  ProductionPluginGenerationManager,
} from "./generation-manager"

import {
  createParentHostServiceBroker,
  pluginStorageRoot,
  trustedInventoryContext,
} from "../compose"
import {
  pluginGenerationPaths,
  selectAvailablePackagedBuiltInGeneration,
} from "../generations"
import { createCopilotProviderBroker } from "../providers/copilot"
import { createPluginStateBroker } from "../state-broker"
import { EpochTrackedStateBroker } from "./epoch-tracker"
import { ProductionPluginGenerationManager as Manager } from "./generation-manager"
import { createInventorySelector } from "./inventory-staging"

export interface ProductionRunnerOptions {
  readonly select?: typeof selectAvailablePackagedBuiltInGeneration
  readonly command?: RunnerCommandEnvironment
  /** Parent state root override for isolated source-mode validation. */
  readonly storageRoot?: string
  /** Control plane override (fault-injection in tests). */
  readonly state?: PluginStateBroker
  readonly lifecycle?: ProductionGenerationManagerOptions["lifecycle"]
  readonly cutover?: ProductionGenerationManagerOptions["cutover"]
  readonly supervisorConfig?: ProductionGenerationManagerOptions["supervisorConfig"]
  readonly desiredSettings?: ProductionGenerationManagerOptions["desiredSettings"]
  readonly fenceRetries?: number
  /** Shared exclusive-resource lease registry (tests inject their own). */
  readonly leases?: ProductionGenerationManagerOptions["leases"]
}

function runningUnderBun(executable: string): boolean {
  const basename = executable.split(/[\\/]/u).at(-1)?.toLowerCase()
  return basename === "bun" || basename === "bun.exe"
}

/** Compiled releases must carry a sealed generation; source/npm runs may not. */
export function isPackagedPluginRuntime(
  executable: string = process.execPath,
): boolean {
  return !runningUnderBun(executable)
}

export interface ProductionRunnerEnvironmentOptions {
  readonly executable: string
  readonly argumentEntry?: string
  readonly cwd: string
  readonly fallbackSourceEntry: string
  readonly baseEnv?: Readonly<Record<string, string>>
}

/** Resolve source, built-JS, and compiled-binary runner command inputs. */
export function productionRunnerEnvironment(
  options: ProductionRunnerEnvironmentOptions,
): RunnerCommandEnvironment {
  const packaged = isPackagedPluginRuntime(options.executable)
  const sourceEntry =
    (
      !packaged
      && options.argumentEntry
      && [".js", ".mjs", ".ts"].includes(path.extname(options.argumentEntry))
    ) ?
      path.resolve(options.argumentEntry)
    : path.resolve(options.fallbackSourceEntry)
  return {
    executable: options.executable,
    sourceEntry,
    cwd: options.cwd,
    packaged,
    ...(options.baseEnv === undefined ? {} : { baseEnv: options.baseEnv }),
  }
}

function environment(): RunnerCommandEnvironment {
  const baseEnv = Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] => entry[1] !== undefined,
    ),
  )
  return productionRunnerEnvironment({
    executable: process.execPath,
    argumentEntry: process.argv[1],
    cwd: process.cwd(),
    fallbackSourceEntry: path.resolve(import.meta.dir, "../../../main.ts"),
    baseEnv,
  })
}

/**
 * Start the long-lived generation manager over the selected immutable
 * built-in generation. It returns `undefined` when no generation is packaged.
 * The manager's stable gateway outlives every individual generation; call
 * `refresh()` (see `refreshProductionPluginGeneration`) to cut over N -> N+1.
 */
export async function startProductionPluginGenerationManager(
  options: ProductionRunnerOptions = {},
): Promise<ProductionPluginGenerationManager | undefined> {
  // Every in-process control mutation (including the provider's) goes through
  // the tracker so the generation fences see the live epoch.
  const state = new EpochTrackedStateBroker(
    options.state
      ?? createPluginStateBroker(options.storageRoot ?? pluginStorageRoot()),
  )
  // Selection follows `config.pluginInventory`: a configured inventory is
  // staged into a new sealed generation from the packaged one on every refresh.
  const select =
    options.select
    ?? createInventorySelector({
      context: trustedInventoryContext(),
      base: () => selectAvailablePackagedBuiltInGeneration(),
      stagingRoot: path.join(pluginGenerationPaths().root, "staged"),
      configured: () => getConfig().pluginInventory,
      committed: async () => {
        const committed = await state.committedGeneration()
        if (!committed) return undefined
        const record = committed.generationRecord as
          | { artifactId?: string }
          | undefined
        return {
          generationId: committed.generationId,
          ...(record?.artifactId === undefined ?
            {}
          : { artifactId: record.artifactId }),
        }
      },
      rootDirectory: PATHS.APP_DIR,
      log: (message, error) => consola.warn(message, error),
    })
  return await Manager.start({
    select: () => select(),
    command: options.command ?? environment(),
    state,
    host: createParentHostServiceBroker(),
    provider: createCopilotProviderBroker({
      commitControlMutation: async (digest) => {
        await state.advanceEpoch("provider:copilot", digest)
      },
    }),
    ...(options.lifecycle === undefined ?
      {}
    : { lifecycle: options.lifecycle }),
    desiredSettings: options.desiredSettings ?? (() => getConfig().plugins),
    log: (message, error) => consola.warn(message, error),
    ...(options.cutover === undefined ? {} : { cutover: options.cutover }),
    ...(options.supervisorConfig === undefined ?
      {}
    : { supervisorConfig: options.supervisorConfig }),
    ...(options.leases === undefined ? {} : { leases: options.leases }),
    ...(options.fenceRetries === undefined ?
      {}
    : { fenceRetries: options.fenceRetries }),
  })
}

/** Start the production runner and return its stable parent gateway. */
export async function startProductionPluginRunner(
  options: ProductionRunnerOptions = {},
): Promise<PluginGateway | undefined> {
  return (await startProductionPluginGenerationManager(options))?.gateway
}
