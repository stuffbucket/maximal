/**
 * Composition root for the plugin system — the ONLY module in `src/` that
 * imports the cordis-backed host, loader, or plugin packages. Everything else
 * in the app talks to the cordis-free `PluginGateway` seam.
 */

import type {
  PluginGateway,
  UpstreamProvider,
} from "@stuffbucket/maximal-plugin-sdk/gateway"
import type { PluginSettingsAuthority } from "@stuffbucket/maximal-plugin-sdk/runtime"

import * as decisions from "@stuffbucket/maximal-plugin-decisions"
import * as figjam from "@stuffbucket/maximal-plugin-figjam"
import {
  createPluginHost,
  serverToolsService,
  type HostServices,
  operationsService,
  type PluginHostGateway,
  type PluginModule,
  providersService,
} from "@stuffbucket/maximal-plugin-host"
import * as images from "@stuffbucket/maximal-plugin-images"
import {
  InventoryReadFailure,
  type InventoryFileSystem,
  type InventoryOpenedFile,
  type PluginCatalog,
  PluginInventoryError,
  PLUGIN_INVENTORY_SCHEMA,
  reloadPluginInventory,
  resolvePluginInventory,
  type ResolvedPluginInventory,
} from "@stuffbucket/maximal-plugin-loader"
import * as systemone from "@stuffbucket/maximal-plugin-systemone"
import * as workiq from "@stuffbucket/maximal-plugin-workiq"
import consola from "consola"
import { createHash } from "node:crypto"
import fs from "node:fs/promises"
import path from "node:path"

import type { AppConfig } from "~/lib/config/config"

import { openUrl } from "~/lib/platform/open-url"
import { PATHS } from "~/lib/platform/paths"
import {
  hostServicesFromBroker,
  type ParentHostServiceBroker,
} from "~/lib/plugins/host-service-broker"
import { ProjectedPluginGateway } from "~/lib/plugins/projected-gateway"
import {
  type CopilotProviderDeps,
  createCopilotProvider,
} from "~/lib/plugins/providers/copilot"
import {
  createPluginStateBroker,
  type PluginStateBroker,
  type PluginStateTransaction,
} from "~/lib/plugins/state-broker"
import { currentProxyPort } from "~/lib/start/proxy-port"
import { runFile } from "~/lib/system/run-file"
import { BUILD_VERSION } from "~/lib/update/build-info"

/** The first-party plugins every Maximal build ships. */
const BUILTIN_PLUGINS: ReadonlyArray<PluginModule> = [
  workiq,
  figjam,
  decisions,
  systemone,
  images,
]
const BUILT_IN_SOURCE = Object.freeze({ type: "built-in" as const })
const OPEN_TIMEOUT_MS = 10_000

/** A host-owned catalog row. Modules can enter this table only from code. */
export interface TrustedBuiltInPlugin {
  readonly descriptorId: string
  readonly module: PluginModule
}

interface AppliedPlugin {
  readonly descriptorId: string
  readonly module: PluginModule
}

interface ComposedInventoryState {
  readonly host: PluginHostGateway
  readonly catalog: PluginCatalog
  readonly modules: ReadonlyMap<string, PluginModule>
  readonly defaultInventory: ResolvedPluginInventory
  readonly rootDirectory: string
  readonly fileSystem: InventoryFileSystem
  readonly stateBroker: PluginStateBroker
  applied: ReadonlyMap<string, AppliedPlugin>
  lastGood: ResolvedPluginInventory
  overrideActive: boolean
  queue: Promise<void>
}

const inventoryStates = new WeakMap<PluginGateway, ComposedInventoryState>()

/** Preserve the direct host's private inventory controls behind its projection. */
class ProjectedDirectHostGateway
  extends ProjectedPluginGateway
  implements PluginHostGateway
{
  readonly #host: PluginHostGateway

  constructor(host: PluginHostGateway) {
    super(host, "direct-host")
    this.#host = host
  }

  resourceLifecycle(): ReturnType<PluginHostGateway["resourceLifecycle"]> {
    return this.#host.resourceLifecycle()
  }

  // Catalog persistence is deliberately asynchronous and does not add another
  // public gateway event. Direct-host snapshot reads therefore stay live while
  // acquired generation leases continue to use the immutable projection.
  list(): ReturnType<PluginHostGateway["list"]> {
    return this.#host.list()
  }

  get(
    ...args: Parameters<PluginHostGateway["get"]>
  ): ReturnType<PluginHostGateway["get"]> {
    return this.#host.get(...args)
  }

  addPlugin(
    ...args: Parameters<PluginHostGateway["addPlugin"]>
  ): ReturnType<PluginHostGateway["addPlugin"]> {
    return this.#host.addPlugin(...args)
  }

  removePlugin(
    ...args: Parameters<PluginHostGateway["removePlugin"]>
  ): ReturnType<PluginHostGateway["removePlugin"]> {
    return this.#host.removePlugin(...args)
  }

  replacePlugin(
    ...args: Parameters<PluginHostGateway["replacePlugin"]>
  ): ReturnType<PluginHostGateway["replacePlugin"]> {
    return this.#host.replacePlugin(...args)
  }

  replaceInventory(
    ...args: Parameters<PluginHostGateway["replaceInventory"]>
  ): ReturnType<PluginHostGateway["replaceInventory"]> {
    return this.#host.replaceInventory(...args)
  }
}

/** Static facts about one trusted built-in module, taken from its own exports. */
export interface TrustedModuleMetadata {
  readonly name: string
  readonly inject: ReadonlyArray<string>
  readonly provides: ReadonlyArray<string>
}

/**
 * The parent-owned trust anchors for staging a sealed generation from a
 * configured inventory: the code-only catalog, the default inventory, the
 * inventory file reader, and each module's static metadata. No plugin code runs.
 */
export interface TrustedInventoryContext {
  readonly catalog: PluginCatalog
  readonly defaultInventory: ResolvedPluginInventory
  readonly fileSystem: InventoryFileSystem
  /** Keyed by the descriptor's module id. */
  readonly metadata: ReadonlyMap<string, TrustedModuleMetadata>
}

export function trustedInventoryContext(
  supplied?: ReadonlyArray<TrustedBuiltInPlugin>,
): TrustedInventoryContext {
  const entries =
    supplied
    ?? BUILTIN_PLUGINS.map((module) => ({
      descriptorId: module.name,
      module,
    }))
  const trusted = trustedCatalog(
    entries.map((entry) => entry.module),
    entries,
  )
  return Object.freeze({
    catalog: trusted.catalog,
    defaultInventory: trusted.inventory,
    fileSystem: createInventoryFileSystem(),
    metadata: new Map(
      entries.map((entry) => [
        entry.module.name,
        {
          name: entry.module.name,
          inject:
            Array.isArray(entry.module.inject) ?
              [...(entry.module.inject as ReadonlyArray<string>)]
            : Object.keys(entry.module.inject),
          provides: [...(entry.module.provides ?? [])],
        },
      ]),
    ),
  })
}

/** Where `ctx.storage` keeps each plugin's private directory. */
export function pluginStorageRoot(appDir: string = PATHS.APP_DIR): string {
  return path.join(appDir, "plugins")
}

/** The URL the system launcher gets: parsed and re-serialized (`href`), and
 * only if it is http(s). */
export function normalizeExternalUrl(rawUrl: string): string {
  const parsed = new URL(rawUrl)
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:")
    throw new Error("Only http(s) URLs can be opened.")
  return parsed.href
}

async function openExternal(rawUrl: string): Promise<void> {
  const url = normalizeExternalUrl(rawUrl)
  if (process.platform === "win32") {
    const result = await runFile(
      "rundll32",
      ["url.dll,FileProtocolHandler", url],
      { timeoutMs: OPEN_TIMEOUT_MS },
    )
    if (result.notFound || result.code !== 0)
      throw new Error("Could not open the browser.")
    return
  }
  const result = openUrl(url)
  if (!result.ok)
    throw new Error(
      result.reason === "headless" ?
        "There is no desktop session to open a browser in."
      : "Could not open the browser.",
    )
}

export function createParentHostServiceBroker(): ParentHostServiceBroker {
  let revision = 0
  let lastPort = currentProxyPort()
  return {
    snapshot() {
      const port = currentProxyPort()
      if (port !== lastPort) {
        lastPort = port
        revision += 1
      }
      return Object.freeze({
        revision,
        appVersion: BUILD_VERSION,
        maximalPort: port,
      })
    },
    openExternal,
    logger: {
      debug: (message, ...args) => consola.debug(message, ...args),
      info: (message, ...args) => consola.info(message, ...args),
      warn: (message, ...args) => consola.warn(message, ...args),
      error: (message, ...args) => consola.error(message, ...args),
    },
  }
}

function hostServices(): HostServices {
  return hostServicesFromBroker(createParentHostServiceBroker())
}

function readFailure(error: unknown, file: string): InventoryReadFailure {
  const code = (error as NodeJS.ErrnoException | undefined)?.code
  if (code === "ENOENT" || code === "ENOTDIR")
    return new InventoryReadFailure("not-found", `${file} does not exist.`, {
      cause: error,
    })
  if (code === "EACCES" || code === "EPERM")
    return new InventoryReadFailure(
      "permission-denied",
      `${file} cannot be read.`,
      { cause: error },
    )
  return new InventoryReadFailure("io", `${file} could not be read.`, {
    cause: error,
  })
}

function inside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate)
  return (
    relative === ""
    || (!path.isAbsolute(relative)
      && relative !== ".."
      && !relative.startsWith(`..${path.sep}`))
  )
}

async function openInventoryPath(
  rootDirectory: string,
  candidate: string,
  maxBytes: number,
): Promise<InventoryOpenedFile> {
  let root: string
  let canonicalId: string
  try {
    root = await fs.realpath(rootDirectory)
    canonicalId = await fs.realpath(candidate)
  } catch (error) {
    throw readFailure(error, candidate)
  }
  if (!inside(root, canonicalId))
    throw new InventoryReadFailure(
      "permission-denied",
      `${candidate} is outside the inventory root.`,
    )
  let handle: fs.FileHandle | undefined
  try {
    handle = await fs.open(canonicalId, "r")
    const stat = await handle.stat()
    if (!stat.isFile())
      throw new InventoryReadFailure("io", `${canonicalId} is not a file.`)
    if (stat.size > maxBytes)
      throw new InventoryReadFailure(
        "too-large",
        `${canonicalId} exceeds ${maxBytes} bytes.`,
      )
    const text = await handle.readFile({ encoding: "utf8" })
    if (Buffer.byteLength(text, "utf8") > maxBytes)
      throw new InventoryReadFailure(
        "too-large",
        `${canonicalId} exceeds ${maxBytes} bytes.`,
      )
    return { canonicalId, text }
  } catch (error) {
    if (error instanceof InventoryReadFailure) throw error
    throw readFailure(error, canonicalId)
  } finally {
    await handle?.close()
  }
}

function createInventoryFileSystem(): InventoryFileSystem {
  const fileSystem: InventoryFileSystem = {
    openEntry: ({ rootDirectory, entry, maxBytes }) =>
      openInventoryPath(
        rootDirectory,
        path.resolve(rootDirectory, entry),
        maxBytes,
      ),
    openInclude: ({ rootDirectory, parentCanonicalId, reference, maxBytes }) =>
      openInventoryPath(
        rootDirectory,
        path.resolve(path.dirname(parentCanonicalId), reference),
        maxBytes,
      ),
  }
  return Object.freeze(fileSystem)
}

function trustedCatalog(
  plugins: ReadonlyArray<PluginModule>,
  supplied?: ReadonlyArray<TrustedBuiltInPlugin>,
): {
  catalog: PluginCatalog
  modules: ReadonlyMap<string, PluginModule>
  defaults: ReadonlyMap<string, AppliedPlugin>
  inventory: ResolvedPluginInventory
} {
  const entries =
    supplied
    ?? plugins.map((module) => ({
      descriptorId: module.name,
      module,
    }))
  const modules = new Map(
    entries.map((entry) => [entry.descriptorId, entry.module] as const),
  )
  const catalog: PluginCatalog = {
    descriptors: entries.map((entry) => ({
      id: entry.descriptorId,
      provenance: "built-in" as const,
      module: { moduleId: entry.module.name },
    })),
    installations: [],
  }
  const defaults = new Map<string, AppliedPlugin>()
  for (const module of plugins) {
    const entry = entries.find((candidate) => candidate.module === module)
    if (!entry)
      throw new PluginInventoryError(
        "missing-descriptor",
        `The trusted catalog has no descriptor for built-in plugin ${module.name}.`,
        { member: module.name },
      )
    defaults.set(module.name, {
      descriptorId: entry.descriptorId,
      module,
    })
  }
  const definitions = [...defaults].map(([id, value]) => ({
    id,
    descriptorId: value.descriptorId,
  }))
  const inventory = resolvePluginInventory({
    entry: "host-default",
    documents: [
      {
        source: "host-default",
        includeSources: [],
        document: {
          $schema: PLUGIN_INVENTORY_SCHEMA,
          plugins: definitions,
          members: definitions.map(({ id }) => ({ plugin: id })),
        },
      },
    ],
    catalog,
  })
  return { catalog, modules, defaults, inventory }
}

export interface ComposeRunnerPluginsOptions {
  readonly plugins: ReadonlyArray<PluginModule>
  readonly settingsAuthority: PluginSettingsAuthority
  readonly providers: ReadonlyArray<UpstreamProvider>
  readonly host: HostServices
  readonly storageRoot?: string
}

export interface RunnerPluginGateway extends PluginGateway {
  resourceLifecycle(): ReturnType<PluginHostGateway["resourceLifecycle"]>
}

/** Child-only composition with every parent-owned capability projected by RPC. */
export function composeRunnerPluginGateway(
  options: ComposeRunnerPluginsOptions,
): RunnerPluginGateway {
  const host = createPluginHost({
    plugins: options.plugins,
    services: {
      host: options.host,
      storageRoot: options.storageRoot ?? pluginStorageRoot(),
      settingsAuthority: options.settingsAuthority,
      extra: [
        operationsService,
        providersService(options.providers),
        serverToolsService,
      ],
    },
    resourceActivation: { mode: "candidate" },
  })
  const projected = new ProjectedPluginGateway(host, "runner")
  return Object.assign(projected, {
    resourceLifecycle: () => host.resourceLifecycle(),
  })
}

export interface ComposePluginsOptions {
  /** The initial trusted plugin set; built-ins by default. */
  plugins?: ReadonlyArray<PluginModule>
  /** Defaults to `<app dir>/plugins`. */
  storageRoot?: string
  /** Replace individual host services (tests record `openExternal`). */
  host?: Partial<HostServices>
  /** Replace parts of the Copilot upstream provider. */
  copilot?: CopilotProviderDeps
  /** Parent-owned reserved settings authority (focused tests). */
  stateBroker?: PluginStateBroker
  /** Trusted code-only inventory seams used by focused composition tests. */
  inventory?: {
    rootDirectory?: string
    fileSystem?: InventoryFileSystem
    catalog?: ReadonlyArray<TrustedBuiltInPlugin>
  }
}

/** Create the plugin gateway. Every plugin starts disabled. */
export function composePluginGateway(
  options: ComposePluginsOptions = {},
): PluginHostGateway {
  const plugins = options.plugins ?? BUILTIN_PLUGINS
  const trusted = trustedCatalog(plugins, options.inventory?.catalog)
  const storageRoot = options.storageRoot ?? pluginStorageRoot()
  const stateBroker =
    options.stateBroker ?? createPluginStateBroker(storageRoot)
  const host = createPluginHost({
    plugins,
    services: {
      host: { ...hostServices(), ...options.host },
      storageRoot,
      settingsAuthority: stateBroker,
      extra: [
        operationsService,
        providersService([
          createCopilotProvider({
            ...options.copilot,
            commitControlMutation: async (digest) => {
              await stateBroker.advanceEpoch("provider:copilot", digest)
              await options.copilot?.commitControlMutation?.(digest)
            },
          }),
        ]),
        serverToolsService,
      ],
    },
  })
  const gateway = new ProjectedDirectHostGateway(host)
  inventoryStates.set(gateway, {
    host,
    catalog: trusted.catalog,
    modules: trusted.modules,
    defaultInventory: trusted.inventory,
    rootDirectory: options.inventory?.rootDirectory ?? PATHS.APP_DIR,
    fileSystem: options.inventory?.fileSystem ?? createInventoryFileSystem(),
    stateBroker,
    applied: trusted.defaults,
    lastGood: trusted.inventory,
    overrideActive: false,
    queue: Promise.resolve(),
  })
  return gateway
}

function desiredPlugins(
  state: ComposedInventoryState,
  inventory: ResolvedPluginInventory,
): ReadonlyMap<string, AppliedPlugin> {
  const desired = new Map<string, AppliedPlugin>()
  for (const plugin of inventory.plugins) {
    if (plugin.provenance !== "built-in")
      throw new PluginInventoryError(
        "provenance-mismatch",
        `Plugin ${plugin.id} is not from Maximal's built-in catalog.`,
        { source: plugin.definedIn, member: plugin.id },
      )
    const module = state.modules.get(plugin.descriptorId)
    if (!module)
      throw new PluginInventoryError(
        "missing-descriptor",
        `Plugin ${plugin.id} has no trusted built-in module.`,
        { source: plugin.definedIn, member: plugin.descriptorId },
      )
    if (module.name !== plugin.id)
      throw new PluginInventoryError(
        "provenance-mismatch",
        `Inventory id ${plugin.id} must keep the built-in identity ${module.name}.`,
        { source: plugin.definedIn, member: plugin.id },
      )
    desired.set(plugin.id, { descriptorId: plugin.descriptorId, module })
  }
  return desired
}

function commitApplied(
  state: ComposedInventoryState,
  desired: ReadonlyMap<string, AppliedPlugin>,
): void {
  state.applied = desired
}

function commitLastGood(
  state: ComposedInventoryState,
  inventory: ResolvedPluginInventory,
): void {
  state.lastGood = inventory
}

function inventoryDigest(inventory: ResolvedPluginInventory): string {
  return createHash("sha256").update(JSON.stringify(inventory)).digest("hex")
}

async function selectedInventory(
  state: ComposedInventoryState,
): Promise<ResolvedPluginInventory | undefined> {
  const committed = await state.stateBroker.committedGeneration()
  if (committed?.inventory === undefined) return undefined
  const candidate = committed.inventory as ResolvedPluginInventory
  try {
    if (inventoryDigest(candidate) !== committed.inventoryDigest)
      return undefined
    // Validate every descriptor and identity against the code-only catalog before
    // a durable record can influence runtime selection.
    desiredPlugins(state, candidate)
    return candidate
  } catch {
    return undefined
  }
}

/** Apply one inventory and select its generation at the settings commit point. */
async function applyResolvedInventory(
  state: ComposedInventoryState,
  inventory: ResolvedPluginInventory,
): Promise<void> {
  const desired = desiredPlugins(state, inventory)
  const digest = inventoryDigest(inventory)
  const selected = await state.stateBroker.committedGeneration()
  const sameSelection = selected?.generationId === digest
  const commitId = sameSelection ? selected.commitId : digest
  const handoffIdempotencyKey =
    sameSelection ?
      selected.handoffIdempotencyKey
    : createHash("sha256")
        .update(
          JSON.stringify([
            "plugin-generation-handoff/1",
            selected?.generationId ?? null,
            digest,
          ]),
        )
        .digest("hex")
  await state.host.replaceInventory(
    [...desired.values()].map((entry) => ({
      module: entry.module,
      source: BUILT_IN_SOURCE,
    })),
    (transaction) => {
      const durable = transaction as PluginStateTransaction
      durable.selectGeneration({
        commitId,
        handoffIdempotencyKey,
        generationId: digest,
        inventoryDigest: digest,
        pluginIds: [...desired.keys()],
        inventory,
      })
      return Promise.resolve()
    },
  )
  commitApplied(state, desired)
}

/**
 * Reload the configured inventory. Invalid documents and failed transactions
 * retain the last successfully applied inventory. With no override, this is a
 * no-op unless a previous override was active, in which case built-ins return.
 */
export function reloadComposedPluginInventory(
  gateway: PluginGateway,
  configured: AppConfig["pluginInventory"],
): Promise<void> {
  const state = inventoryStates.get(gateway)
  if (!state) return Promise.resolve()
  const run = state.queue.then(async () => {
    if (!configured && !state.overrideActive) return
    let next = state.defaultInventory
    if (configured) {
      const loaded = await reloadPluginInventory({
        entry: configured.entry,
        rootDirectory: state.rootDirectory,
        fileSystem: state.fileSystem,
        catalog: state.catalog,
        lastGood: state.lastGood,
      })
      if (!loaded.ok) {
        const recovered = await selectedInventory(state)
        consola.warn(
          `Could not reload plugin inventory ${configured.entry}; keeping the last good inventory`,
          loaded.error,
        )
        if (!recovered) return
        next = recovered
      } else {
        next = loaded.inventory
      }
    }
    try {
      await applyResolvedInventory(state, next)
    } catch (error) {
      consola.warn(
        "Could not apply plugin inventory; keeping the last good inventory",
        error,
      )
      return
    }
    commitLastGood(state, next)
    state.overrideActive = configured !== undefined
  })
  state.queue = run.then(
    () => undefined,
    () => undefined,
  )
  return run
}
