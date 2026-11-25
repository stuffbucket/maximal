/* eslint-disable complexity, max-lines, max-lines-per-function, max-params */
import { createHash } from "node:crypto"
import {
  chmod,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises"
import path from "node:path"
import { pathToFileURL } from "node:url"

import type {
  PluginDescriptor,
  ResolvedPlugin,
  ResolvedPluginInventory,
} from "./types"

import { PluginGenerationError, type PluginGenerationErrorCode } from "./errors"

export const PLUGIN_GENERATION_SCHEMA = "maximal-plugin-generation/1" as const
export const PLUGIN_GENERATION_COMMIT_SCHEMA =
  "maximal-plugin-generation-commit/1" as const
export const PLUGIN_RUNNER_PROTOCOL_VERSION = "maximal-plugin-runner/2" as const
export const PLUGIN_API_VERSION = "maximal-plugin-api/1" as const
const SHA256_PATTERN = /^[a-f0-9]{64}$/u
const SAFE_FILE_PATTERN = /^[a-z0-9][a-z0-9._-]*$/u
const EXPORT_PATTERN = /^[A-Za-z_$][\w$]*$/u

export interface GenerationCompatibility {
  readonly maximal: string
  readonly protocol: string
  readonly pluginApi: string
  readonly runtime: string
  readonly platform: string
  readonly architecture: string
}

export interface PluginGenerationBuild extends GenerationCompatibility {
  readonly id: string
}

export interface GenerationStaticMetadata {
  /** Must equal the exported plugin module's `name`. */
  readonly name: string
  /** Canonical service names from the exported module's `inject` declaration. */
  readonly inject: ReadonlyArray<string>
  /** Canonical service names from the exported module's `provides` declaration. */
  readonly provides: ReadonlyArray<string>
}

export interface GenerationModuleDescriptor {
  readonly pluginId: string
  readonly descriptorId: string
  readonly provenance: "built-in" | "external"
  readonly moduleId: string
  readonly export?: string
  readonly artifact: string
  readonly sha256: string
  readonly bytes: number
  readonly installationId?: string
  readonly package?: {
    readonly name: string
    readonly version?: string
  }
  /** Build-time data contract; the runner revalidates it against the module. */
  readonly metadata: GenerationStaticMetadata
}

export interface PluginGenerationManifest {
  readonly $schema: typeof PLUGIN_GENERATION_SCHEMA
  readonly generationId: string
  readonly build: PluginGenerationBuild
  readonly inventoryDigest: string
  readonly modules: ReadonlyArray<GenerationModuleDescriptor>
}

export interface GenerationSourceTarget {
  readonly moduleId: string
  readonly entrypoint: string
  /** Static package/build metadata; never discovered by executing plugin code. */
  readonly metadata: GenerationStaticMetadata
  /** Explicit code roots approved by the stable parent. */
  readonly trustedRoots: ReadonlyArray<string>
}

interface BuildOutput {
  readonly kind: string
  readonly path: string
}
interface BuildResult {
  readonly success: boolean
  readonly logs: ReadonlyArray<unknown>
  readonly outputs: ReadonlyArray<BuildOutput>
  readonly metafile?: {
    readonly inputs: Readonly<Record<string, unknown>>
    readonly outputs: Readonly<
      Record<
        string,
        {
          readonly exports: ReadonlyArray<string>
          readonly imports: ReadonlyArray<unknown>
        }
      >
    >
  }
}
export interface GenerationBuildOptions {
  readonly entrypoints: Array<string>
  readonly outdir: string
  readonly target: "bun"
  readonly format: "esm"
  readonly packages: "bundle"
  readonly splitting: false
  readonly sourcemap: "none"
  readonly naming: string
  readonly metafile: true
}
export type GenerationBuildFunction = (
  options: GenerationBuildOptions,
) => Promise<BuildResult>

export interface PreparePluginGenerationOptions {
  readonly artifactRoot: string
  readonly inventory: ResolvedPluginInventory
  /** Runtime enablement comes only from config.plugins. */
  readonly enabledPluginIds: ReadonlyArray<string>
  readonly hostServices: ReadonlyArray<string>
  readonly build: PluginGenerationBuild
  readonly targets: ReadonlyArray<GenerationSourceTarget>
  readonly buildModule?: GenerationBuildFunction
}

export interface PreparedPluginGeneration {
  readonly directory: string
  readonly manifestPath: string
  readonly manifest: PluginGenerationManifest
  readonly manifestSha256: string
}

export const PLUGIN_GENERATION_SELECTION_SCHEMA =
  "maximal-plugin-generation-selection/1" as const
export const RUNNER_REVERIFY_CONTRACT =
  "runner-hash-and-module-metadata-reverify-before-import/1" as const

export interface GenerationSelectionArtifactIdentity {
  readonly artifact: string
  readonly sha256: string
  readonly bytes: number
}

/**
 * Parent-issued, content-addressed selection. Phase 3 must pass this whole token
 * to the child; the child must call `reverifyGenerationSelectionForRunner`
 * immediately before using any module.
 */
export interface PluginGenerationSelectionToken {
  readonly $schema: typeof PLUGIN_GENERATION_SELECTION_SCHEMA
  readonly reverify: typeof RUNNER_REVERIFY_CONTRACT
  readonly directory: string
  readonly generationId: string
  readonly manifestSha256: string
  readonly artifacts: ReadonlyArray<GenerationSelectionArtifactIdentity>
  readonly seal: string
}

export interface CommittedGenerationRecord {
  readonly $schema: typeof PLUGIN_GENERATION_COMMIT_SCHEMA
  readonly committedGenerationId: string
  readonly committedManifestSha256: string
  readonly lastKnownGoodGenerationId: string
  readonly lastKnownGoodManifestSha256: string
}

export interface GenerationLease {
  readonly generationId: string
  release(): void
}

export interface GenerationGarbageCollectionResult {
  readonly removed: ReadonlyArray<string>
  readonly retained: ReadonlyArray<string>
}

function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value)
  if (Array.isArray(value))
    return `[${value.map((item) => canonical(item)).join(",")}]`
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, child]) => `${JSON.stringify(key)}:${canonical(child)}`)
    .join(",")}}`
}

function sha256(value: string | Uint8Array): Promise<string> {
  return Promise.resolve(createHash("sha256").update(value).digest("hex"))
}

function isInside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate)
  return (
    relative === ""
    || (!path.isAbsolute(relative)
      && relative !== ".."
      && !relative.startsWith(`..${path.sep}`))
  )
}

function compatibilityFailure(
  plugin: ResolvedPlugin,
  field: keyof GenerationCompatibility,
  required: string | ReadonlyArray<string>,
  actual: string,
): never {
  throw new PluginGenerationError(
    "incompatible-plugin",
    `Plugin ${plugin.id} requires ${field} ${JSON.stringify(required)}, not ${JSON.stringify(actual)}.`,
    { pluginId: plugin.id },
  )
}

function assertPluginCompatibility(
  plugin: ResolvedPlugin,
  build: PluginGenerationBuild,
): void {
  const compatibility = plugin.descriptor.compatibility
  if (compatibility === undefined) return
  for (const field of ["maximal", "pluginApi", "runtime"] as const) {
    const required = compatibility[field]
    if (required !== undefined && required !== build[field])
      compatibilityFailure(plugin, field, required, build[field])
  }
  if (
    compatibility.platforms !== undefined
    && !compatibility.platforms.includes(build.platform)
  )
    compatibilityFailure(
      plugin,
      "platform",
      compatibility.platforms,
      build.platform,
    )
  if (
    compatibility.architectures !== undefined
    && !compatibility.architectures.includes(build.architecture)
  )
    compatibilityFailure(
      plugin,
      "architecture",
      compatibility.architectures,
      build.architecture,
    )
}

function canonicalServiceList(
  values: unknown,
  label: string,
): ReadonlyArray<string> {
  if (
    !Array.isArray(values)
    || !values.every(
      (value: unknown): value is string =>
        typeof value === "string" && value.length > 0,
    )
    || new Set(values).size !== values.length
  )
    throw new PluginGenerationError(
      "invalid-manifest",
      `${label} must contain unique non-empty service names.`,
    )
  return Object.freeze([...values].sort())
}

function staticMetadata(
  plugin: ResolvedPlugin,
  target: GenerationSourceTarget,
): GenerationStaticMetadata {
  if (target.metadata.name !== plugin.id)
    throw new PluginGenerationError(
      "module-metadata-mismatch",
      `Static metadata names plugin ${JSON.stringify(target.metadata.name)}, not ${JSON.stringify(plugin.id)}.`,
      { pluginId: plugin.id },
    )
  return Object.freeze({
    name: target.metadata.name,
    inject: canonicalServiceList(
      target.metadata.inject,
      `Plugin ${plugin.id} inject metadata`,
    ),
    provides: canonicalServiceList(
      target.metadata.provides,
      `Plugin ${plugin.id} provides metadata`,
    ),
  })
}

function dependencyOrder(
  inventory: ResolvedPluginInventory,
  enabledPluginIds: ReadonlyArray<string>,
  hostServices: ReadonlyArray<string>,
  targets: ReadonlyMap<string, GenerationSourceTarget>,
): ReadonlyArray<ResolvedPlugin> {
  const byId = new Map(inventory.plugins.map((plugin) => [plugin.id, plugin]))
  const enabled = new Set(enabledPluginIds)
  if (enabled.size !== enabledPluginIds.length)
    throw new PluginGenerationError(
      "invalid-manifest",
      "Enabled plugin ids must be unique.",
    )
  for (const id of enabled)
    if (!byId.has(id))
      throw new PluginGenerationError(
        "missing-provider",
        `Enabled plugin ${id} is not in the resolved inventory.`,
        { pluginId: id },
      )
  const providers = new Map<string, string>()
  const host = new Set(hostServices)
  const metadata = new Map<string, GenerationStaticMetadata>()
  for (const plugin of inventory.plugins) {
    const target = targets.get(plugin.descriptor.module.moduleId)
    if (target === undefined)
      throw new PluginGenerationError(
        "untrusted-path",
        `No trusted source target exists for plugin ${plugin.id}.`,
        { pluginId: plugin.id },
      )
    metadata.set(plugin.id, staticMetadata(plugin, target))
    if (!enabled.has(plugin.id)) continue
    for (const service of metadata.get(plugin.id)?.provides ?? []) {
      if (host.has(service) || providers.has(service))
        throw new PluginGenerationError(
          "duplicate-provider",
          `Enabled plugin ${plugin.id} duplicates provider for service ${service}.`,
          { pluginId: plugin.id },
        )
      providers.set(service, plugin.id)
    }
  }
  const dependencies = new Map<string, ReadonlyArray<string>>()
  for (const plugin of inventory.plugins) {
    if (!enabled.has(plugin.id)) continue
    const required: Array<string> = []
    for (const service of metadata.get(plugin.id)?.inject ?? []) {
      if (host.has(service)) continue
      const provider = providers.get(service)
      if (provider === undefined)
        throw new PluginGenerationError(
          "missing-provider",
          `Enabled plugin ${plugin.id} injects service ${service}, but no enabled plugin provides it.`,
          { pluginId: plugin.id },
        )
      required.push(provider)
    }
    dependencies.set(plugin.id, required)
  }
  const ordered: Array<ResolvedPlugin> = []
  const done = new Set<string>()
  const active: Array<string> = []
  const visit = (id: string): void => {
    if (done.has(id)) return
    const cycleAt = active.indexOf(id)
    if (cycleAt !== -1)
      throw new PluginGenerationError(
        "dependency-cycle",
        `Enabled plugin dependency cycle: ${[...active.slice(cycleAt), id].join(" -> ")}.`,
        { pluginId: id },
      )
    active.push(id)
    for (const dependency of dependencies.get(id) ?? []) visit(dependency)
    active.pop()
    done.add(id)
    const plugin = byId.get(id)
    if (plugin !== undefined) ordered.push(plugin)
  }
  for (const id of enabledPluginIds) visit(id)
  return ordered
}

async function trustedEntrypoint(
  target: GenerationSourceTarget,
  installationRoot?: string,
): Promise<string> {
  if (target.trustedRoots.length === 0)
    throw new PluginGenerationError(
      "untrusted-path",
      `Module ${target.moduleId} has no trusted code root.`,
    )
  let entrypoint: string
  let roots: ReadonlyArray<string>
  try {
    ;[entrypoint, ...roots] = await Promise.all([
      realpath(target.entrypoint),
      ...target.trustedRoots.map((root) => realpath(root)),
    ])
  } catch (cause) {
    throw new PluginGenerationError(
      "untrusted-path",
      `Could not resolve trusted paths for module ${target.moduleId}.`,
      { cause },
    )
  }
  if (!roots.some((root) => isInside(root, entrypoint)))
    throw new PluginGenerationError(
      "untrusted-path",
      `Module ${target.moduleId} entrypoint is outside its trusted roots.`,
    )
  if (installationRoot !== undefined) {
    let packageRoot: string
    try {
      packageRoot = await realpath(installationRoot)
    } catch (cause) {
      throw new PluginGenerationError(
        "untrusted-path",
        `Could not resolve installation root for module ${target.moduleId}.`,
        { cause },
      )
    }
    if (!isInside(packageRoot, entrypoint))
      throw new PluginGenerationError(
        "untrusted-path",
        `Module ${target.moduleId} entrypoint does not belong to its approved installation.`,
      )
  }
  return entrypoint
}

function defaultBuild(options: GenerationBuildOptions): Promise<BuildResult> {
  return Bun.build(options)
}

function descriptorRecord(
  plugin: ResolvedPlugin,
  metadata: GenerationStaticMetadata,
  artifact: string,
  digest: string,
  bytes: number,
): GenerationModuleDescriptor {
  const common = {
    pluginId: plugin.id,
    descriptorId: plugin.descriptorId,
    provenance: plugin.provenance,
    moduleId: plugin.descriptor.module.moduleId,
    ...(plugin.descriptor.module.export === undefined ?
      {}
    : { export: plugin.descriptor.module.export }),
    artifact,
    sha256: digest,
    bytes,
    metadata,
  }
  if (plugin.provenance === "built-in") return Object.freeze(common)
  return Object.freeze({
    ...common,
    installationId: plugin.installationId,
    package: Object.freeze({
      name: plugin.installation.package.name,
      ...(plugin.installation.package.version === undefined ?
        {}
      : { version: plugin.installation.package.version }),
    }),
  })
}

function inventoryIdentity(inventory: ResolvedPluginInventory): unknown {
  return inventory.plugins.map((plugin) => ({
    id: plugin.id,
    descriptorId: plugin.descriptorId,
    descriptor: plugin.descriptor,
    ...(plugin.provenance === "external" ?
      {
        installationId: plugin.installationId,
        package: plugin.installation.package,
      }
    : {}),
  }))
}

async function makeReadOnly(directory: string): Promise<void> {
  if (process.platform === "win32") return
  const entries = await readdir(directory, { withFileTypes: true })
  for (const entry of entries) {
    const candidate = path.join(directory, entry.name)
    await (entry.isDirectory() ?
      makeReadOnly(candidate)
    : chmod(candidate, 0o400))
  }
}

function wrapperSource(
  entrypoint: string,
  descriptor: PluginDescriptor,
): string {
  const specifier = JSON.stringify(entrypoint)
  const exportName = descriptor.module.export
  if (exportName === undefined) return `export * from ${specifier}\n`
  if (!EXPORT_PATTERN.test(exportName))
    throw new PluginGenerationError(
      "missing-export",
      `Descriptor ${descriptor.id} has an invalid ESM export name ${JSON.stringify(exportName)}.`,
    )
  return `export { ${exportName} } from ${specifier}\n`
}

async function buildOne(
  plugin: ResolvedPlugin,
  target: GenerationSourceTarget,
  staging: string,
  index: number,
  build: GenerationBuildFunction,
): Promise<GenerationModuleDescriptor> {
  const entrypoint = await trustedEntrypoint(
    target,
    plugin.provenance === "external" ?
      plugin.installation.package.location
    : undefined,
  )
  const moduleDirectory = path.join(staging, "modules", String(index))
  await mkdir(moduleDirectory, { recursive: true })
  const wrapper = path.join(staging, `entry-${index}.mjs`)
  await writeFile(wrapper, wrapperSource(entrypoint, plugin.descriptor), "utf8")
  let result: BuildResult
  try {
    result = await build({
      entrypoints: [wrapper],
      outdir: moduleDirectory,
      target: "bun",
      format: "esm",
      packages: "bundle",
      splitting: false,
      sourcemap: "none",
      naming: "plugin.js",
      metafile: true,
    })
  } catch (cause) {
    throw new PluginGenerationError(
      "missing-export",
      `Could not bundle plugin ${plugin.id}; its declared export or transitive code is invalid.`,
      { pluginId: plugin.id, cause },
    )
  }
  const entries = result.outputs.filter(
    (output) => output.kind === "entry-point",
  )
  const declaredExport = plugin.descriptor.module.export
  const bundledExports = new Set(
    Object.values(result.metafile?.outputs ?? {}).flatMap(
      (output) => output.exports,
    ),
  )
  const requiredExports =
    declaredExport === undefined ?
      ["name", "manifest", "inject", "Config", "apply"]
    : [declaredExport]
  const unresolvedImports = Object.values(
    result.metafile?.outputs ?? {},
  ).flatMap((output) => output.imports)
  const authorizedRoots = await Promise.all([
    ...target.trustedRoots.map((root) => realpath(root)),
    ...(plugin.provenance === "external" ?
      [realpath(plugin.installation.package.location)]
    : []),
  ])
  const wrapperPath = await realpath(wrapper)
  for (const input of Object.keys(result.metafile?.inputs ?? {})) {
    const inputPath = await realpath(path.resolve(input))
    if (
      inputPath !== wrapperPath
      && !authorizedRoots.some((root) => isInside(root, inputPath))
    )
      throw new PluginGenerationError(
        "untrusted-path",
        `Plugin ${plugin.id} bundled transitive input outside its authorized roots.`,
        { pluginId: plugin.id },
      )
  }
  if (
    !result.success
    || entries.length !== 1
    || unresolvedImports.length > 0
    || requiredExports.some((exportName) => !bundledExports.has(exportName))
  ) {
    const detail = result.logs.map(String).filter(Boolean).join("\n")
    throw new PluginGenerationError(
      "missing-export",
      detail
        || `Could not build exactly one module artifact for plugin ${plugin.id}.`,
      { pluginId: plugin.id },
    )
  }
  const relative = path
    .relative(staging, entries[0].path)
    .split(path.sep)
    .join("/")
  if (relative.startsWith("../") || path.isAbsolute(relative))
    throw new PluginGenerationError(
      "untrusted-path",
      `Builder placed plugin ${plugin.id} outside the generation directory.`,
      { pluginId: plugin.id },
    )
  const bytes = new Uint8Array(await readFile(entries[0].path))
  return descriptorRecord(
    plugin,
    staticMetadata(plugin, target),
    relative,
    await sha256(bytes),
    bytes.byteLength,
  )
}

/**
 * Build one immutable directory for the complete resolved inventory. Nothing is
 * imported into this process; the selected runner later imports only this
 * verified generation.
 */
export async function preparePluginGeneration(
  options: PreparePluginGenerationOptions,
): Promise<PreparedPluginGeneration> {
  if (
    Object.values(options.build).some(
      (value) => typeof value !== "string" || value.length === 0,
    )
  )
    throw new PluginGenerationError(
      "invalid-manifest",
      "Build identity is incomplete.",
    )
  const targetMap = new Map(
    options.targets.map((target) => [target.moduleId, target]),
  )
  if (targetMap.size !== options.targets.length)
    throw new PluginGenerationError(
      "invalid-manifest",
      "Module targets must be unique.",
    )
  const orderedEnabled = dependencyOrder(
    options.inventory,
    options.enabledPluginIds,
    options.hostServices,
    targetMap,
  )
  for (const plugin of options.inventory.plugins)
    assertPluginCompatibility(plugin, options.build)
  await mkdir(options.artifactRoot, { recursive: true })
  const staging = await mkdtemp(path.join(options.artifactRoot, ".staging-"))
  try {
    const build = options.buildModule ?? defaultBuild
    const enabledRank = new Map(
      orderedEnabled.map((plugin, index) => [plugin.id, index]),
    )
    const plugins = [...options.inventory.plugins].sort((left, right) => {
      const leftRank = enabledRank.get(left.id) ?? Number.MAX_SAFE_INTEGER
      const rightRank = enabledRank.get(right.id) ?? Number.MAX_SAFE_INTEGER
      return leftRank - rightRank || left.id.localeCompare(right.id)
    })
    const modules: Array<GenerationModuleDescriptor> = []
    for (const [index, plugin] of plugins.entries()) {
      const target = targetMap.get(plugin.descriptor.module.moduleId)
      if (target === undefined)
        throw new PluginGenerationError(
          "untrusted-path",
          `No trusted source target exists for plugin ${plugin.id}.`,
          { pluginId: plugin.id },
        )
      modules.push(await buildOne(plugin, target, staging, index, build))
    }
    const inventoryDigest = await sha256(
      canonical(inventoryIdentity(options.inventory)),
    )
    const identity = {
      $schema: PLUGIN_GENERATION_SCHEMA,
      build: options.build,
      inventoryDigest,
      modules,
    }
    const generationId = await sha256(canonical(identity))
    const manifest: PluginGenerationManifest = Object.freeze({
      ...identity,
      generationId,
      modules: Object.freeze(modules),
    })
    const manifestText = `${canonical(manifest)}\n`
    const manifestSha256 = await sha256(manifestText)
    const manifestPath = path.join(staging, "manifest.json")
    await writeFile(manifestPath, manifestText, {
      encoding: "utf8",
      mode: 0o600,
    })
    for (const name of (await readdir(staging)).filter((name) =>
      name.startsWith("entry-"),
    ))
      await rm(path.join(staging, name))
    const directory = path.join(options.artifactRoot, generationId)
    try {
      await rename(staging, directory)
      await makeReadOnly(directory)
    } catch (error) {
      if (
        !["EEXIST", "ENOTEMPTY"].includes(
          (error as NodeJS.ErrnoException).code ?? "",
        )
      )
        throw error
      await rm(staging, { recursive: true, force: true })
    }
    const verified = await verifyPluginGeneration({
      directory,
      trustedRoot: options.artifactRoot,
      expected: options.build,
      expectedManifestSha256: manifestSha256,
    })
    return verified
  } catch (error) {
    await rm(staging, { recursive: true, force: true }).catch(() => undefined)
    throw error
  }
}

function generationError(
  code: PluginGenerationErrorCode,
  message: string,
): never {
  throw new PluginGenerationError(code, message)
}

function exactKeys(value: object, allowed: ReadonlyArray<string>): boolean {
  const keys = Object.keys(value)
  return (
    keys.length === allowed.length && keys.every((key) => allowed.includes(key))
  )
}

function stringList(value: unknown): value is ReadonlyArray<string> {
  return Array.isArray(value) && value.every((item) => typeof item === "string")
}

function parseManifest(value: unknown): PluginGenerationManifest {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    return generationError(
      "invalid-manifest",
      "Generation manifest must be an object.",
    )
  const manifest = value as Partial<PluginGenerationManifest>
  if (
    !exactKeys(value, [
      "$schema",
      "generationId",
      "build",
      "inventoryDigest",
      "modules",
    ])
    || manifest.$schema !== PLUGIN_GENERATION_SCHEMA
    || typeof manifest.generationId !== "string"
    || !SHA256_PATTERN.test(manifest.generationId)
    || typeof manifest.inventoryDigest !== "string"
    || !SHA256_PATTERN.test(manifest.inventoryDigest)
    || manifest.build === undefined
    || typeof manifest.build !== "object"
    || !exactKeys(manifest.build, [
      "id",
      "maximal",
      "protocol",
      "pluginApi",
      "runtime",
      "platform",
      "architecture",
    ])
    || Object.values(manifest.build).some(
      (item) => typeof item !== "string" || item.length === 0,
    )
    || !Array.isArray(manifest.modules)
  )
    return generationError(
      "invalid-manifest",
      "Generation manifest header is invalid.",
    )
  const modules: ReadonlyArray<unknown> = manifest.modules
  for (const moduleValue of modules) {
    if (
      moduleValue === null
      || typeof moduleValue !== "object"
      || Array.isArray(moduleValue)
    )
      return generationError(
        "invalid-manifest",
        "Generation module descriptor is invalid.",
      )
    const module = moduleValue
    const descriptor = module as Partial<GenerationModuleDescriptor>
    const external = descriptor.provenance === "external"
    const packageValue = (module as Record<string, unknown>).package
    const packageRecord =
      (
        packageValue !== null
        && typeof packageValue === "object"
        && !Array.isArray(packageValue)
      ) ?
        (packageValue as Record<string, unknown>)
      : undefined
    const allowed = [
      "pluginId",
      "descriptorId",
      "provenance",
      "moduleId",
      ...(descriptor.export === undefined ? [] : ["export"]),
      "artifact",
      "sha256",
      "bytes",
      ...(external ? ["installationId", "package"] : []),
      "metadata",
    ]
    const metadataValue = (module as Record<string, unknown>).metadata
    const metadata =
      metadataValue !== null && typeof metadataValue === "object" ?
        (metadataValue as Record<string, unknown>)
      : undefined
    if (
      !exactKeys(module, allowed)
      || (descriptor.provenance !== "built-in" && !external)
      || (descriptor.export !== undefined
        && typeof descriptor.export !== "string")
      || metadata === undefined
      || !exactKeys(metadata, ["name", "inject", "provides"])
      || typeof metadata.name !== "string"
      || !stringList(metadata.inject)
      || !stringList(metadata.provides)
      || (external
        && (typeof descriptor.installationId !== "string"
          || packageRecord === undefined
          || typeof packageRecord.name !== "string"
          || !exactKeys(
            packageRecord,
            packageRecord.version === undefined ?
              ["name"]
            : ["name", "version"],
          )
          || (packageRecord.version !== undefined
            && typeof packageRecord.version !== "string")))
    )
      return generationError(
        "invalid-manifest",
        "Generation module descriptor is invalid.",
      )
  }
  return manifest as PluginGenerationManifest
}

/** Verify identity, exact compatibility, containment, sizes and every artifact hash. */
export async function verifyPluginGeneration(options: {
  readonly directory: string
  readonly trustedRoot?: string
  readonly expected: GenerationCompatibility
  readonly expectedManifestSha256?: string
}): Promise<PreparedPluginGeneration> {
  const directory = await realpath(options.directory).catch(
    (cause: unknown) => {
      throw new PluginGenerationError(
        "generation-not-found",
        "Generation does not exist.",
        { cause },
      )
    },
  )
  if (options.trustedRoot !== undefined) {
    const trustedRoot = await realpath(options.trustedRoot)
    if (!isInside(trustedRoot, directory))
      generationError(
        "untrusted-path",
        "Generation directory escapes its trusted root.",
      )
  }
  const manifestPath = await realpath(path.join(directory, "manifest.json"))
  if (!isInside(directory, manifestPath))
    generationError(
      "untrusted-path",
      "Generation manifest escapes its directory.",
    )
  const manifestBytes = new Uint8Array(await readFile(manifestPath))
  const manifestSha256 = await sha256(manifestBytes)
  if (
    options.expectedManifestSha256 !== undefined
    && options.expectedManifestSha256 !== manifestSha256
  )
    generationError(
      "hash-mismatch",
      "Generation manifest hash does not match the committed hash.",
    )
  let raw: unknown
  try {
    raw = JSON.parse(new TextDecoder().decode(manifestBytes))
  } catch (cause) {
    throw new PluginGenerationError(
      "invalid-manifest",
      "Generation manifest is invalid JSON.",
      { cause },
    )
  }
  const manifest = parseManifest(raw)
  const identity = {
    $schema: manifest.$schema,
    build: manifest.build,
    inventoryDigest: manifest.inventoryDigest,
    modules: manifest.modules,
  }
  if ((await sha256(canonical(identity))) !== manifest.generationId)
    generationError(
      "artifact-changed",
      "Generation immutable identity does not match its manifest.",
    )
  if (path.basename(directory) !== manifest.generationId)
    generationError(
      "artifact-changed",
      "Generation directory does not match its immutable identity.",
    )
  for (const field of [
    "maximal",
    "protocol",
    "pluginApi",
    "runtime",
    "platform",
    "architecture",
  ] as const)
    if (manifest.build[field] !== options.expected[field])
      throw new PluginGenerationError(
        "incompatible-generation",
        `Generation ${field} ${JSON.stringify(manifest.build[field])} does not match ${JSON.stringify(options.expected[field])}.`,
        { generationId: manifest.generationId },
      )
  const seenPlugins = new Set<string>()
  const seenArtifacts = new Set<string>()
  for (const module of manifest.modules) {
    if (
      typeof module.pluginId !== "string"
      || typeof module.descriptorId !== "string"
      || typeof module.moduleId !== "string"
      || typeof module.artifact !== "string"
      || !SHA256_PATTERN.test(module.sha256)
      || !Number.isSafeInteger(module.bytes)
      || module.bytes < 0
      || module.metadata.name !== module.pluginId
      || JSON.stringify(module.metadata.inject)
        !== JSON.stringify(
          canonicalServiceList(
            module.metadata.inject,
            `Plugin ${module.pluginId} inject metadata`,
          ),
        )
      || JSON.stringify(module.metadata.provides)
        !== JSON.stringify(
          canonicalServiceList(
            module.metadata.provides,
            `Plugin ${module.pluginId} provides metadata`,
          ),
        )
      || seenPlugins.has(module.pluginId)
      || seenArtifacts.has(module.artifact)
    )
      generationError(
        "invalid-manifest",
        "Generation module descriptor is invalid or duplicated.",
      )
    seenPlugins.add(module.pluginId)
    seenArtifacts.add(module.artifact)
    if (
      !module.artifact.split("/").every((part) => SAFE_FILE_PATTERN.test(part))
    )
      generationError(
        "untrusted-path",
        `Generation artifact path ${module.artifact} is unsafe.`,
      )
    const artifact = await realpath(path.join(directory, module.artifact))
    if (!isInside(directory, artifact))
      generationError(
        "untrusted-path",
        `Generation artifact ${module.artifact} escapes its directory.`,
      )
    const bytes = new Uint8Array(await readFile(artifact))
    if (
      bytes.byteLength !== module.bytes
      || (await sha256(bytes)) !== module.sha256
    )
      generationError(
        "hash-mismatch",
        `Generation artifact ${module.artifact} failed hash verification.`,
      )
  }
  return Object.freeze({ directory, manifestPath, manifest, manifestSha256 })
}

function selectionIdentity(
  token: Omit<PluginGenerationSelectionToken, "seal">,
): unknown {
  return {
    $schema: token.$schema,
    reverify: token.reverify,
    directory: token.directory,
    generationId: token.generationId,
    manifestSha256: token.manifestSha256,
    artifacts: token.artifacts,
  }
}

/** Seal a verified generation selection for transport to the future runner. */
export async function createPluginGenerationSelectionToken(
  generation: PreparedPluginGeneration,
): Promise<PluginGenerationSelectionToken> {
  const identity = {
    $schema: PLUGIN_GENERATION_SELECTION_SCHEMA,
    reverify: RUNNER_REVERIFY_CONTRACT,
    directory: path.resolve(generation.directory),
    generationId: generation.manifest.generationId,
    manifestSha256: generation.manifestSha256,
    artifacts: Object.freeze(
      generation.manifest.modules.map(({ artifact, sha256: digest, bytes }) =>
        Object.freeze({ artifact, sha256: digest, bytes }),
      ),
    ),
  } as const
  return Object.freeze({
    ...identity,
    seal: await sha256(canonical(selectionIdentity(identity))),
  })
}

function actualModuleMetadata(
  namespace: unknown,
  descriptor: GenerationModuleDescriptor,
): GenerationStaticMetadata {
  if (namespace === null || typeof namespace !== "object")
    throw new PluginGenerationError(
      "module-metadata-mismatch",
      `Plugin ${descriptor.pluginId} artifact is not a module namespace.`,
      { pluginId: descriptor.pluginId },
    )
  const exports = namespace as Record<string, unknown>
  const selected =
    descriptor.export === undefined ? exports : exports[descriptor.export]
  if (selected === null || typeof selected !== "object")
    throw new PluginGenerationError(
      "module-metadata-mismatch",
      `Plugin ${descriptor.pluginId} exported module is not an object.`,
      { pluginId: descriptor.pluginId },
    )
  const module = selected as Record<string, unknown>
  const inject = module.inject
  let injected: unknown
  if (Array.isArray(inject)) injected = inject
  else if (inject !== null && typeof inject === "object")
    injected = Object.keys(inject)
  const provides = module.provides === undefined ? [] : module.provides
  if (
    typeof module.name !== "string"
    || injected === undefined
    || !Array.isArray(provides)
  )
    throw new PluginGenerationError(
      "module-metadata-mismatch",
      `Plugin ${descriptor.pluginId} does not export static name/inject/provides-compatible declarations.`,
      { pluginId: descriptor.pluginId },
    )
  return Object.freeze({
    name: module.name,
    inject: canonicalServiceList(
      injected as ReadonlyArray<string>,
      `Plugin ${descriptor.pluginId} runtime inject`,
    ),
    provides: canonicalServiceList(
      provides as ReadonlyArray<string>,
      `Plugin ${descriptor.pluginId} runtime provides`,
    ),
  })
}

function sameMetadata(
  left: GenerationStaticMetadata,
  right: GenerationStaticMetadata,
): boolean {
  return canonical(left) === canonical(right)
}

export type GenerationModuleImporter = (artifact: string) => Promise<unknown>

/**
 * Required child-side half of verify→spawn closure. Hashes are checked again,
 * then each imported module's declarations are compared with build-time static
 * metadata. Phase 3 remains responsible for consuming this API before import.
 */
export async function reverifyGenerationSelectionForRunner(options: {
  readonly token: PluginGenerationSelectionToken
  readonly expected: GenerationCompatibility
  readonly trustedRoot?: string
  readonly importModule?: GenerationModuleImporter
}): Promise<PreparedPluginGeneration> {
  const { token } = options
  const receivedSchema: unknown = token.$schema
  const receivedContract: unknown = token.reverify
  if (
    receivedSchema !== PLUGIN_GENERATION_SELECTION_SCHEMA
    || receivedContract !== RUNNER_REVERIFY_CONTRACT
    || !SHA256_PATTERN.test(token.generationId)
    || !SHA256_PATTERN.test(token.manifestSha256)
    || !SHA256_PATTERN.test(token.seal)
    || !Array.isArray(token.artifacts)
    || (await sha256(
      canonical(
        selectionIdentity({
          $schema: token.$schema,
          reverify: token.reverify,
          directory: token.directory,
          generationId: token.generationId,
          manifestSha256: token.manifestSha256,
          artifacts: token.artifacts,
        }),
      ),
    )) !== token.seal
  )
    throw new PluginGenerationError(
      "invalid-selection",
      "Plugin generation selection token is invalid.",
    )
  const verified = await verifyPluginGeneration({
    directory: token.directory,
    trustedRoot: options.trustedRoot,
    expected: options.expected,
    expectedManifestSha256: token.manifestSha256,
  })
  const expectedArtifacts = verified.manifest.modules.map(
    ({ artifact, sha256: digest, bytes }) => ({
      artifact,
      sha256: digest,
      bytes,
    }),
  )
  if (
    verified.manifest.generationId !== token.generationId
    || canonical(expectedArtifacts) !== canonical(token.artifacts)
  )
    throw new PluginGenerationError(
      "invalid-selection",
      "Plugin generation no longer matches its sealed selection token.",
      { generationId: token.generationId },
    )
  const importModule =
    options.importModule
    ?? ((artifact: string) =>
      import(
        `${pathToFileURL(artifact).href}?generation=${token.generationId}`
      ))
  for (const descriptor of verified.manifest.modules) {
    const artifact = path.join(verified.directory, descriptor.artifact)
    let namespace: unknown
    try {
      namespace = await importModule(artifact)
    } catch (cause) {
      throw new PluginGenerationError(
        "missing-export",
        `Runner could not import plugin ${descriptor.pluginId}.`,
        { pluginId: descriptor.pluginId, cause },
      )
    }
    const actual = actualModuleMetadata(namespace, descriptor)
    if (!sameMetadata(actual, descriptor.metadata))
      throw new PluginGenerationError(
        "module-metadata-mismatch",
        `Plugin ${descriptor.pluginId} runtime declarations do not match its static generation metadata.`,
        { pluginId: descriptor.pluginId },
      )
  }
  return verified
}

async function atomicWrite(file: string, text: string): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true })
  const temporary = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`
  const handle = await open(temporary, "wx", 0o600)
  try {
    await handle.writeFile(text, "utf8")
    await handle.sync()
  } finally {
    await handle.close()
  }
  await rename(temporary, file)
  try {
    const directory = await open(path.dirname(file), "r")
    try {
      await directory.sync()
    } finally {
      await directory.close()
    }
  } catch {
    // Windows does not permit opening directories. The file fsync + atomic
    // replace is still the strongest portable contract available here.
  }
}

function parseCommit(value: unknown): CommittedGenerationRecord {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new PluginGenerationError(
      "commit-corrupt",
      "Generation commit record is malformed.",
    )
  const record = value as Partial<CommittedGenerationRecord>
  if (
    record.$schema !== PLUGIN_GENERATION_COMMIT_SCHEMA
    || !SHA256_PATTERN.test(record.committedGenerationId ?? "")
    || !SHA256_PATTERN.test(record.committedManifestSha256 ?? "")
    || !SHA256_PATTERN.test(record.lastKnownGoodGenerationId ?? "")
    || !SHA256_PATTERN.test(record.lastKnownGoodManifestSha256 ?? "")
  )
    throw new PluginGenerationError(
      "commit-corrupt",
      "Generation commit record is invalid.",
    )
  return record as CommittedGenerationRecord
}

async function readCommit(
  file: string,
): Promise<CommittedGenerationRecord | undefined> {
  let text: string
  try {
    text = await readFile(file, "utf8")
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined
    throw error
  }
  try {
    return parseCommit(JSON.parse(text))
  } catch (cause) {
    if (cause instanceof PluginGenerationError) throw cause
    throw new PluginGenerationError(
      "commit-corrupt",
      "Generation commit record is invalid JSON.",
      { cause },
    )
  }
}

export interface GenerationRepositoryOptions {
  readonly artifactRoot: string
  readonly commitFile: string
  readonly compatibility: GenerationCompatibility
  readonly removeDirectory?: (directory: string) => Promise<void>
  readonly sleep?: (milliseconds: number) => Promise<void>
}

/** Stable-parent generation authority. Runner code must receive only verified paths. */
export class PluginGenerationRepository {
  readonly #options: GenerationRepositoryOptions
  readonly #references = new Map<string, number>()

  constructor(options: GenerationRepositoryOptions) {
    this.#options = options
  }

  async committed(): Promise<PreparedPluginGeneration | undefined> {
    const record = await readCommit(this.#options.commitFile)
    if (record === undefined) return undefined
    return verifyPluginGeneration({
      directory: path.join(
        this.#options.artifactRoot,
        record.committedGenerationId,
      ),
      trustedRoot: this.#options.artifactRoot,
      expected: this.#options.compatibility,
      expectedManifestSha256: record.committedManifestSha256,
    })
  }

  async selectCommitted(): Promise<PluginGenerationSelectionToken | undefined> {
    const generation = await this.committed()
    return generation === undefined ? undefined : (
        createPluginGenerationSelectionToken(generation)
      )
  }

  async lastKnownGood(): Promise<PreparedPluginGeneration | undefined> {
    const record = await readCommit(this.#options.commitFile)
    if (record === undefined) return undefined
    return verifyPluginGeneration({
      directory: path.join(
        this.#options.artifactRoot,
        record.lastKnownGoodGenerationId,
      ),
      trustedRoot: this.#options.artifactRoot,
      expected: this.#options.compatibility,
      expectedManifestSha256: record.lastKnownGoodManifestSha256,
    })
  }

  /** Persist selection atomically. Only the stable parent should call this. */
  async commit(generation: PreparedPluginGeneration): Promise<void> {
    const verified = await verifyPluginGeneration({
      directory: generation.directory,
      trustedRoot: this.#options.artifactRoot,
      expected: this.#options.compatibility,
      expectedManifestSha256: generation.manifestSha256,
    })
    const previous = await readCommit(this.#options.commitFile)
    const record: CommittedGenerationRecord = {
      $schema: PLUGIN_GENERATION_COMMIT_SCHEMA,
      committedGenerationId: verified.manifest.generationId,
      committedManifestSha256: verified.manifestSha256,
      lastKnownGoodGenerationId:
        previous?.committedGenerationId ?? verified.manifest.generationId,
      lastKnownGoodManifestSha256:
        previous?.committedManifestSha256 ?? verified.manifestSha256,
    }
    await atomicWrite(this.#options.commitFile, `${canonical(record)}\n`)
  }

  async retain(generationId: string): Promise<GenerationLease> {
    if (!SHA256_PATTERN.test(generationId))
      throw new PluginGenerationError(
        "generation-not-found",
        "Generation id is invalid.",
      )
    await stat(path.join(this.#options.artifactRoot, generationId))
    this.#references.set(
      generationId,
      (this.#references.get(generationId) ?? 0) + 1,
    )
    let released = false
    return Object.freeze({
      generationId,
      release: () => {
        if (released) return
        released = true
        const remaining = (this.#references.get(generationId) ?? 1) - 1
        if (remaining === 0) this.#references.delete(generationId)
        else this.#references.set(generationId, remaining)
      },
    })
  }

  async #removeWithRetry(
    directory: string,
    retries: number,
    delayMs: number,
  ): Promise<void> {
    const remove =
      this.#options.removeDirectory
      ?? ((target: string) => rm(target, { recursive: true, force: true }))
    const sleep =
      this.#options.sleep
      ?? ((milliseconds: number) =>
        new Promise<void>((resolve) => setTimeout(resolve, milliseconds)))
    for (let attempt = 0; ; attempt++) {
      try {
        await remove(directory)
        return
      } catch (cause) {
        const code = (cause as NodeJS.ErrnoException).code
        const locked = ["EACCES", "EBUSY", "ENOTEMPTY", "EPERM"].includes(
          code ?? "",
        )
        if (!locked || attempt >= retries)
          throw new PluginGenerationError(
            "gc-failed",
            `Could not remove generation ${path.basename(directory)}.`,
            { generationId: path.basename(directory), cause },
          )
        await sleep(delayMs * 2 ** attempt)
      }
    }
  }

  /** Remove only unreferenced generations, preserving committed/LKG and newest retention. */
  async garbageCollect(
    options: {
      readonly retainNewest?: number
      readonly lockRetries?: number
      readonly retryDelayMs?: number
    } = {},
  ): Promise<GenerationGarbageCollectionResult> {
    await mkdir(this.#options.artifactRoot, { recursive: true })
    const record = await readCommit(this.#options.commitFile)
    const protectedIds = new Set(this.#references.keys())
    if (record !== undefined) {
      protectedIds.add(record.committedGenerationId)
      protectedIds.add(record.lastKnownGoodGenerationId)
    }
    const candidates: Array<{ id: string; modified: number }> = []
    for (const entry of await readdir(this.#options.artifactRoot, {
      withFileTypes: true,
    })) {
      if (!entry.isDirectory() || !SHA256_PATTERN.test(entry.name)) continue
      const info = await stat(path.join(this.#options.artifactRoot, entry.name))
      candidates.push({ id: entry.name, modified: info.mtimeMs })
    }
    candidates.sort(
      (left, right) =>
        right.modified - left.modified || left.id.localeCompare(right.id),
    )
    for (const candidate of candidates.slice(0, options.retainNewest ?? 1))
      protectedIds.add(candidate.id)
    const removed: Array<string> = []
    for (const candidate of candidates) {
      if (protectedIds.has(candidate.id)) continue
      await this.#removeWithRetry(
        path.join(this.#options.artifactRoot, candidate.id),
        options.lockRetries ?? 5,
        options.retryDelayMs ?? 25,
      )
      removed.push(candidate.id)
    }
    return Object.freeze({
      removed: Object.freeze(removed),
      retained: Object.freeze(
        candidates.map(({ id }) => id).filter((id) => !removed.includes(id)),
      ),
    })
  }
}
