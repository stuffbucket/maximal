import type {
  BridgeEvent,
  BridgeHandle,
} from "@stuffbucket/maximal-figjam-bridge/server"
import type {
  Context,
  PluginDisposer,
  PluginLifecycleContext,
  PluginStatusAction,
} from "@stuffbucket/maximal-plugin-sdk"

import { startBridge } from "@stuffbucket/maximal-figjam-bridge/server"
import {
  buildPlugin,
  inspectPlugin,
  pluginIdentity,
  type PluginBuildOptions,
} from "@stuffbucket/maximal-figjam-plugin/build"
import path from "node:path"

import type { FigjamConfig } from "./manifest"

import {
  type FigjamProfile,
  isVerbose,
  pluginProfileId,
  resolveProfile,
} from "./profile"
import { generationRelayKey } from "./relay-key"
import {
  composeStatus,
  displayName,
  pairActionIds,
  type PendingPanel,
  type PluginFolder,
  RETRY_ACTION,
  SETUP_ACTION,
  type StartFailure,
  toPluginActivity,
} from "./status"

/** Folder inside the plugin's storage that holds the Figma development plugin. */
export const FIGMA_PLUGIN_DIR = "figma-plugin"

/** Seams for tests. Production uses the defaults. */
export interface FigjamPluginOptions {
  /** Where the bridge keeps its files (default: Maximal's data directory). */
  dataDir?: string
  /** Which Maximal this is (default: from `MAXIMAL_INSTANCE_ID`). */
  profile?: FigjamProfile
  /** How many ports the bridge tries from the configured one (default: its own). */
  portAttempts?: number
}

interface PairRequest {
  label: string
  approveId: string
  denyId: string
  dispose: PluginDisposer
}

// The bridge keeps its state at module level, so one runs per process. A
// reload starts the new bridge only after the old one has let go of its port.
let previousStop: Promise<void> = Promise.resolve()

/** Tool events arrive in bursts; the status follows them at most this often. */
const ACTIVITY_RENDER_MS = 250

// One relay key per owning Maximal process, in memory only (see relay-key.ts).
// Every bridge this generation starts uses it, so a Retry, a config reload or
// a resumed handoff keeps the panels already written working, and the next
// generation (a plugin inventory or settings reload) inherits the same key
// from the parent. Only a new owning process (Maximal restarted) makes a new
// key and rewrites the plugin. The copy stamped into the plugin folder opens
// nothing once that process ends.
let processRelayKey: string | undefined
const relayKey = (): string => (processRelayKey ??= generationRelayKey())

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error)

function lifecycleAborted(context?: PluginLifecycleContext): boolean {
  return context?.signal.aborted === true
}

function describeStartFailure(error: unknown, port: number): StartFailure {
  const message = errorMessage(error)
  if (/EADDRINUSE|in use/i.test(message)) {
    // The bridge already walked upward from `port`, so every candidate was taken.
    return {
      code: "port-in-use",
      summary: `No free port from ${port} up`,
      detail: `${message} Another program is listening on each of them, possibly FigJam bridges started with "bun run figjam:bridge". Stop one, or choose another bridge port in this plugin's settings.`,
    }
  }
  return {
    code: "start-failed",
    summary: "The FigJam bridge could not start",
    detail: message,
  }
}

/**
 * One running FigJam plugin: the bridge, the Figma plugin files, the pending
 * pairing requests (each with its own Approve and Deny actions) and the
 * status that shows them.
 */
export class FigjamController {
  readonly #ctx: Context
  readonly #config: FigjamConfig
  readonly #options: FigjamPluginOptions
  readonly #pluginDir: string
  readonly #profile: FigjamProfile
  readonly #verbose: boolean
  readonly #requests = new Map<string, PairRequest>()
  #tail: Promise<void> = Promise.resolve()
  #handle: BridgeHandle | undefined
  #startFailure: StartFailure | undefined
  #folder: PluginFolder = "missing"
  #building = false
  #buildError: string | undefined
  #disposed = false
  #activityTimer: ReturnType<typeof setTimeout> | undefined

  constructor(
    ctx: Context,
    config: FigjamConfig,
    options: FigjamPluginOptions,
  ) {
    this.#ctx = ctx
    this.#config = config
    this.#options = options
    this.#profile = options.profile ?? resolveProfile()
    this.#verbose = isVerbose(this.#profile)
    this.#pluginDir = path.join(ctx.storage.dir, FIGMA_PLUGIN_DIR)
  }

  /**
   * Development detail (binds, pairing transitions, why a folder is stale).
   * A production Maximal keeps it at debug level, which is normally dropped;
   * warnings and errors are logged the same everywhere. Never pass a token.
   */
  #note(message: string): void {
    const { logger } = this.#ctx.host
    if (this.#verbose) logger.info(message)
    else logger.debug(message)
  }

  /** Register actions and status without acquiring the exclusive bridge port. */
  start(): void {
    this.#ctx.effect(
      // eslint-disable-next-line unicorn/consistent-function-scoping -- cleanup captures this controller
      () => () => {
        void this.dispose()
      },
      "figjam bridge",
    )
    this.#ctx.surface.registerAction(SETUP_ACTION, () => this.#build())
    this.#ctx.surface.registerAction(RETRY_ACTION, async () => {
      if (this.#handle || this.#disposed) return
      await this.bind()
    })
    this.#render()
  }

  /** Bind the bridge after the parent has granted this generation its lease. */
  bind(context?: PluginLifecycleContext): Promise<void> {
    return this.#enqueue(async () => {
      if (this.#handle || this.#disposed) return
      try {
        await this.#launch(context)
      } catch (error) {
        // Initial activation remains operable so the person can free the port
        // and use Try again. Handoff and recovery must prove readiness.
        if (context?.purpose !== "activation") throw error
      }
    })
  }

  /** Stop the physical bridge and resolve only after the port is released. */
  unbind(context?: PluginLifecycleContext): Promise<void> {
    return this.#enqueue(async () => {
      context?.signal.throwIfAborted()
      const handle = this.#handle
      if (!handle) return
      const stopping = previousStop.then(() => handle.stop())
      previousStop = stopping.catch(() => undefined)
      try {
        await stopping
      } catch (error) {
        this.#ctx.host.logger.warn(
          `The FigJam bridge did not stop cleanly: ${errorMessage(error)}`,
        )
        throw error
      }
      if (this.#handle === handle) this.#handle = undefined
      clearTimeout(this.#activityTimer)
      this.#activityTimer = undefined
      for (const request of this.#requests.values()) request.dispose()
      this.#requests.clear()
      this.#render()
    })
  }

  /** Permanently dispose this controller after the lifecycle has been revoked. */
  async dispose(): Promise<void> {
    this.#disposed = true
    await this.unbind()
  }

  async #launch(context?: PluginLifecycleContext): Promise<void> {
    this.#startFailure = undefined
    this.#render()
    try {
      await previousStop
      context?.signal.throwIfAborted()
      if (this.#disposed) return
      const { dataDir, portAttempts } = this.#options
      const started = await startBridge({
        port: this.#config.port,
        relayKey: relayKey(),
        ...(dataDir === undefined ? {} : { dataDir }),
        ...(portAttempts === undefined ? {} : { portAttempts }),
        ...(this.#verbose ? { verbose: true } : {}),
        onEvent: (event) => this.#onEvent(event),
      })
      if (this.#shouldStop(context)) {
        await started.stop()
        context?.signal.throwIfAborted()
        return
      }
      this.#handle = started
      if (started.port === started.preferredPort) {
        this.#note(
          `The FigJam bridge is listening on 127.0.0.1:${started.port} (profile ${this.#profile.id}).`,
        )
      } else {
        // Worth saying everywhere: the status shows the port to point the CLI at.
        this.#ctx.host.logger.info(
          `The FigJam bridge's port ${started.preferredPort} was taken, so it is listening on 127.0.0.1:${started.port} (profile ${this.#profile.id}).`,
        )
      }
    } catch (error) {
      this.#startFailure = describeStartFailure(error, this.#config.port)
      this.#ctx.host.logger.warn(
        `The FigJam bridge did not start: ${this.#startFailure.detail}`,
      )
      this.#render()
      throw error
    }
    await this.#checkFolder()
    this.#sync()
  }

  #shouldStop(context?: PluginLifecycleContext): boolean {
    return this.#disposed || lifecycleAborted(context)
  }

  #enqueue(task: () => Promise<void>): Promise<void> {
    const run = this.#tail.then(task, task)
    this.#tail = run.catch(() => undefined)
    return run
  }

  /**
   * Learn what the plugin folder holds, and bring a stale one up to date. The
   * managed files are compared byte for byte with what a build would write,
   * so a source, manifest or security change rebuilds even when the version
   * and ports are unchanged, and so does a folder holding another process's
   * relay key.
   */
  async #checkFolder(): Promise<void> {
    try {
      this.#folder = await inspectPlugin(this.#pluginDir, this.#buildOptions())
      if (this.#folder !== "current") {
        this.#note(
          `The Figma plugin folder is ${this.#folder}: ${this.#pluginDir}`,
        )
      }
    } catch (error) {
      this.#ctx.host.logger.warn(
        `Could not check the Figma plugin: ${errorMessage(error)}`,
      )
      return
    }
    if (this.#folder === "stale") await this.#build()
  }

  /**
   * The options the generated plugin is built with. The start-time check and
   * every build (start or manual) both read this, so a folder is judged
   * against exactly what a rebuild would write. The bridge's port is not one
   * of them: the panel reaches the bridge through Maximal (`/figjam/plugin`),
   * so a bridge that moves ports never changes, or rebuilds, the plugin.
   */
  #buildOptions(): PluginBuildOptions {
    const profile = pluginProfileId(this.#profile)
    return {
      maximalPort: this.#ctx.host.maximalPort(),
      relayKey: relayKey(),
      ...(profile === undefined ? {} : { profile }),
    }
  }

  /** The name Figma lists this profile's development plugin under. */
  #pluginName(): string {
    const { profile } = this.#buildOptions()
    return pluginIdentity({ release: false, profile: profile ?? "" }).name
  }

  async #build(): Promise<void> {
    if (this.#building || this.#disposed) return
    this.#building = true
    this.#buildError = undefined
    this.#render()
    try {
      const options = this.#buildOptions()
      await buildPlugin({ outDir: this.#pluginDir, ...options })
      this.#folder = "current"
      this.#note(
        `Built the Figma plugin (${this.#pluginName()}; allows only Maximal at localhost:${options.maximalPort}) in ${this.#pluginDir}`,
      )
    } catch (error) {
      this.#buildError = errorMessage(error)
      this.#ctx.host.logger.error(
        `Could not build the Figma plugin: ${this.#buildError}`,
      )
    } finally {
      this.#building = false
      this.#render()
    }
  }

  #onEvent(event: BridgeEvent): void {
    if (this.#disposed) return
    this.#logEvent(event)
    if (event.type === "tool-started" || event.type === "tool-finished") {
      this.#renderActivitySoon()
      return
    }
    if (event.type === "pair-requested" && !this.#requests.has(event.name)) {
      this.#notify(event)
    }
    try {
      this.#sync()
    } catch (error) {
      this.#ctx.host.logger.warn(
        `Could not refresh the FigJam status: ${errorMessage(error)}`,
      )
    }
  }

  /** Show tool use in the status, folding a burst of calls into one update. */
  #renderActivitySoon(): void {
    if (this.#activityTimer !== undefined) return
    this.#activityTimer = setTimeout(() => {
      this.#activityTimer = undefined
      this.#render()
    }, ACTIVITY_RENDER_MS)
  }

  /** Pairing and connection transitions, by panel name only (no tokens, no ids). */
  #logEvent(event: BridgeEvent): void {
    if (event.type === "tool-started" || event.type === "tool-finished") return
    const name = displayName(event.name)
    // eslint-disable-next-line default-case -- exhaustive over non-tool BridgeEvent
    switch (event.type) {
      case "pair-requested": {
        this.#note(`FigJam panel "${name}" asked to pair.`)
        break
      }
      case "paired": {
        this.#note(`FigJam panel "${name}" is paired.`)
        break
      }
      case "pair-denied": {
        this.#note(`FigJam panel "${name}" was denied.`)
        break
      }
      case "pair-expired": {
        // A request nobody answered: the person may have missed it.
        this.#ctx.host.logger.warn(
          `FigJam panel "${name}" asked to pair, but nobody approved it in time.`,
        )
        break
      }
      case "board-connected": {
        this.#note(`FigJam panel "${name}" connected.`)
        break
      }
      case "board-disconnected": {
        this.#note(`FigJam panel "${name}" disconnected.`)
        break
      }
    }
  }

  #notify(event: { name: string; board?: string }): void {
    const shown = displayName(event.name)
    const board =
      event.board === undefined ? undefined : displayName(event.board)
    try {
      this.#ctx.surface.notify({
        code: "figjam-pair-requested",
        message: `A FigJam panel ("${shown}")${board === undefined ? "" : ` on board "${board}"`} wants to connect.`,
        params: { name: shown, ...(board === undefined ? {} : { board }) },
      })
    } catch (error) {
      this.#ctx.host.logger.warn(
        `Could not raise a notification: ${errorMessage(error)}`,
      )
    }
  }

  /** Make the actions match the bridge's pending requests, then show the status. */
  #sync(): void {
    if (this.#disposed) return
    if (this.#handle) {
      const pending = new Set(
        this.#handle.status().pending.map((request) => request.name),
      )
      for (const [name, request] of this.#requests) {
        if (pending.has(name)) continue
        request.dispose()
        this.#requests.delete(name)
      }
      for (const name of pending) {
        if (!this.#requests.has(name)) this.#track(name)
      }
    }
    this.#render()
  }

  /** Give a waiting panel its own Approve and Deny actions. */
  #track(name: string): void {
    const { approveId, denyId } = pairActionIds(name)
    const { surface } = this.#ctx
    const disposers = [
      surface.registerAction(approveId, () => this.#decide("approve", name)),
      surface.registerAction(denyId, () => this.#decide("deny", name)),
    ]
    this.#requests.set(name, {
      label: displayName(name),
      approveId,
      denyId,
      dispose: () => {
        for (const dispose of disposers) dispose()
      },
    })
  }

  async #decide(verdict: "approve" | "deny", name: string): Promise<void> {
    try {
      const result = await this.#handle?.[verdict](name)
      if (result && !result.ok) {
        this.#ctx.host.logger.warn(
          `Could not ${verdict} FigJam panel "${displayName(name)}".`,
        )
      }
    } finally {
      this.#sync()
    }
  }

  #pairActions(): Array<PluginStatusAction> {
    return [...this.#requests.values()].flatMap((request) => [
      {
        id: request.approveId,
        label: `Approve "${request.label}"`,
        kind: "primary" as const,
      },
      {
        id: request.denyId,
        label: `Deny "${request.label}"`,
        kind: "secondary" as const,
      },
    ])
  }

  #render(): void {
    if (this.#disposed) return
    const view = this.#handle?.status()
    const status = composeStatus({
      startFailure: this.#startFailure,
      bridge:
        this.#handle && view ?
          {
            port: this.#handle.port,
            preferredPort: this.#handle.preferredPort,
            boards: view.boards.map((board) => {
              const title: unknown = Reflect.get(board, "name")
              return typeof title === "string" && title !== "" ?
                  title
                : board.id
            }),
            pending: view.pending.map(
              (request): PendingPanel => ({
                name: request.name,
                board: request.board,
                fileKey: request.fileKey,
                user: request.user,
              }),
            ),
          }
        : undefined,
      building: this.#building,
      folder: this.#folder,
      buildError: this.#buildError,
      manifestPath: path.join(this.#pluginDir, "manifest.json"),
      pluginName: this.#pluginName(),
      pairActions: this.#pairActions(),
    })
    const activity = view ? toPluginActivity(view.activity) : undefined
    this.#ctx.surface.setStatus(activity ? { ...status, activity } : status)
  }
}
