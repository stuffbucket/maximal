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
} from "@stuffbucket/maximal-figjam-plugin/build"
import path from "node:path"

import type { FigjamConfig } from "./manifest"

import {
  composeStatus,
  displayName,
  pairActionIds,
  type PluginFolder,
  RETRY_ACTION,
  SETUP_ACTION,
  type StartFailure,
} from "./status"

/** Folder inside the plugin's storage that holds the Figma development plugin. */
export const FIGMA_PLUGIN_DIR = "figma-plugin"

/** Seams for tests. Production uses the defaults. */
export interface FigjamPluginOptions {
  /** Where the bridge keeps its files (default: Maximal's data directory). */
  dataDir?: string
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

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error)

function lifecycleAborted(context?: PluginLifecycleContext): boolean {
  return context?.signal.aborted === true
}

function describeStartFailure(error: unknown, port: number): StartFailure {
  const message = errorMessage(error)
  if (/EADDRINUSE|in use/i.test(message)) {
    return {
      code: "port-in-use",
      summary: `Port ${port} is already in use`,
      detail: `Another program is listening on port ${port}, possibly a FigJam bridge started with "bun run figjam:bridge". Stop it, or choose another bridge port in this plugin's settings.`,
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
  readonly #requests = new Map<string, PairRequest>()
  #tail: Promise<void> = Promise.resolve()
  #handle: BridgeHandle | undefined
  #startFailure: StartFailure | undefined
  #folder: PluginFolder = "missing"
  #building = false
  #buildError: string | undefined
  #disposed = false

  constructor(
    ctx: Context,
    config: FigjamConfig,
    options: FigjamPluginOptions,
  ) {
    this.#ctx = ctx
    this.#config = config
    this.#options = options
    this.#pluginDir = path.join(ctx.storage.dir, FIGMA_PLUGIN_DIR)
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
      const { dataDir } = this.#options
      const started = await startBridge({
        port: this.#config.port,
        ...(dataDir === undefined ? {} : { dataDir }),
        onEvent: (event) => this.#onEvent(event),
      })
      if (this.#shouldStop(context)) {
        await started.stop()
        context?.signal.throwIfAborted()
        return
      }
      this.#handle = started
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
   * and ports are unchanged.
   */
  async #checkFolder(): Promise<void> {
    try {
      this.#folder = await inspectPlugin(this.#pluginDir, this.#buildOptions())
    } catch (error) {
      this.#ctx.host.logger.warn(
        `Could not check the Figma plugin: ${errorMessage(error)}`,
      )
      return
    }
    if (this.#folder === "stale") await this.#build()
  }

  /** The ports the generated plugin must name, for building and for checking. */
  #buildOptions(): { bridgePort: number; maximalPort: number } {
    return {
      bridgePort: this.#handle?.port ?? this.#config.port,
      maximalPort: this.#ctx.host.maximalPort(),
    }
  }

  async #build(): Promise<void> {
    if (this.#building || this.#disposed) return
    this.#building = true
    this.#buildError = undefined
    this.#render()
    try {
      await buildPlugin({ outDir: this.#pluginDir, ...this.#buildOptions() })
      this.#folder = "current"
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
    if (event.type === "pair-requested" && !this.#requests.has(event.name)) {
      this.#notify(event.name)
    }
    try {
      this.#sync()
    } catch (error) {
      this.#ctx.host.logger.warn(
        `Could not refresh the FigJam status: ${errorMessage(error)}`,
      )
    }
  }

  #notify(name: string): void {
    const shown = displayName(name)
    try {
      this.#ctx.surface.notify({
        code: "figjam-pair-requested",
        message: `A FigJam panel ("${shown}") wants to connect.`,
        params: { name: shown },
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
    this.#ctx.surface.setStatus(
      composeStatus({
        startFailure: this.#startFailure,
        bridge:
          this.#handle && view ?
            {
              port: this.#handle.port,
              boards: view.boards.map((board) => {
                const title: unknown = Reflect.get(board, "name")
                return typeof title === "string" && title !== "" ?
                    title
                  : board.id
              }),
              pending: view.pending.map((request) => request.name),
            }
          : undefined,
        building: this.#building,
        folder: this.#folder,
        buildError: this.#buildError,
        manifestPath: path.join(this.#pluginDir, "manifest.json"),
        pairActions: this.#pairActions(),
      }),
    )
  }
}
