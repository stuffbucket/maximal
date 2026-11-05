/**
 * A lifecycle harness for one or more plugins under the real plugin host
 * (`createPluginHost`) with real settings files in a temp dir. Everything
 * that crosses the plugin boundary is recorded, in order, as a transcript:
 * fiber transitions (cordis `internal/status`), gateway events, lifecycle,
 * status, tool registrations, settings.json writes (as content diffs),
 * `ctx.storage` writes (names only), `host.openExternal` and host log lines.
 */
import type { Fiber } from "@deepseek-ai/cordis"
import type {
  HostServices,
  PluginLogger,
  PluginModule,
  PluginStatus,
} from "@stuffbucket/maximal-plugin-sdk"
import type {
  PluginGateway,
  PluginGatewayEventType,
  PluginLifecycle,
  PluginSettings,
  PluginSettingsEntry,
  PluginSnapshot,
  ToolPermission,
} from "@stuffbucket/maximal-plugin-sdk/gateway"

import { PLUGIN_SETTINGS_FILE } from "@stuffbucket/maximal-plugin-sdk"
import {
  createFileStorage,
  errorMessage,
  type PluginStorageBackend,
} from "@stuffbucket/maximal-plugin-sdk/runtime"
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs"
import os from "node:os"
import path from "node:path"

import {
  createPluginHost,
  type PluginHostInternals,
  pluginHostInternals,
} from "../host"
import { findSecrets, Normalizer } from "./normalize"

/** cordis `FiberState`, by value (a `const enum` upstream). */
const FIBER_STATES = [
  "pending",
  "loading",
  "active",
  "failed",
  "disposed",
  "unloading",
] as const
export type FiberStateName = (typeof FIBER_STATES)[number]

export function fiberStateName(state: number): FiberStateName {
  return FIBER_STATES[state] ?? "pending"
}

/** One changed leaf of settings.json (catalog tools summarised by name). */
export interface SettingsChange {
  path: string
  before?: unknown
  after?: unknown
}

export type TranscriptEntry =
  | { kind: "step"; name: string }
  | {
      kind: "fiber"
      plugin: string
      /** 1 for the plugin's first fiber, 2 after a reload, … */
      fiber: number
      from: FiberStateName
      to: FiberStateName
    }
  | { kind: "event"; plugin: string; type: PluginGatewayEventType }
  | {
      kind: "lifecycle"
      plugin: string
      lifecycle: PluginLifecycle
      error?: string
    }
  | { kind: "status"; plugin: string; status: PluginStatus | null }
  | {
      kind: "tools"
      plugin: string
      registered: Array<string>
      withdrawn: Array<string>
    }
  | {
      kind: "visible-tools"
      plugin: string
      shown: Array<string>
      hidden: Array<string>
    }
  | { kind: "settings"; plugin: string; changes: Array<SettingsChange> }
  | { kind: "storage"; plugin: string; op: "write" | "delete"; name: string }
  | { kind: "open-external"; url: string }
  | { kind: "log"; level: keyof PluginLogger; message: string }

export type TranscriptKind = TranscriptEntry["kind"]

export interface LifecycleHarnessOptions {
  plugins: ReadonlyArray<PluginModule>
  /** Plugin storage root; default a fresh temp dir, removed on `dispose`. */
  storageRoot?: string
  appVersion?: string
  /** Runs after the URL is recorded (e.g. drive a loopback redirect). */
  openExternal?: (url: string) => void | Promise<void>
  /** Values that must never be recorded in the clear: masked in `transcript()`, reported by `secretsSeen()`. */
  secrets?: ReadonlyArray<string>
  /** Also send host log lines here. */
  logger?: PluginLogger
  /** Shared normaliser (e.g. with aliases for fake origins). */
  normalizer?: Normalizer
}

export interface PluginContributions {
  /** The runtime slot is attached (a fiber is running). */
  attached: boolean
  tools: Array<string>
  actions: Array<string>
  status: PluginStatus | undefined
}

export interface WaitOptions {
  timeoutMs?: number
  intervalMs?: number
  message?: string
}

export interface LifecycleHarness {
  readonly gateway: PluginGateway
  readonly storageRoot: string
  readonly normalizer: Normalizer
  /** Every URL handed to `host.openExternal`. */
  readonly opened: ReadonlyArray<string>
  /** Raw transcript (not normalised; may contain secrets — never snapshot it). */
  readonly entries: ReadonlyArray<TranscriptEntry>
  /** Normalised copy, optionally from index `since` and filtered by kind. */
  transcript(options?: {
    since?: number
    kinds?: ReadonlyArray<TranscriptKind>
  }): Array<TranscriptEntry>
  /** Current transcript length (pass to `transcript({ since })` / `waitForEntry`). */
  mark(): number
  /** Record a step marker. */
  step(name: string): void

  // Stepping (config.json `plugins.<id>` is kept in memory here).
  enable(
    id: string,
    entry?: Omit<PluginSettingsEntry, "enabled">,
  ): Promise<void>
  disable(id: string): Promise<void>
  reconcile(): Promise<void>
  setConfig(id: string, config: unknown): Promise<void>
  setPermissions(
    id: string,
    changes: Record<string, ToolPermission | null>,
  ): Promise<void>
  runAction(id: string, actionId: string): Promise<void>
  importLegacyConfig(id: string, config: unknown): Promise<boolean>
  /** Write `<root>/<id>/settings.json` as an older app or the user would (not a host write). */
  seedSettings(id: string, document: unknown): Promise<void>

  // Settling (cordis-style).
  /** Wait for queued reconciles, settings I/O and the plugins' fibers to settle. */
  flush(): Promise<void>
  waitFor(
    predicate: () => boolean | Promise<boolean>,
    options?: WaitOptions,
  ): Promise<void>
  /** Wait until the plugin's status code (or predicate) holds. */
  waitForStatus(
    id: string,
    code: string | ((status: PluginStatus | undefined) => boolean),
    options?: WaitOptions,
  ): Promise<PluginStatus | undefined>
  /** Wait for a transcript entry matching `predicate` (from index `since`). */
  waitForEntry(
    predicate: (entry: TranscriptEntry) => boolean,
    options?: WaitOptions & { since?: number },
  ): Promise<TranscriptEntry>

  // Inspection.
  snapshot(id: string): PluginSnapshot
  contributions(id: string): PluginContributions
  /** The plugin's current fiber (`undefined` unless started). */
  fiber(id: string): Fiber | undefined
  /** Labels of the effects live on the plugin's fiber. */
  effects(id: string): Array<string>
  /** Labels of the effects live on the host's root fiber. */
  rootEffects(): Array<string>
  /** Every fiber the plugin had, with its state now. */
  fibers(id: string): Array<{ fiber: number; state: FiberStateName }>
  /** Raw settings.json text on disk (`undefined` when absent). */
  settingsText(id: string): string | undefined
  /** Parsed settings.json on disk. */
  settings(id: string): Record<string, unknown> | undefined
  /** Whether settings.json on disk differs from what the host (or `seedSettings`) last wrote. */
  settingsTamperedWith(id: string): boolean
  /** Names of the files in the plugin's storage directory. */
  files(id: string): Array<string>
  /** Secrets found in the raw transcript, with the entries carrying them. */
  secretsSeen(): Array<{ secret: string; entry: TranscriptEntry }>
  dispose(): Promise<void>
}

function leafPaths(
  value: unknown,
  prefix: string,
  out: Map<string, unknown>,
): void {
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    const entries = Object.entries(value)
    if (entries.length === 0 && prefix !== "") out.set(prefix, {})
    for (const [key, item] of entries)
      leafPaths(item, prefix === "" ? key : `${prefix}.${key}`, out)
    return
  }
  out.set(prefix, value)
}

/** Settings document with the catalog's tool definitions reduced to names. */
function summarizeSettings(text: string | undefined): unknown {
  if (text === undefined) return undefined
  let document: unknown
  try {
    document = JSON.parse(text) as unknown
  } catch {
    return { "(unparseable)": text.slice(0, 80) }
  }
  const tools = (document as { tools?: { catalog?: { tools?: unknown } } })
    .tools
  const catalog = tools?.catalog
  if (catalog && Array.isArray(catalog.tools)) {
    return {
      ...(document as object),
      tools: {
        ...tools,
        catalog: {
          ...catalog,
          tools: catalog.tools.map((tool: unknown) =>
            String((tool as { name?: unknown }).name),
          ),
        },
      },
    }
  }
  return document
}

const show = (value: unknown) =>
  value === undefined ? "(none)" : JSON.stringify(value)

function formatStatus(status: PluginStatus | null): string {
  if (!status) return "(none)"
  const parts = [
    `${status.state}/${status.code}`,
    JSON.stringify(status.summary),
  ]
  if (status.detail !== undefined)
    parts.push(`detail=${JSON.stringify(status.detail)}`)
  if (status.facts?.length)
    parts.push(
      `facts=[${status.facts.map((fact) => `${fact.label}=${fact.value}`).join(", ")}]`,
    )
  if (status.actions?.length)
    parts.push(
      `actions=[${status.actions
        .map(
          (action) =>
            `${action.id}:${JSON.stringify(action.label)}${action.kind ? `(${action.kind})` : ""}${action.confirm === undefined ? "" : "+confirm"}`,
        )
        .join(", ")}]`,
    )
  return parts.join(" ")
}

/** One line per entry, for compact, reviewable snapshots. */
export function formatEntry(entry: TranscriptEntry): string {
  switch (entry.kind) {
    case "step": {
      return `── ${entry.name}`
    }
    case "fiber": {
      return `fiber ${entry.plugin}#${entry.fiber} ${entry.from} → ${entry.to}`
    }
    case "event": {
      return `event ${entry.plugin} ${entry.type}`
    }
    case "lifecycle": {
      return `lifecycle ${entry.plugin} ${entry.lifecycle}${entry.error === undefined ? "" : ` error=${JSON.stringify(entry.error)}`}`
    }
    case "status": {
      return `status ${entry.plugin} ${formatStatus(entry.status)}`
    }
    case "tools": {
      return `tools ${entry.plugin} +[${entry.registered.join(", ")}] -[${entry.withdrawn.join(", ")}]`
    }
    case "visible-tools": {
      return `visible-tools ${entry.plugin} shown=[${entry.shown.join(", ")}] hidden=[${entry.hidden.join(", ")}]`
    }
    case "settings": {
      const changes = entry.changes.map(
        (change) =>
          `${change.path}: ${show(change.before)} → ${show(change.after)}`,
      )
      return `settings.json ${entry.plugin} ${changes.length === 0 ? "(rewritten, no change)" : changes.join("; ")}`
    }
    case "storage": {
      return `storage ${entry.plugin} ${entry.op} ${entry.name}`
    }
    case "open-external": {
      return `open-external ${entry.url}`
    }
    case "log": {
      return `log ${entry.level} ${entry.message}`
    }
    default: {
      return JSON.stringify(entry)
    }
  }
}

export function settingsChanges(
  before: string | undefined,
  after: string | undefined,
): Array<SettingsChange> {
  const a = new Map<string, unknown>()
  const b = new Map<string, unknown>()
  leafPaths(summarizeSettings(before), "", a)
  leafPaths(summarizeSettings(after), "", b)
  const changes: Array<SettingsChange> = []
  for (const key of new Set([...a.keys(), ...b.keys()])) {
    const was = a.get(key)
    const now = b.get(key)
    if (JSON.stringify(was) === JSON.stringify(now)) continue
    changes.push({
      path: key === "" ? "(file)" : key,
      ...(a.has(key) ? { before: was } : {}),
      ...(b.has(key) ? { after: now } : {}),
    })
  }
  return changes
}

const TEMP_FILE = /^\..*\.tmp$/

type Record_ = (entry: TranscriptEntry) => void

/** The settings/storage backend the host gets: real files, every write recorded. */
function recordingStorage(
  files: PluginStorageBackend,
  record: Record_,
  expectedSettings: Map<string, string | undefined>,
): PluginStorageBackend {
  return {
    dir: (id) => files.dir(id),
    readText: (id, name) => files.readText(id, name),
    async writeText(id, name, text) {
      if (name !== PLUGIN_SETTINGS_FILE) {
        record({ kind: "storage", plugin: id, op: "write", name })
        await files.writeText(id, name, text)
        return
      }
      const before = await files.readText(id, name).catch(() => undefined)
      await files.writeText(id, name, text)
      expectedSettings.set(id, text)
      record({
        kind: "settings",
        plugin: id,
        changes: settingsChanges(before, text),
      })
    },
    async delete(id, name) {
      record({ kind: "storage", plugin: id, op: "delete", name })
      await files.delete(id, name)
    },
  }
}

/** `ctx.host` that records log lines and `openExternal`. */
function recordingHost(
  options: LifecycleHarnessOptions,
  record: Record_,
  opened: Array<string>,
): HostServices {
  const log =
    (level: keyof PluginLogger) =>
    (message: string, ...args: Array<unknown>) => {
      const extra = args.map((arg) => errorMessage(arg)).join(" ")
      record({
        kind: "log",
        level,
        message: extra === "" ? message : `${message} ${extra}`,
      })
      options.logger?.[level](message, ...args)
    }
  return {
    appVersion: options.appVersion ?? "0.0.0-test",
    logger: {
      debug: log("debug"),
      info: log("info"),
      warn: log("warn"),
      error: log("error"),
    },
    async openExternal(url) {
      opened.push(url)
      record({ kind: "open-external", url })
      await options.openExternal?.(url)
    },
  }
}

/** Record cordis fiber transitions of the plugins' fibers; returns them per plugin. */
function watchFibers(
  internals: PluginHostInternals,
  ids: ReadonlySet<string>,
  record: Record_,
): Map<string, Array<Fiber>> {
  const ordinals = new WeakMap<object, number>()
  const fibers = new Map<string, Array<Fiber>>()
  internals.root.on("internal/status", (fiber: Fiber, old: number) => {
    const plugin = fiber.name
    if (!ids.has(plugin)) return
    let ordinal = ordinals.get(fiber)
    if (ordinal === undefined) {
      const list = fibers.get(plugin) ?? []
      list.push(fiber)
      fibers.set(plugin, list)
      ordinal = list.length
      ordinals.set(fiber, ordinal)
    }
    record({
      kind: "fiber",
      plugin,
      fiber: ordinal,
      from: fiberStateName(old),
      to: fiberStateName(fiber.state),
    })
  })
  return fibers
}

interface Seen {
  lifecycle: string
  status: string
  tools: Array<string>
  visible: Array<string>
}

const missing = (names: ReadonlyArray<string>, from: ReadonlyArray<string>) =>
  names.filter((name) => !from.includes(name))

/** On each gateway event: the event, then what it changed. */
class GatewayRecorder {
  readonly #gateway: PluginGateway
  readonly #internals: PluginHostInternals
  readonly #record: Record_
  readonly #seen = new Map<string, Seen>()

  constructor(
    gateway: PluginGateway,
    internals: PluginHostInternals,
    record: Record_,
  ) {
    this.#gateway = gateway
    this.#internals = internals
    this.#record = record
    gateway.subscribe((event) => {
      record({ kind: "event", plugin: event.pluginId, type: event.type })
      this.#changes(event.pluginId)
    })
  }

  #changes(plugin: string): void {
    const snapshot = this.#gateway.get(plugin)
    if (!snapshot) return
    let seen = this.#seen.get(plugin)
    if (!seen) {
      seen = { lifecycle: "", status: "null", tools: [], visible: [] }
      this.#seen.set(plugin, seen)
    }
    const lifecycle = `${snapshot.lifecycle}\0${snapshot.error ?? ""}`
    if (seen.lifecycle !== lifecycle) {
      seen.lifecycle = lifecycle
      this.#record({
        kind: "lifecycle",
        plugin,
        lifecycle: snapshot.lifecycle,
        ...(snapshot.error === undefined ? {} : { error: snapshot.error }),
      })
    }
    const status = this.#internals.runtime.status(plugin)
    const statusKey = JSON.stringify(status ?? null)
    if (seen.status !== statusKey) {
      seen.status = statusKey
      this.#record({
        kind: "status",
        plugin,
        status: status ? structuredClone(status) : null,
      })
    }
    this.#tools(plugin, seen)
  }

  #tools(plugin: string, seen: Seen): void {
    const tools = this.#internals.runtime.tools(plugin).map((tool) => tool.name)
    const registered = missing(tools, seen.tools)
    const withdrawn = missing(seen.tools, tools)
    seen.tools = tools
    if (registered.length > 0 || withdrawn.length > 0)
      this.#record({ kind: "tools", plugin, registered, withdrawn })
    // Registered tools minus blocked ones (`listTools` is also empty while
    // the plugin is not active, which is no permission change); what
    // registrations already explain is left out.
    const blocked = new Set(
      this.#gateway
        .toolViews(plugin)
        .filter((view) => view.permission === "block")
        .map((view) => view.name),
    )
    const visible = tools.filter((name) => !blocked.has(name))
    const shown = missing(missing(visible, seen.visible), registered)
    const hidden = missing(missing(seen.visible, visible), withdrawn)
    seen.visible = visible
    if (shown.length > 0 || hidden.length > 0)
      this.#record({ kind: "visible-tools", plugin, shown, hidden })
  }
}

const settle = () => new Promise<void>((resolve) => setImmediate(resolve))

class Harness implements LifecycleHarness {
  readonly gateway: PluginGateway
  readonly storageRoot: string
  readonly normalizer: Normalizer
  readonly opened: Array<string> = []
  readonly entries: Array<TranscriptEntry> = []
  readonly #createdRoot: boolean
  readonly #files: PluginStorageBackend
  readonly #internals: PluginHostInternals
  readonly #ids: ReadonlySet<string>
  readonly #fibers: Map<string, Array<Fiber>>
  readonly #expectedSettings = new Map<string, string | undefined>()
  readonly #settings: Record<string, PluginSettingsEntry> = {}
  #disposed: Promise<void> | undefined

  constructor(options: LifecycleHarnessOptions) {
    this.#createdRoot = options.storageRoot === undefined
    this.storageRoot =
      options.storageRoot
      ?? mkdtempSync(path.join(os.tmpdir(), "plugin-harness-"))
    this.normalizer = options.normalizer ?? new Normalizer()
    for (const secret of options.secrets ?? []) this.normalizer.secret(secret)
    const { entries } = this
    const record: Record_ = (entry) => {
      entries.push(entry)
    }
    this.#files = createFileStorage(this.storageRoot)
    this.gateway = createPluginHost({
      plugins: options.plugins,
      services: {
        storageRoot: this.storageRoot,
        storage: recordingStorage(this.#files, record, this.#expectedSettings),
        host: recordingHost(options, record, this.opened),
      },
    })
    const internals = pluginHostInternals(this.gateway)
    if (!internals)
      throw new Error("createLifecycleHarness: not a plugin host.")
    this.#internals = internals
    this.#ids = new Set(options.plugins.map((plugin) => plugin.name))
    this.#fibers = watchFibers(internals, this.#ids, record)
    new GatewayRecorder(this.gateway, internals, record)
  }

  transcript(
    options: { since?: number; kinds?: ReadonlyArray<TranscriptKind> } = {},
  ): Array<TranscriptEntry> {
    const { since = 0, kinds } = options
    return this.entries
      .slice(since)
      .filter((entry) => !kinds || kinds.includes(entry.kind))
      .map((entry) => this.normalizer.value(entry))
  }

  mark(): number {
    return this.entries.length
  }

  step(name: string): void {
    this.entries.push({ kind: "step", name })
  }

  async enable(
    id: string,
    entry: Omit<PluginSettingsEntry, "enabled"> = {},
  ): Promise<void> {
    this.#settings[id] = { ...this.#settings[id], ...entry, enabled: true }
    await this.reconcile()
  }

  async disable(id: string): Promise<void> {
    this.#settings[id] = { ...this.#settings[id], enabled: false }
    await this.reconcile()
  }

  reconcile(): Promise<void> {
    const settings: PluginSettings = structuredClone(this.#settings)
    return this.gateway.reconcile(settings)
  }

  setConfig(id: string, config: unknown): Promise<void> {
    return this.gateway.updateConfig(id, config)
  }

  setPermissions(
    id: string,
    changes: Record<string, ToolPermission | null>,
  ): Promise<void> {
    return this.gateway.setToolPermissions(id, changes)
  }

  runAction(id: string, actionId: string): Promise<void> {
    return this.gateway.runAction(id, actionId)
  }

  importLegacyConfig(id: string, config: unknown): Promise<boolean> {
    return this.gateway.importLegacyConfig(id, config)
  }

  async seedSettings(id: string, document: unknown): Promise<void> {
    const text =
      typeof document === "string" ? document : JSON.stringify(document)
    await this.#files.writeText(id, PLUGIN_SETTINGS_FILE, text)
    this.#expectedSettings.set(id, text)
  }

  async flush(): Promise<void> {
    for (let round = 0; round < 3; round++) {
      await this.#internals.idle()
      for (const id of this.#ids)
        await this.#internals
          .fiber(id)
          ?.await()
          .catch(() => undefined)
      for (let i = 0; i < 5; i++) await settle()
    }
    await this.#internals.idle()
  }

  async waitFor(
    predicate: () => boolean | Promise<boolean>,
    wait: WaitOptions = {},
  ): Promise<void> {
    const deadline = Date.now() + (wait.timeoutMs ?? 5000)
    while (!(await predicate())) {
      if (Date.now() >= deadline) {
        const tail = this.entries
          .slice(-8)
          .map((entry) => JSON.stringify(this.normalizer.value(entry)))
          .join("\n  ")
        throw new Error(
          `${wait.message ?? "waitFor: condition not met before timeout"}\n  last transcript entries:\n  ${tail}`,
        )
      }
      await new Promise((resolve) => setTimeout(resolve, wait.intervalMs ?? 5))
    }
  }

  async waitForStatus(
    id: string,
    code: string | ((status: PluginStatus | undefined) => boolean),
    wait: WaitOptions = {},
  ): Promise<PluginStatus | undefined> {
    const matches =
      typeof code === "string" ?
        (status: PluginStatus | undefined) => status?.code === code
      : code
    const describe = () => {
      const snapshot = this.gateway.get(id)
      return `waitForStatus(${id}): ${typeof code === "string" ? code : "predicate"} not reached (status ${snapshot?.status?.code ?? "none"}, ${snapshot?.lifecycle ?? "?"})`
    }
    await this.waitFor(() => matches(this.gateway.get(id)?.status), {
      message: describe(),
      ...wait,
    })
    return this.gateway.get(id)?.status
  }

  async waitForEntry(
    predicate: (entry: TranscriptEntry) => boolean,
    wait: WaitOptions & { since?: number } = {},
  ): Promise<TranscriptEntry> {
    let found: TranscriptEntry | undefined
    await this.waitFor(() => {
      found = this.entries
        .slice(wait.since ?? 0)
        .find((entry) => predicate(entry))
      return found !== undefined
    }, wait)
    return found as TranscriptEntry
  }

  snapshot(id: string): PluginSnapshot {
    const snapshot = this.gateway.get(id)
    if (!snapshot) throw new Error(`Unknown plugin "${id}".`)
    return snapshot
  }

  contributions(id: string): PluginContributions {
    const { runtime } = this.#internals
    return {
      attached: runtime.isAttached(id),
      tools: runtime.tools(id).map((tool) => tool.name),
      actions: runtime.actionIds(id),
      status: runtime.status(id),
    }
  }

  fiber(id: string): Fiber | undefined {
    return this.#internals.fiber(id)
  }

  effects(id: string): Array<string> {
    return (
      this.#internals
        .fiber(id)
        ?.getEffects()
        .map((effect) => effect.label) ?? []
    )
  }

  rootEffects(): Array<string> {
    return this.#internals.root.fiber.getEffects().map((effect) => effect.label)
  }

  fibers(id: string): Array<{ fiber: number; state: FiberStateName }> {
    return (this.#fibers.get(id) ?? []).map((fiber, index) => ({
      fiber: index + 1,
      state: fiberStateName(fiber.state),
    }))
  }

  settingsText(id: string): string | undefined {
    try {
      return readFileSync(
        path.join(this.storageRoot, id, PLUGIN_SETTINGS_FILE),
        "utf8",
      )
    } catch {
      return undefined
    }
  }

  settings(id: string): Record<string, unknown> | undefined {
    const text = this.settingsText(id)
    if (text === undefined) return undefined
    return JSON.parse(text) as Record<string, unknown>
  }

  settingsTamperedWith(id: string): boolean {
    return this.settingsText(id) !== this.#expectedSettings.get(id)
  }

  files(id: string): Array<string> {
    try {
      return readdirSync(path.join(this.storageRoot, id))
        .filter((name) => !TEMP_FILE.test(name))
        .sort()
    } catch {
      return []
    }
  }

  secretsSeen(): Array<{ secret: string; entry: TranscriptEntry }> {
    const secrets = this.normalizer.secrets
    return this.entries.flatMap((entry) =>
      findSecrets(entry, secrets).map((secret) => ({ secret, entry })),
    )
  }

  dispose(): Promise<void> {
    this.#disposed ??= (async () => {
      await this.gateway.dispose()
      if (this.#createdRoot)
        rmSync(this.storageRoot, { recursive: true, force: true })
    })()
    return this.#disposed
  }
}

/**
 * Build a host for `plugins` and start recording. Nothing is enabled yet:
 * call `enable(id)` (or `reconcile`). `dispose()` stops the host and
 * removes a temp storage root it created.
 */
export function createLifecycleHarness(
  options: LifecycleHarnessOptions,
): LifecycleHarness {
  return new Harness(options)
}
