import type { JsonValue } from "@stuffbucket/maximal-plugin-protocol"

import { releaseUpstreamSession } from "@stuffbucket/maximal-connector-kit"
import {
  reverifyGenerationSelectionForRunner,
  type GenerationModuleDescriptor,
} from "@stuffbucket/maximal-plugin-loader"
import { validatePluginModule } from "@stuffbucket/maximal-plugin-sdk/runtime"
import { createHash } from "node:crypto"
import { readFile } from "node:fs/promises"
import path from "node:path"
import { pathToFileURL } from "node:url"

import type { IpcPort } from "~/lib/plugins/transport/ipc"

import type {
  GenerationSelection,
  GenerationVerifier,
  RunnerChannel,
  RunnerHealthEntry,
  RunnerInventoryComposer,
  RunnerInventoryRoot,
  VerifiedRunnerGeneration,
} from "./contracts"

import { RELEASE_UPSTREAM_SESSION_METHOD } from "../generation-lifecycle"
import { currentPluginGenerationCompatibility } from "../generations"
import { DuplexRpcDispatcher } from "../transport/dispatcher"
import { BunIpcTransport } from "../transport/ipc"
import {
  RUNNER_NONCE_ENV,
  RUNNER_PARENT_PID_ENV,
  RUNNER_SELECTION_ENV,
} from "./command"
import {
  createReverseServices,
  gatewayProjection,
  registerRunnerGateway,
} from "./rpc"
import { runPluginRunner } from "./runner"
import { decodeGenerationSelection } from "./selection"

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

function isTransportMessage(value: unknown): boolean {
  if (!isRecord(value)) return false
  return (
    value.tag === "maximal-plugin-handshake"
    || (typeof value.protocol === "number"
      && typeof value.generation === "string"
      && typeof value.id === "string")
  )
}

class ChildTransportPort implements IpcPort {
  readonly #messages = new Set<(message: unknown) => void>()
  readonly #disconnects = new Set<() => void>()

  constructor() {
    process.on("message", (message) => {
      if (!isTransportMessage(message)) return
      for (const listener of this.#messages) listener(message)
    })
    process.once("disconnect", () => {
      for (const listener of this.#disconnects) listener()
    })
  }

  send(message: unknown): boolean {
    if (!process.send) throw new Error("Plugin runner IPC is disconnected.")
    process.send(message)
    return true
  }

  onMessage(listener: (message: unknown) => void): () => void {
    this.#messages.add(listener)
    return () => this.#messages.delete(listener)
  }

  onDisconnect(listener: () => void): () => void {
    this.#disconnects.add(listener)
    return () => this.#disconnects.delete(listener)
  }

  disconnect(): void {
    process.disconnect?.()
  }
}

class ChildProcessRunnerChannel implements RunnerChannel {
  readonly #messages = new Set<(message: unknown) => void>()
  readonly #close = new Set<() => void>()
  #closed = false

  constructor() {
    process.on("message", (message) => {
      if (
        !isRecord(message)
        || typeof message.type !== "string"
        || !message.type.startsWith("supervisor.")
      )
        return
      for (const listener of this.#messages) listener(message)
    })
    process.once("disconnect", () => this.#notifyClose())
  }

  send(message: Parameters<RunnerChannel["send"]>[0]): void {
    if (!process.send)
      throw new Error("Plugin runner requires an authenticated IPC parent.")
    process.send(message)
  }

  subscribe(listener: (message: unknown) => void): () => void {
    this.#messages.add(listener)
    return () => this.#messages.delete(listener)
  }

  onClose(listener: () => void): () => void {
    this.#close.add(listener)
    return () => this.#close.delete(listener)
  }

  close(): void {
    this.#notifyClose()
  }

  #notifyClose(): void {
    if (this.#closed) return
    this.#closed = true
    for (const listener of this.#close) listener()
    this.#close.clear()
    this.#messages.clear()
  }
}

function selectedModule(
  namespace: unknown,
  descriptor: GenerationModuleDescriptor,
): unknown {
  if (descriptor.export === undefined) return namespace
  if (
    namespace === null
    || (typeof namespace !== "object" && typeof namespace !== "function")
    || !Object.hasOwn(namespace, descriptor.export)
  )
    throw new Error(`Verified plugin ${descriptor.pluginId} lost its export.`)
  return Reflect.get(namespace, descriptor.export)
}

/** Exact Phase 4 verifier. It returns the same objects whose bytes it verified. */
export class ImmutableGenerationVerifier implements GenerationVerifier {
  async reverifyImmediatelyBeforeLoad(
    selection: GenerationSelection,
    signal: AbortSignal,
  ): Promise<VerifiedRunnerGeneration> {
    const modules = new Map<string, unknown>()
    const identities = new Map(
      selection.token.artifacts.map((identity) => [
        path.resolve(selection.token.directory, identity.artifact),
        identity,
      ]),
    )
    const prepared = await reverifyGenerationSelectionForRunner({
      token: selection.token,
      expected: currentPluginGenerationCompatibility(),
      trustedRoot: selection.token.directory,
      importModule: async (artifact) => {
        signal.throwIfAborted()
        const identity = identities.get(path.resolve(artifact))
        if (!identity)
          throw new Error("Runner attempted to load an unselected artifact.")
        const bytes = new Uint8Array(await readFile(artifact))
        const sha256 = createHash("sha256").update(bytes).digest("hex")
        if (bytes.byteLength !== identity.bytes || sha256 !== identity.sha256)
          throw new Error("Runner artifact changed immediately before import.")
        signal.throwIfAborted()
        const namespace: unknown = await import(
          `${pathToFileURL(artifact).href}?generation=${selection.token.generationId}`
        )
        signal.throwIfAborted()
        modules.set(path.resolve(artifact), namespace)
        return namespace
      },
    })
    const selected = prepared.manifest.modules.map((descriptor) => {
      const artifact = path.resolve(prepared.directory, descriptor.artifact)
      if (!modules.has(artifact))
        throw new Error(
          `Verified plugin ${descriptor.pluginId} was not loaded.`,
        )
      return selectedModule(modules.get(artifact), descriptor)
    })
    return Object.freeze({ prepared, modules: Object.freeze(selected) })
  }
}

function isJsonValue(value: unknown): value is JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean")
    return true
  if (typeof value === "number") return Number.isFinite(value)
  if (Array.isArray(value)) return value.every((item) => isJsonValue(item))
  if (typeof value !== "object") return false
  return Object.values(value).every((item) => isJsonValue(item))
}

function jsonValue(value: unknown): JsonValue {
  // JSON serialization deliberately normalizes optional gateway DTO fields.
  // eslint-disable-next-line unicorn/prefer-structured-clone
  const normalized: unknown = JSON.parse(JSON.stringify(value))
  if (!isJsonValue(normalized)) throw new Error("Gateway snapshot is not JSON.")
  return normalized
}

function healthOf(
  plugins: ReadonlyArray<{
    id: string
    lifecycle: string
    error?: string
    status?: { code: string }
  }>,
): Array<RunnerHealthEntry> {
  return plugins.map((plugin) => {
    if (plugin.lifecycle === "waiting")
      return {
        pluginId: plugin.id,
        classification: "waiting-dependency" as const,
        ...(plugin.error ? { detail: plugin.error } : {}),
      }
    if (plugin.lifecycle === "failed")
      return {
        pluginId: plugin.id,
        classification: "existing-failure" as const,
        ...(plugin.error ? { detail: plugin.error } : {}),
      }
    if (plugin.status?.code === "signed-out")
      return { pluginId: plugin.id, classification: "signed-out" as const }
    if (plugin.status?.code === "needs-setup")
      return { pluginId: plugin.id, classification: "needs-setup" as const }
    return { pluginId: plugin.id, classification: "healthy" as const }
  })
}

/** Compose one Cordis root from the exact module objects Phase 4 reverified. */
export class VerifiedGenerationInventoryComposer implements RunnerInventoryComposer {
  readonly #transport: BunIpcTransport | undefined
  readonly #dispatcher: DuplexRpcDispatcher | undefined

  constructor(
    options: {
      transport?: BunIpcTransport
      dispatcher?: DuplexRpcDispatcher
    } = {},
  ) {
    this.#transport = options.transport
    this.#dispatcher = options.dispatcher
  }

  async compose(
    generation: VerifiedRunnerGeneration,
    selection: GenerationSelection,
    signal: AbortSignal,
  ): Promise<RunnerInventoryRoot> {
    signal.throwIfAborted()
    const plugins = generation.modules.map((module, index) =>
      validatePluginModule(module, `generation.modules[${index}]`),
    )
    const { composePluginGateway, composeRunnerPluginGateway } =
      await import("../compose")
    signal.throwIfAborted()
    const reverse =
      this.#dispatcher === undefined ?
        undefined
      : await createReverseServices(this.#dispatcher)
    const gateway =
      reverse === undefined ?
        composePluginGateway({ plugins })
      : composeRunnerPluginGateway({
          plugins,
          settingsAuthority: reverse.settingsAuthority,
          providers: [reverse.provider],
          host: reverse.host,
        })
    const unregister =
      this.#dispatcher && this.#transport ?
        registerRunnerGateway(
          this.#dispatcher,
          this.#transport,
          gateway,
          gateway.resourceLifecycle(),
        )
      : undefined
    let disposed = false
    const dispose = async (): Promise<void> => {
      if (disposed) return
      disposed = true
      await unregister?.()
      await gateway.dispose()
      reverse?.dispose()
      await reverse?.flush()
    }
    return {
      prepare() {
        const snapshots = gateway.list()
        return Promise.resolve({
          complete: true,
          revision: 0,
          controlEpoch: selection.controlEpoch,
          generationId: generation.prepared.manifest.generationId,
          manifestSha256: generation.prepared.manifestSha256,
          inventoryDigest: generation.prepared.manifest.inventoryDigest,
          health: healthOf(snapshots),
          snapshot: jsonValue(gatewayProjection(gateway)),
        })
      },
      activate: () =>
        gateway.resourceLifecycle().commit({ purpose: "activation" }),
      async dispatch(method, params) {
        if (method !== RELEASE_UPSTREAM_SESSION_METHOD)
          throw new Error(`Unknown runner dispatch method ${method}.`)
        if (
          params === null
          || typeof params !== "object"
          || Array.isArray(params)
          || typeof params.sessionId !== "string"
        )
          throw new Error("MCP upstream release requires a session id.")
        await releaseUpstreamSession(params.sessionId, signal)
        return null
      },
      drain: dispose,
      dispose,
    }
  }
}

function installParentWatch(parentPid: number): void {
  const timer = setInterval(() => {
    try {
      process.kill(parentPid, 0)
    } catch {
      process.disconnect?.()
    }
  }, 1_000)
  timer.unref()
}

/** Internal CLI entrypoint. It has no route registration and requires IPC + nonce. */
export async function runInternalPluginRunner(): Promise<void> {
  const nonce = process.env[RUNNER_NONCE_ENV]
  const encoded = process.env[RUNNER_SELECTION_ENV]
  const parentPid = Number(process.env[RUNNER_PARENT_PID_ENV])
  if (!nonce || !encoded || !process.send)
    throw new Error("Unauthenticated plugin runner invocation.")
  if (!Number.isInteger(parentPid) || parentPid <= 0)
    throw new Error("Plugin runner parent identity is invalid.")
  installParentWatch(parentPid)
  const selection = decodeGenerationSelection(encoded)
  const transport = new BunIpcTransport(new ChildTransportPort(), {
    role: "runner",
    generation: selection.token.generationId,
    nonce,
  })
  const dispatcher = new DuplexRpcDispatcher(transport, "runner")
  try {
    await runPluginRunner({
      nonce,
      selection,
      channel: new ChildProcessRunnerChannel(),
      verifier: new ImmutableGenerationVerifier(),
      composer: new VerifiedGenerationInventoryComposer({
        transport,
        dispatcher,
      }),
      hardExit: (code) => process.exit(code),
    })
  } finally {
    dispatcher.dispose("Runner stopped.")
  }
}
