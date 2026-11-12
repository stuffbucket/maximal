#!/usr/bin/env bun

import {
  PLUGIN_API_VERSION,
  PLUGIN_RUNNER_PROTOCOL_VERSION,
  PluginGenerationRepository,
  preparePluginGeneration,
  type PluginGenerationBuild,
  type PreparedPluginGeneration,
} from "@stuffbucket/maximal-plugin-loader"
import { mkdir, rename, rm } from "node:fs/promises"
import path from "node:path"

import { trustedInventoryContext } from "../src/lib/plugins/compose"

const REPO = path.resolve(import.meta.dir, "..")

const ENTRYPOINTS = Object.freeze({
  workiq: "packages/plugin-workiq/src/index.ts",
  figjam: "packages/plugin-figjam/src/index.ts",
  decisions: "packages/plugin-decisions/src/index.ts",
  systemone: "packages/plugin-systemone/src/index.ts",
  images: "packages/plugin-images/src/index.ts",
})

export interface BuildPluginBuiltInsOptions {
  readonly output: string
  readonly version: string
  readonly channel: string
  readonly gitSha: string
  readonly runtime: string
  readonly platform: string
  readonly architecture: string
}

function nonempty(value: string | undefined, label: string): string {
  const normalized = value?.trim()
  if (!normalized) throw new Error(`${label} must be a non-empty string.`)
  return normalized
}

function hostServices(
  context: ReturnType<typeof trustedInventoryContext>,
): Array<string> {
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

/** Build and atomically publish one complete sealed built-in generation root. */
export async function buildPluginBuiltIns(
  options: BuildPluginBuiltInsOptions,
): Promise<PreparedPluginGeneration> {
  const output = path.resolve(nonempty(options.output, "Output path"))
  const build: PluginGenerationBuild = Object.freeze({
    id: `${nonempty(options.version, "Version")}:${nonempty(options.channel, "Channel")}:${nonempty(options.gitSha, "Git SHA")}`,
    maximal: options.version,
    protocol: PLUGIN_RUNNER_PROTOCOL_VERSION,
    pluginApi: PLUGIN_API_VERSION,
    runtime: nonempty(options.runtime, "Runtime"),
    platform: nonempty(options.platform, "Platform"),
    architecture: nonempty(options.architecture, "Architecture"),
  })
  if (!build.runtime.startsWith("bun:"))
    throw new Error("Runtime must use the bun:<version> identity.")

  const context = trustedInventoryContext()
  const temporary = `${output}.${process.pid}.${crypto.randomUUID()}.tmp`
  await rm(temporary, { recursive: true, force: true })
  await mkdir(path.dirname(output), { recursive: true })
  try {
    const generation = await preparePluginGeneration({
      artifactRoot: temporary,
      inventory: context.defaultInventory,
      enabledPluginIds: context.defaultInventory.plugins.map(
        (plugin) => plugin.id,
      ),
      hostServices: hostServices(context),
      build,
      targets: context.defaultInventory.plugins.map((plugin) => {
        const moduleId = plugin.descriptor.module.moduleId
        const metadata = context.metadata.get(moduleId)
        const relative = ENTRYPOINTS[moduleId as keyof typeof ENTRYPOINTS]
        if (!metadata || !relative)
          throw new Error(`No packaged source target exists for ${moduleId}.`)
        return {
          moduleId,
          entrypoint: path.join(REPO, relative),
          metadata,
          trustedRoots: [REPO],
        }
      }),
    })
    const repository = new PluginGenerationRepository({
      artifactRoot: temporary,
      commitFile: path.join(temporary, "committed.json"),
      compatibility: build,
    })
    await repository.commit(generation)
    await rm(output, { recursive: true, force: true })
    await rename(temporary, output)
    return {
      ...generation,
      directory: path.join(output, generation.manifest.generationId),
      manifestPath: path.join(
        output,
        generation.manifest.generationId,
        "manifest.json",
      ),
    }
  } catch (error) {
    await rm(temporary, { recursive: true, force: true }).catch(() => undefined)
    throw error
  }
}

function parseArguments(argv: ReadonlyArray<string>): BuildPluginBuiltInsOptions {
  const values = new Map<string, string>()
  for (const argument of argv) {
    const match = argument.match(/^--([a-z-]+)=(.+)$/u)
    if (!match) throw new Error(`Unknown argument ${JSON.stringify(argument)}.`)
    values.set(match[1], match[2])
  }
  const required = [
    "output",
    "version",
    "channel",
    "git-sha",
    "runtime",
    "platform",
    "architecture",
  ] as const
  for (const key of required)
    if (!values.has(key)) throw new Error(`Missing --${key}=... argument.`)
  if (values.size !== required.length)
    throw new Error("The built-in generation command received an unknown option.")
  return {
    output: nonempty(values.get("output"), "Output path"),
    version: nonempty(values.get("version"), "Version"),
    channel: nonempty(values.get("channel"), "Channel"),
    gitSha: nonempty(values.get("git-sha"), "Git SHA"),
    runtime: nonempty(values.get("runtime"), "Runtime"),
    platform: nonempty(values.get("platform"), "Platform"),
    architecture: nonempty(values.get("architecture"), "Architecture"),
  }
}

if (import.meta.main) {
  const generation = await buildPluginBuiltIns(parseArguments(process.argv.slice(2)))
  console.error(
    `[build-plugin-builtins] generation=${generation.manifest.generationId} root=${path.dirname(generation.directory)}`,
  )
}
