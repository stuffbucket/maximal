import type {
  BridgeEvent,
  BridgeHandle,
} from "@stuffbucket/maximal-figjam-bridge/server"
import type {
  Context,
  PluginDisposer,
  PluginStatusAction,
} from "@stuffbucket/maximal-plugin-sdk"

import { startBridge } from "@stuffbucket/maximal-figjam-bridge/server"
import {
  buildPlugin,
  readPackageVersion,
} from "@stuffbucket/maximal-figjam-plugin/build"
import { readFile } from "node:fs/promises"
import path from "node:path"

import type { FigjamConfig } from "./manifest"

import {
  composeStatus,
  displayName,
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

/** Whether the files in `dir` exist and match this build and these ports. */
async function inspectFolder(
  dir: string,
  ports: { bridge: number; maximal: number },
): Promise<PluginFolder> {
  const read = (name: string) => readFile(path.join(dir, name), "utf8")
  let manifest: string
  let code: string
  try {
    const [manifestText, codeText] = await Promise.all([
      read("manifest.json"),
      read("code.js"),
      read("ui.html"),
    ])
    manifest = manifestText
    code = codeText
  } catch {
    return "missing"
  }
  // The manifest names both ports in its dev domains, and code.js its version.
  const expected = [
    `ws://localhost:${ports.bridge}`,
    `http://localhost:${ports.maximal}`,
  ].map((domain) => JSON.stringify(domain))
  const version = await readPackageVersion()
  const current =
    code.includes(`var PLUGIN_VERSION = ${JSON.stringify(version)}`)
    && expected.every((domain) => manifest.includes(domain))
  return current ? "current" : "stale"
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
  readonly #waitFor = previousStop
  readonly #requests = new Map<string, PairRequest>()
  #starting: Promise<BridgeHandle | undefined> = Promise.resolve(undefined)
  #handle: BridgeHandle | undefined
  #startFailure: StartFailure | undefined
  #folder: PluginFolder = "missing"
  #building = false
  #buildError: string | undefined
  #sequence = 0
  #stopped = false

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

  // A method, not a field read: `stop()` can run while a start is awaited.
  #isStopped(): boolean {
    return this.#stopped
  }

  /** Register the plugin's actions and start the bridge in the background. */
  start(): void {
    this.#ctx.effect(() => this.stop, "figjam bridge")
    this.#ctx.surface.registerAction(SETUP_ACTION, () => this.#build())
    this.#ctx.surface.registerAction(RETRY_ACTION, async () => {
      if (this.#handle || this.#stopped) return
      this.#starting = this.#launch()
      await this.#starting
    })
    this.#starting = this.#launch()
  }

  /** Drop the actions and stop the bridge once any start in flight has finished. */
  readonly stop = (): void => {
    this.#stopped = true
    for (const request of this.#requests.values()) request.dispose()
    this.#requests.clear()
    this.#handle = undefined
    const starting = this.#starting
    previousStop = previousStop.then(async () => {
      try {
        await (await starting)?.stop()
      } catch (error) {
        this.#ctx.host.logger.warn(
          `The FigJam bridge did not stop cleanly: ${errorMessage(error)}`,
        )
      }
    })
  }

  async #launch(): Promise<BridgeHandle | undefined> {
    this.#startFailure = undefined
    this.#render()
    try {
      await this.#waitFor
      if (this.#isStopped()) return undefined
      const { dataDir } = this.#options
      const started = await startBridge({
        port: this.#config.port,
        ...(dataDir === undefined ? {} : { dataDir }),
        onEvent: (event) => this.#onEvent(event),
      })
      this.#handle = started
      if (this.#isStopped()) return started
    } catch (error) {
      this.#startFailure = describeStartFailure(error, this.#config.port)
      this.#ctx.host.logger.warn(
        `The FigJam bridge did not start: ${this.#startFailure.detail}`,
      )
      this.#render()
      return undefined
    }
    await this.#checkFolder()
    this.#sync()
    return this.#handle
  }

  /** Learn what the plugin folder holds, and bring a stale one up to date. */
  async #checkFolder(): Promise<void> {
    try {
      this.#folder = await inspectFolder(this.#pluginDir, {
        bridge: this.#config.port,
        maximal: this.#config.maximalPort,
      })
    } catch (error) {
      this.#ctx.host.logger.warn(
        `Could not check the Figma plugin: ${errorMessage(error)}`,
      )
      return
    }
    if (this.#folder === "stale") await this.#build()
  }

  async #build(): Promise<void> {
    if (this.#building || this.#stopped) return
    this.#building = true
    this.#buildError = undefined
    this.#render()
    try {
      await buildPlugin({
        outDir: this.#pluginDir,
        bridgePort: this.#handle?.port ?? this.#config.port,
        maximalPort: this.#config.maximalPort,
      })
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
    if (this.#stopped) return
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
    if (this.#stopped) return
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
    this.#sequence += 1
    const approveId = `approve-${this.#sequence}`
    const denyId = `deny-${this.#sequence}`
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
    if (this.#stopped) return
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
