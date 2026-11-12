/**
 * Test helpers for plugin authors: run a plugin under a real cordis
 * `Context` with the same `tools` / `surface` services the host uses, an
 * in-memory (or temp-dir) `storage`, and a recording fake `host`. Settings
 * are negotiated like the host does: without an explicit config, `load`
 * reads the plugin's `settings.json` (migrating it with `migrateSettings`).
 *
 * ```ts
 * const plugin = await loadPlugin(myPlugin, { greeting: "hi" })
 * try {
 *   expect(plugin.tools().map((t) => t.name)).toEqual(["hello"])
 *   expect(await plugin.callTool("hello", {})).toEqual({ content: [{ type: "text", text: "hi" }] })
 * } finally {
 *   await plugin.dispose()
 * }
 * ```
 */
import { Context, type Fiber } from "@deepseek-ai/cordis"
import {
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs"
import path from "node:path"

import type { PluginModule } from "../index"
import type {
  HostServices,
  PluginLogger,
  PluginManifest,
  PluginStatus,
  PluginToolView,
  ToolCallContext,
  ToolDefinition,
  ToolPermission,
  ToolResult,
} from "../types"

import { PluginContractError } from "../errors"
import {
  activatePlugin,
  assertPluginDependencies,
  createFileStorage,
  deactivatePlugin,
  installPluginServices,
  invokeTool,
  loadPluginSettings,
  newSettingsDocument,
  normalizeManifest,
  parsePluginConfig,
  parseSettingsDocument,
  PluginRuntime,
  storedPermissions,
  toCordisPlugin,
  toolView,
  validatePluginModule,
  writePluginSettings,
  type PluginRuntimeEvent,
  type PluginSettingsDocument,
  type PluginStorageBackend,
} from "../runtime"
import { PLUGIN_SERVICE_NAMES, PLUGIN_SETTINGS_FILE } from "../types"

export type { PluginRuntimeEvent, PluginSettingsDocument } from "../runtime"

export interface LogRecord {
  level: keyof PluginLogger
  message: string
  args: Array<unknown>
}

/** Recording `ctx.host`. */
export interface FakeHost extends HostServices {
  /** URLs passed to `openExternal`, in order. */
  readonly opened: Array<string>
  readonly logs: Array<LogRecord>
}

/** `ctx.storage` backend (memory or a temp dir), inspectable per plugin id. */
export interface TestbedStorage extends PluginStorageBackend {
  /** Snapshot of a plugin's files (including the host-owned `settings.json`). */
  files(pluginId: string): Record<string, string>
  /** Seed or overwrite a file directly (bypasses the plugin). */
  seed(pluginId: string, name: string, text: string): void
}

/** @deprecated Use `TestbedStorage`. */
export type MemoryStorage = TestbedStorage

export interface TestbedOptions {
  appVersion?: string
  /** Called after the URL is recorded, e.g. to drive a loopback OAuth redirect. */
  openExternal?: (url: string) => void | Promise<void>
  /** Initial storage: `{ [pluginId]: { [name]: text } }`. */
  storage?: Record<string, Record<string, string>>
  /**
   * Back storage with real files under this directory (e.g. a temp dir)
   * instead of memory — same backend as the host: `<dir>/<id>/`, 0700/0600.
   */
  storageDir?: string
}

/** What `Testbed.writeSettings` puts in a plugin's `settings.json`. */
export interface TestSettings {
  /** Defaults to `manifest.settingsVersion`. */
  version?: number
  config?: unknown
  permissions?: Record<string, ToolPermission>
}

export interface LoadedPlugin {
  readonly id: string
  /** The validated, normalised manifest. */
  readonly manifest: Readonly<PluginManifest>
  /** The validated config handed to `apply`. */
  readonly config: unknown
  readonly fiber: Fiber
  tools(): Array<ToolDefinition>
  tool(name: string): ToolDefinition | undefined
  /**
   * Call a registered tool like the gateway does (throw → `isError`
   * result). `call.signal` defaults to a signal that aborts on dispose.
   * Throws if the tool is not registered.
   */
  callTool(
    name: string,
    input?: Record<string, unknown>,
    call?: Partial<ToolCallContext>,
  ): Promise<ToolResult>
  /**
   * Registered tools with group and effective permission, resolved like
   * the host: `permissions` (default: the current `settings.json`) >
   * `defaultToolPermission` > `allow`.
   */
  toolViews(
    permissions?: Readonly<Record<string, ToolPermission>>,
  ): Promise<Array<PluginToolView>>
  status(): PluginStatus | undefined
  /** Registered surface action ids. */
  actions(): Array<string>
  /** Throws if the action is not registered; rejects if the handler does. */
  runAction(id: string, signal?: AbortSignal): Promise<void>
  /** Dispose the plugin fiber; its contributions vanish. Idempotent. */
  dispose(): Promise<void>
}

export interface Testbed {
  /** The root context (services are provided here). */
  readonly ctx: Context
  readonly runtime: PluginRuntime
  readonly host: FakeHost
  readonly storage: TestbedStorage
  /** Every `tools` / `status` change, in order. */
  readonly events: Array<PluginRuntimeEvent>
  /**
   * Validate the module (shape, manifest, injected services), negotiate its
   * config, and start it. With `config` given, that value is validated and
   * used (the settings file is not consulted for config). Otherwise the
   * plugin's `settings.json` is read like the host does — envelope check,
   * `migrateSettings`, validation, write-back when migrated; no file ⇒ `{}`.
   * Rejects with a `PluginContractError` (`invalid-module` /
   * `invalid-manifest` / `missing-service` / `invalid-config` /
   * `invalid-settings`) or with whatever `apply` threw.
   */
  load<C>(module: PluginModule<C>, config?: unknown): Promise<LoadedPlugin>
  /** Write a `settings.json` for `module` (envelope filled in). */
  writeSettings(
    module: Pick<PluginModule, "name" | "manifest">,
    settings: TestSettings,
  ): Promise<void>
  /** The parsed `settings.json` of a plugin, or `undefined` when absent. */
  readSettings(pluginId: string): Promise<PluginSettingsDocument | undefined>
  /** Dispose every loaded plugin and the root context. Idempotent. */
  dispose(): Promise<void>
}

function createFakeHost(options: TestbedOptions): FakeHost {
  const opened: Array<string> = []
  const logs: Array<LogRecord> = []
  const record =
    (level: keyof PluginLogger) =>
    (message: string, ...args: Array<unknown>) => {
      logs.push({ level, message, args })
    }
  return {
    opened,
    logs,
    appVersion: options.appVersion ?? "0.0.0-test",
    logger: {
      debug: record("debug"),
      info: record("info"),
      warn: record("warn"),
      error: record("error"),
    },
    async openExternal(url: string) {
      opened.push(url)
      await options.openExternal?.(url)
    },
  }
}

function createDirStorage(root: string): TestbedStorage {
  const backend = createFileStorage(root)
  return {
    ...backend,
    files(pluginId) {
      const dir = backend.dir(pluginId)
      let names: Array<string>
      try {
        names = readdirSync(dir)
      } catch {
        return {}
      }
      return Object.fromEntries(
        names
          .filter((name) => statSync(path.join(dir, name)).isFile())
          .map((name) => [name, readFileSync(path.join(dir, name), "utf8")]),
      )
    },
    seed(pluginId, name, text) {
      const dir = backend.dir(pluginId)
      mkdirSync(dir, { recursive: true, mode: 0o700 })
      writeFileSync(path.join(dir, name), text, { mode: 0o600 })
    },
  }
}

function createMemoryStorage(): TestbedStorage {
  const data = new Map<string, Map<string, string>>()
  const bucket = (pluginId: string) => {
    let files = data.get(pluginId)
    if (!files) {
      files = new Map<string, string>()
      data.set(pluginId, files)
    }
    return files
  }
  return {
    dir: (pluginId) => `/memory/plugins/${pluginId}`,
    readText: (pluginId, name) =>
      Promise.resolve(data.get(pluginId)?.get(name)),
    writeText: (pluginId, name, text) => {
      bucket(pluginId).set(name, text)
      return Promise.resolve()
    },
    delete: (pluginId, name) => {
      data.get(pluginId)?.delete(name)
      return Promise.resolve()
    },
    files: (pluginId) => Object.fromEntries(data.get(pluginId) ?? []),
    seed: (pluginId, name, text) => {
      bucket(pluginId).set(name, text)
    },
  }
}

// eslint-disable-next-line max-params -- private helper; all four inputs are required
async function negotiateConfig(
  storage: PluginStorageBackend,
  plugin: PluginModule,
  manifest: Readonly<PluginManifest>,
  config: unknown,
): Promise<unknown> {
  const fail = (code: "invalid-config" | "invalid-settings", message: string) =>
    new PluginContractError(code, message, { pluginId: plugin.name })
  if (config !== undefined) {
    const parsed = await parsePluginConfig(plugin, config)
    if (!parsed.ok) throw fail("invalid-config", parsed.message)
    return parsed.value
  }
  const loaded = await loadPluginSettings(storage, plugin, manifest)
  if (!loaded.ok) throw fail("invalid-settings", loaded.error)
  if (!loaded.parsed.ok) throw fail("invalid-config", loaded.parsed.message)
  return loaded.parsed.value
}

async function readTestSettings(
  storage: PluginStorageBackend,
  pluginId: string,
): Promise<PluginSettingsDocument | undefined> {
  const text = await storage.readText(pluginId, PLUGIN_SETTINGS_FILE)
  return text === undefined ? undefined : parseSettingsDocument(pluginId, text)
}

async function writeTestSettings(
  storage: PluginStorageBackend,
  module: Pick<PluginModule, "name" | "manifest">,
  settings: TestSettings,
): Promise<void> {
  const document = newSettingsDocument({
    id: module.name,
    settingsVersion: settings.version ?? module.manifest.settingsVersion,
  })
  if (settings.config !== undefined) document.config = settings.config
  if (settings.permissions !== undefined)
    document.tools = { permissions: { ...settings.permissions } }
  await writePluginSettings(storage, document)
}

/** A root cordis context with the plugin services installed. */
export function createTestbed(options: TestbedOptions = {}): Testbed {
  const events: Array<PluginRuntimeEvent> = []
  const runtime = new PluginRuntime({ onChange: (event) => events.push(event) })
  const ctx = new Context()
  const host = createFakeHost(options)
  const storage =
    options.storageDir === undefined ?
      createMemoryStorage()
    : createDirStorage(options.storageDir)
  for (const [pluginId, files] of Object.entries(options.storage ?? {})) {
    for (const [name, text] of Object.entries(files))
      storage.seed(pluginId, name, text)
  }
  installPluginServices(ctx, runtime, { host, storage })
  const loaded = new Set<LoadedPlugin>()
  let disposing: Promise<void> | undefined

  async function load<C>(
    module: PluginModule<C>,
    config?: unknown,
  ): Promise<LoadedPlugin> {
    if (disposing) throw new Error("Testbed is disposed.")
    const plugin = validatePluginModule(module)
    const manifest = normalizeManifest(plugin.name, plugin.manifest)
    assertPluginDependencies(plugin, PLUGIN_SERVICE_NAMES)
    const value = await negotiateConfig(storage, plugin, manifest, config)
    const id = plugin.name
    const lifetime = new AbortController()
    const fiber = await activatePlugin(
      ctx,
      runtime,
      id,
      toCordisPlugin(plugin),
      value,
    )
    let stopped: Promise<void> | undefined
    const handle: LoadedPlugin = {
      id,
      manifest,
      config: value,
      fiber,
      tools: () => runtime.tools(id),
      tool: (name) => runtime.tool(id, name),
      async callTool(name, input = {}, call = {}) {
        const tool = runtime.tool(id, name)
        if (!tool) throw new Error(`Plugin "${id}" has no tool "${name}".`)
        const signal =
          call.signal ?
            AbortSignal.any([call.signal, lifetime.signal])
          : lifetime.signal
        return await invokeTool(tool, input, { ...call, signal })
      },
      async toolViews(permissions) {
        const explicit =
          permissions ?? storedPermissions(await readTestSettings(storage, id))
        return runtime.tools(id).map((tool) => toolView(plugin, tool, explicit))
      },
      status: () => runtime.status(id),
      actions: () => runtime.actionIds(id),
      async runAction(actionId, signal) {
        const handler = runtime.action(id, actionId)
        if (!handler)
          throw new Error(`Plugin "${id}" has no action "${actionId}".`)
        await handler(
          signal ? AbortSignal.any([signal, lifetime.signal]) : lifetime.signal,
        )
      },
      dispose() {
        stopped ??= (async () => {
          loaded.delete(handle)
          lifetime.abort(new Error(`Plugin "${id}" stopped.`))
          await deactivatePlugin(runtime, id, fiber)
        })()
        return stopped
      },
    }
    loaded.add(handle)
    return handle
  }

  return {
    ctx,
    runtime,
    host,
    storage,
    events,
    load,
    writeSettings: (module, settings) =>
      writeTestSettings(storage, module, settings),
    readSettings: (pluginId) => readTestSettings(storage, pluginId),
    dispose() {
      disposing ??= (async () => {
        await Promise.all([...loaded].map((plugin) => plugin.dispose()))
        await ctx.fiber.dispose()
      })()
      return disposing
    },
  }
}

/** Load one plugin into a fresh testbed; `dispose()` tears both down. */
export async function loadPlugin<C>(
  module: PluginModule<C>,
  config?: unknown,
  options?: TestbedOptions,
): Promise<LoadedPlugin & { readonly testbed: Testbed }> {
  const testbed = createTestbed(options)
  let plugin: LoadedPlugin
  try {
    plugin = await testbed.load(module, config)
  } catch (error) {
    await testbed.dispose()
    throw error
  }
  return {
    ...plugin,
    testbed,
    async dispose() {
      await plugin.dispose()
      await testbed.dispose()
    },
  }
}

/** Poll `predicate` until it holds (default 2 s timeout, 5 ms interval). */
export async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  options: { timeoutMs?: number; intervalMs?: number; message?: string } = {},
): Promise<void> {
  const deadline = Date.now() + (options.timeoutMs ?? 2000)
  for (;;) {
    if (await predicate()) return
    if (Date.now() >= deadline)
      throw new Error(
        options.message ?? "waitFor: condition not met before timeout",
      )
    await new Promise((resolve) => setTimeout(resolve, options.intervalMs ?? 5))
  }
}
