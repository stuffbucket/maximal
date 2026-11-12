/**
 * `runPluginConformance(module, options)` — the generic contract checks any
 * plugin package runs in its own tests (`bun:test`). Each check builds a
 * fresh `createLifecycleHarness` (real host, real settings files in a temp
 * dir) and walks part of the lifecycle: manifest and config shape, enable,
 * reload on a config change, disable and shutdown (every contribution gone,
 * nothing left running), settings migration, a broken settings file, and
 * the settings file staying host-owned.
 */
import type {
  PluginModule,
  StandardSchemaV1,
} from "@stuffbucket/maximal-plugin-sdk"

import {
  createFileStorage,
  injectedServices,
  isInjectList,
} from "@stuffbucket/maximal-plugin-sdk/runtime"
import { describe, expect, test } from "bun:test"

import { createPluginHost } from "../host"
import {
  createLifecycleHarness,
  type LifecycleHarness,
  type LifecycleHarnessOptions,
} from "./harness"
import { type HandleTracker, type LiveHandle, trackHandles } from "./leaks"

export interface ConformanceOptions {
  /** `describe` title (default `plugin conformance: <id>`). */
  title?: string
  /** Config the checks enable the plugin with (default: none stored, i.e. `{}`). */
  config?: unknown
  /** Another valid config: the plugin must reload when it changes. Without it the reload check only verifies that re-saving the same config does not reload. */
  changedConfig?: unknown
  /** Files seeded into the plugin's storage before it starts (e.g. accepted terms). */
  storage?: Readonly<Record<string, string>>
  /**
   * The plugin has finished starting (default: lifecycle `active`). Use it
   * for background setup, e.g. `status?.code === "ready"`.
   */
  settled?: (harness: LifecycleHarness, id: string) => boolean
  /** Once settled the plugin has registered tools (checked, then checked gone). */
  expectTools?: boolean
  /**
   * Extra leak signals checked after disable and shutdown (each returns the
   * problems it sees, e.g. upstream sessions still open on a fake).
   */
  leakProbes?: ReadonlyArray<() => Array<string> | Promise<Array<string>>>
  /** A stored config from an older settings version and what it migrates to. */
  migration?: { fromVersion: number; config: unknown; expected?: unknown }
  /** A legacy `config.json` value to import (default `config ?? {}`). */
  legacyConfig?: unknown
  /** Most time `apply` may take before it returns (default 250 ms). */
  applyBudgetMs?: number
  /** Timeouts shorter than this are not leaks (default 1000 ms). */
  leakTimeoutMs?: number
  /** Passed to every harness (e.g. `openExternal`, `secrets`). */
  harness?: Omit<LifecycleHarnessOptions, "plugins" | "storageRoot">
  /** Per-test timeout (default 20 s). */
  timeoutMs?: number
}

const CANARY_ID = "conformance-canary"

/** A plugin that only says it is fine; it must stay up when the one under test fails. */
const canary: PluginModule = {
  name: CANARY_ID,
  manifest: {
    id: CANARY_ID,
    kind: "extension",
    displayName: "Canary",
    description: "Stays up while another plugin fails.",
    settingsVersion: 1,
  },
  inject: ["surface"],
  Config: {
    "~standard": {
      version: 1,
      vendor: "conformance",
      validate: (value: unknown) => ({ value: value ?? {} }),
    },
  },
  apply(ctx) {
    ctx.surface.setStatus({ state: "ready", code: "ready", summary: "Fine" })
  },
}

type JsonSchemaProps = {
  jsonSchema?: {
    input?: (options: { target: string }) => Record<string, unknown>
    output?: (options: { target: string }) => Record<string, unknown>
  }
}

/** JSON with sorted keys and no `$schema`, for schema comparison. */
function canonical(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) => {
    if (item === null || typeof item !== "object" || Array.isArray(item))
      return item
    const sorted: Record<string, unknown> = {}
    for (const key of Object.keys(item).sort()) {
      if (key === "$schema") continue
      sorted[key] = (item as Record<string, unknown>)[key]
    }
    return sorted
  })
}

async function validateConfig(
  schema: StandardSchemaV1,
  value: unknown,
): Promise<StandardSchemaV1.Result<unknown>> {
  return await schema["~standard"].validate(value)
}

function describeHandles(handles: ReadonlyArray<LiveHandle>): Array<string> {
  return handles.map(
    (handle) =>
      `${handle.kind} ${handle.detail}\n      ${handle.stack.join("\n      ")}`,
  )
}

async function expectGatewayRejection(
  promise: Promise<unknown>,
  code: string,
): Promise<void> {
  let caught: unknown
  try {
    await promise
  } catch (error) {
    caught = error
  }
  expect(caught).toMatchObject({ code })
}

function expectNothingLeft(harness: LifecycleHarness, id: string): void {
  expect(harness.contributions(id)).toEqual({
    attached: false,
    tools: [],
    actions: [],
    status: undefined,
  })
  expect(harness.gateway.listTools(id)).toEqual([])
  expect(harness.snapshot(id).tools).toEqual([])
  expect(harness.snapshot(id).status).toBeUndefined()
  for (const fiber of harness.fibers(id)) expect(fiber.state).toBe("disposed")
  expect(harness.fiber(id)).toBeUndefined()
}

const SILENT_LOGGER = {
  debug() {},
  info() {},
  warn() {},
  error() {},
}

/** The shared steps every check uses. */
class Suite {
  readonly options: ConformanceOptions
  readonly #module: PluginModule | (() => PluginModule)

  constructor(
    module: PluginModule | (() => PluginModule),
    options: ConformanceOptions,
  ) {
    this.#module = module
    this.options = options
  }

  plugin(): PluginModule {
    return typeof this.#module === "function" ? this.#module() : this.#module
  }

  /** A harness for `plugin` (apply timed) plus `extra` plugins. */
  harness(
    plugin: PluginModule,
    extra: ReadonlyArray<PluginModule> = [],
  ): { harness: LifecycleHarness; applyTimes: Array<number> } {
    const applyTimes: Array<number> = []
    const timed: PluginModule = {
      ...plugin,
      apply(ctx, config) {
        const started = performance.now()
        const result = plugin.apply(ctx, config)
        if (result instanceof Promise) {
          return result.finally(() =>
            applyTimes.push(performance.now() - started),
          )
        }
        applyTimes.push(performance.now() - started)
        return result
      },
    }
    const harness = createLifecycleHarness({
      ...this.options.harness,
      plugins: [timed, ...extra],
    })
    return { harness, applyTimes }
  }

  async seedStorage(harness: LifecycleHarness, id: string): Promise<void> {
    const files = createFileStorage(harness.storageRoot)
    for (const [name, text] of Object.entries(this.options.storage ?? {}))
      await files.writeText(id, name, text)
  }

  /** Seed, configure, enable and wait until the plugin settled. */
  async start(harness: LifecycleHarness, id: string): Promise<void> {
    const { options } = this
    await this.seedStorage(harness, id)
    if (options.config !== undefined)
      await harness.setConfig(id, options.config)
    await harness.enable(id)
    expect(harness.snapshot(id).lifecycle).toBe("active")
    const settled =
      options.settled
      ?? ((h: LifecycleHarness, pluginId: string) =>
        h.snapshot(pluginId).lifecycle === "active")
    await harness.waitFor(() => settled(harness, id), {
      timeoutMs: 10_000,
      message: `${id} did not settle after enable`,
    })
    await harness.flush()
    if (options.expectTools)
      expect(harness.contributions(id).tools.length).toBeGreaterThan(0)
  }

  /** Live handles and probe findings, after giving closes a moment. */
  async leaks(
    harness: LifecycleHarness,
    tracker: HandleTracker,
  ): Promise<Array<string>> {
    const minTimeoutMs = this.options.leakTimeoutMs ?? 1000
    const probes = this.options.leakProbes ?? []
    const problems = async () => {
      const found = describeHandles(tracker.live({ minTimeoutMs }))
      for (const probe of probes) found.push(...(await probe()))
      return found
    }
    await harness
      .waitFor(async () => (await problems()).length === 0, { timeoutMs: 2000 })
      .catch(() => undefined)
    return await problems()
  }
}

async function checkManifest(suite: Suite): Promise<void> {
  const plugin = suite.plugin()
  expect(plugin.manifest.id).toBe(plugin.name)
  // A JSON round trip (not structuredClone): the manifest must be plain JSON.
  // eslint-disable-next-line unicorn/prefer-structured-clone -- see above
  expect(JSON.parse(JSON.stringify(plugin.manifest))).toEqual(plugin.manifest)
  // The host validates the module and manifest on construction.
  const gateway = buildBareHost(suite, plugin)
  await gateway.dispose()
}

function buildBareHost(suite: Suite, plugin: PluginModule) {
  return createPluginHost({
    plugins: [plugin],
    services: {
      storageRoot: "/nonexistent-plugin-conformance",
      host: {
        appVersion: "0.0.0-test",
        logger: SILENT_LOGGER,
        openExternal: () => Promise.resolve(),
      },
      extra: suite.options.harness?.extraServices,
    },
  })
}

/** Every injected service exists, and the host refuses one it does not provide. */
async function checkInject(suite: Suite): Promise<void> {
  const plugin = suite.plugin()
  const names = injectedServices(plugin)
  expect(names.length).toBeGreaterThan(0)
  // Provided: the host accepts the plugin as declared (see the manifest check).
  await buildBareHost(suite, plugin).dispose()
  // Not provided: an unknown name is refused when the host is built.
  const unknown = "conformance-no-such-service"
  const widened: PluginModule = {
    ...plugin,
    inject:
      isInjectList(plugin.inject) ?
        [...plugin.inject, unknown]
      : { ...plugin.inject, [unknown]: true },
  }
  expect(() => buildBareHost(suite, widened)).toThrow(
    new RegExp(`requires missing service: ${unknown}`),
  )
}

async function checkConfigSchema(suite: Suite): Promise<void> {
  const plugin = suite.plugin()
  const schema = plugin.manifest.configSchema
  if (schema === undefined) return
  expect(schema.type).toBe("object")
  const parsed = await validateConfig(plugin.Config, {})
  const defaults = (parsed.issues ? {} : parsed.value) as Record<
    string,
    unknown
  >
  const properties = (schema.properties ?? {}) as Record<
    string,
    { default?: unknown } | undefined
  >
  // Every config field is described, with the default `{}` yields.
  for (const [key, value] of Object.entries(defaults)) {
    expect(Object.keys(properties)).toContain(key)
    const declared: Record<string, unknown> = {
      [key]: properties[key]?.default,
    }
    if (declared[key] !== undefined) expect(declared).toEqual({ [key]: value })
  }
  // When the schema library can emit JSON Schema, it is that schema.
  const standard = plugin.Config["~standard"] as JsonSchemaProps
  const emit = standard.jsonSchema
  if (emit?.input && emit.output) {
    const target = { target: "draft-2020-12" }
    expect([
      canonical(emit.input(target)),
      canonical(emit.output(target)),
    ]).toContain(canonical(schema))
  }
}

async function checkEnable(suite: Suite): Promise<void> {
  const plugin = suite.plugin()
  const { harness, applyTimes } = suite.harness(plugin)
  try {
    expect(harness.snapshot(plugin.name).lifecycle).toBe("disabled")
    await suite.start(harness, plugin.name)
    expect(applyTimes.length).toBe(1)
    expect(applyTimes[0]).toBeLessThan(suite.options.applyBudgetMs ?? 250)
    expect(harness.fibers(plugin.name)).toEqual([{ fiber: 1, state: "active" }])
    expect(
      harness
        .transcript({ kinds: ["fiber"] })
        .map((entry) => entry.kind === "fiber" && `${entry.from}>${entry.to}`),
    ).toEqual(["pending>loading", "loading>active"])
  } finally {
    await harness.dispose()
  }
}

async function checkReload(suite: Suite): Promise<void> {
  const plugin = suite.plugin()
  const { harness } = suite.harness(plugin)
  const id = plugin.name
  try {
    await suite.start(harness, id)
    let fibers = 1
    if (suite.options.changedConfig !== undefined) {
      await harness.setConfig(id, suite.options.changedConfig)
      fibers = 2
      expect(harness.fibers(id)).toEqual([
        { fiber: 1, state: "disposed" },
        { fiber: 2, state: "active" },
      ])
    }
    const mark = harness.mark()
    // Saving the stored config again changes nothing.
    await harness.setConfig(id, harness.settings(id)?.config ?? {})
    await harness.flush()
    expect(harness.transcript({ since: mark, kinds: ["fiber"] })).toEqual([])
    expect(harness.fibers(id).length).toBe(fibers)
  } finally {
    await harness.dispose()
  }
}

async function checkStop(suite: Suite, how: "disable" | "dispose") {
  const plugin = suite.plugin()
  const { harness } = suite.harness(plugin)
  const id = plugin.name
  const tracker = trackHandles()
  try {
    const rootBefore = harness.rootEffects()
    await suite.start(harness, id)
    expect(harness.effects(id).length).toBeGreaterThan(0)
    if (how === "disable") {
      await harness.disable(id)
      await harness.flush()
      expect(harness.snapshot(id).lifecycle).toBe("disabled")
      expect(harness.rootEffects()).toEqual(rootBefore)
    } else {
      await harness.dispose()
    }
    expectNothingLeft(harness, id)
    expect(await suite.leaks(harness, tracker)).toEqual([])
  } finally {
    tracker.stop()
    await harness.dispose()
  }
}

async function checkMigration(suite: Suite): Promise<void> {
  const plugin = suite.plugin()
  const id = plugin.name
  const { options } = suite
  const { harness } = suite.harness(plugin)
  try {
    const { migration } = options
    if (migration) {
      await harness.seedSettings(id, {
        $schema: "maximal-plugin-settings/1",
        plugin: id,
        version: migration.fromVersion,
        config: migration.config,
      })
    } else {
      const legacy = options.legacyConfig ?? options.config ?? {}
      expect(await harness.importLegacyConfig(id, legacy)).toBe(true)
    }
    await suite.seedStorage(harness, id)
    await harness.enable(id)
    expect(harness.snapshot(id).lifecycle).toBe("active")
    const stored = harness.settings(id)
    expect(stored).toMatchObject({
      plugin: id,
      version: plugin.manifest.settingsVersion,
    })
    if (migration?.expected !== undefined)
      expect({ config: stored?.config }).toEqual({
        config: migration.expected,
      })
    expect(harness.settingsTamperedWith(id)).toBe(false)
  } finally {
    await harness.dispose()
  }
}

async function checkBrokenSettings(suite: Suite): Promise<void> {
  const plugin = suite.plugin()
  const id = plugin.name
  const broken = [
    "{ not json",
    JSON.stringify({
      $schema: "maximal-plugin-settings/1",
      plugin: id,
      version: plugin.manifest.settingsVersion + 1,
      config: {},
    }),
  ]
  for (const text of broken) {
    const { harness } = suite.harness(plugin, [canary])
    try {
      await harness.seedSettings(id, text)
      await harness.enable(id)
      await harness.enable(CANARY_ID)
      const snapshot = harness.snapshot(id)
      expect(snapshot.lifecycle).toBe("failed")
      expect(snapshot.error).toBeString()
      expect(harness.fibers(id)).toEqual([])
      expect(harness.snapshot(CANARY_ID).lifecycle).toBe("active")
      await expectGatewayRejection(
        harness.setConfig(id, {}),
        "settings-unreadable",
      )
      await expectGatewayRejection(
        harness.setPermissions(id, { anything: "block" }),
        "settings-unreadable",
      )
      await harness.flush()
      expect(harness.settingsText(id)).toBe(text)
      expect(harness.settingsTamperedWith(id)).toBe(false)
    } finally {
      await harness.dispose()
    }
  }
}

async function checkSettingsOwnership(suite: Suite): Promise<void> {
  const plugin = suite.plugin()
  const id = plugin.name
  const { harness } = suite.harness(plugin)
  try {
    await suite.start(harness, id)
    if (suite.options.changedConfig !== undefined)
      await harness.setConfig(id, suite.options.changedConfig)
    await harness.disable(id)
    await harness.flush()
    expect(harness.settingsTamperedWith(id)).toBe(false)
    const storageWrites = harness
      .transcript({ kinds: ["storage"] })
      .map((entry) => entry.kind === "storage" && entry.name)
    expect(storageWrites).not.toContain("settings.json")
  } finally {
    await harness.dispose()
  }
}

/**
 * Register the conformance checks for `module` (or a factory, called inside
 * each test, for modules wired to fakes started in `beforeAll`).
 */
export function runPluginConformance(
  module: PluginModule | (() => PluginModule),
  options: ConformanceOptions = {},
): void {
  const suite = new Suite(module, options)
  const title =
    options.title
    ?? `plugin conformance: ${typeof module === "function" ? "(factory)" : module.name}`
  const timeout = options.timeoutMs ?? 20_000
  describe(title, () => {
    test("manifest is valid, plain JSON, and its id is the module name", () =>
      checkManifest(suite))
    test("inject names only services the host provides", () =>
      checkInject(suite))
    test("Config accepts {}", async () => {
      const result = await validateConfig(suite.plugin().Config, {})
      expect(result.issues ?? []).toEqual([])
    })
    test("manifest.configSchema matches Config", () => checkConfigSchema(suite))
    test(
      "enable: apply returns promptly and the plugin becomes active",
      () => checkEnable(suite),
      timeout,
    )
    test(
      "a changed config reloads the plugin; the same config does not",
      () => checkReload(suite),
      timeout,
    )
    test(
      "disable withdraws every contribution and leaves nothing running",
      () => checkStop(suite, "disable"),
      timeout,
    )
    test(
      "shutdown (dispose) withdraws every contribution and leaves nothing running",
      () => checkStop(suite, "dispose"),
      timeout,
    )
    test(
      "settings from an older version or a legacy config.json value are migrated",
      () => checkMigration(suite),
      timeout,
    )
    test(
      "an unreadable or newer settings file fails only this plugin and is never overwritten",
      () => checkBrokenSettings(suite),
      timeout,
    )
    test(
      "settings.json stays host-owned: the plugin never writes it",
      () => checkSettingsOwnership(suite),
      timeout,
    )
  })
}
