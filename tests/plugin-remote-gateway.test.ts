/* eslint-disable max-lines, max-params -- transport contract integration fixture shares one paired-endpoint harness */
import type { UpstreamProvider } from "@stuffbucket/maximal-plugin-sdk"
import type {
  ModelOperation,
  OperationDispatch,
  PluginClientContribution,
  PluginGateway,
  PluginGatewayEvent,
  PluginGenerationLease,
  PluginSettings,
  PluginSnapshot,
  PluginToolListing,
  PluginToolView,
  PreparedServerTool,
  ServerToolCall,
  ServerToolView,
  ToolCallContext,
  ToolPermission,
  ToolResult,
} from "@stuffbucket/maximal-plugin-sdk/gateway"

import { PluginGatewayError } from "@stuffbucket/maximal-plugin-sdk/gateway"
import { describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"

import type { ParentHostServiceBroker } from "~/lib/plugins/host-service-broker"
import type { ParentProviderBroker } from "~/lib/plugins/provider-broker"

import { BUILTIN_PLUGIN_CLIENT_CATALOG } from "~/lib/plugins/compose"
import { providerInvocationJournal } from "~/lib/plugins/provider-broker"
import {
  createReverseServices,
  gatewayProjection,
  registerRunnerGateway,
} from "~/lib/plugins/runner/rpc"
import { GenerationSpoolStore } from "~/lib/plugins/spool/store"
import { createPluginStateBroker } from "~/lib/plugins/state-broker"
import { RunnerBlobBridge } from "~/lib/plugins/transport/blob-codec"
import { DuplexRpcDispatcher } from "~/lib/plugins/transport/dispatcher"
import { BunIpcTransport } from "~/lib/plugins/transport/ipc"
import { registerParentBrokers } from "~/lib/plugins/transport/parent-brokers"
import { createInMemoryIpcPair } from "~/lib/plugins/transport/ports"
import { TransportPluginGateway } from "~/lib/plugins/transport/remote-gateway"

const generation = "remote-generation"
const nonce = "remote-nonce-0123456789"
const LARGE_PROVIDER_TEXT = "image-payload-".repeat(100_000)
const result = (text: string): ToolResult => ({
  content: [{ type: "text", text }],
})

class StreamingOnlyFile extends File {
  override arrayBuffer(): Promise<ArrayBuffer> {
    return Promise.reject(new Error("Runner upload must stream the blob."))
  }
}

function emptySubscription(): () => void {
  return () => undefined
}

function resolveFixtureOperation(
  binding: { provider: string; upstreamModel: string },
  operation: ModelOperation,
  model: string,
) {
  return operation === "decisions" && model.endsWith("fixture-model") ?
      { pluginId: "fixture", binding }
    : undefined
}

class RunnerFixtureGateway implements PluginGateway {
  readonly executedOperationProviders: Array<string> = []
  readonly #provider: UpstreamProvider | undefined
  reconciledSettings: PluginSettings | undefined
  releasedOperations = 0
  readonly #listeners = new Set<(event: PluginGatewayEvent) => void>()
  readonly #operationListeners = new Set<() => void>()
  #operationBinding = {
    provider: "fixture-provider",
    upstreamModel: "fixture-model",
  }
  #config: unknown = { version: 1 }

  constructor(provider?: UpstreamProvider) {
    this.#provider = provider
  }

  replaceOperation(provider: string): void {
    this.#operationBinding = {
      provider,
      upstreamModel: "fixture-model",
    }
    for (const listener of this.#operationListeners) listener()
  }

  #snapshot(): PluginSnapshot {
    const manifest = {
      id: "fixture",
      kind: "model" as const,
      displayName: "Fixture",
      description: "Transport fixture.",
      settingsVersion: 1,
    }
    return {
      ...manifest,
      source: { type: "built-in" },
      manifest,
      config: structuredClone(this.#config),
      enabled: true,
      lifecycle: "active",
      tools: [{ name: "ask", description: "Ask." }],
      toolsSource: "live",
    }
  }

  #listing(): PluginToolListing {
    return {
      name: "ask",
      description: "Ask.",
      inputSchema: { type: "object" },
      permission: "allow",
    }
  }

  #operations(): OperationDispatch {
    return {
      resolve: (operation, model) =>
        resolveFixtureOperation(this.#operationBinding, operation, model),
      prepare: (operation, model) => {
        const target = resolveFixtureOperation(
          this.#operationBinding,
          operation,
          model,
        )
        if (!target) return undefined
        const binding = structuredClone(target.binding)
        return {
          operation,
          model,
          pluginId: target.pluginId,
          binding,
          execute: async (request) => {
            this.executedOperationProviders.push(binding.provider)
            const relayed =
              (
                this.#provider
                && (request.body instanceof FormData
                  || request.body.providerReply === true)
              ) ?
                await this.#provider.postJson<Record<string, unknown>>(
                  request.body instanceof FormData ? "/multipart" : "/large",
                  request.body,
                  {
                    signal: request.signal,
                    errorMessage: "Fixture provider failed.",
                    invocation: {
                      invocationId: request.invocationId,
                      providerCallId: request.providerCallId,
                      sequence: request.sequence,
                      operation,
                      model,
                    },
                  },
                )
              : { transported: true, provider: binding.provider }
            return {
              json: relayed,
              usage: { input_tokens: 2, output_tokens: 1 },
              invocationId: request.invocationId,
              providerCallId: request.providerCallId,
              sequence: request.sequence,
            }
          },
          release: () => {
            this.releasedOperations += 1
          },
        }
      },
      dispatch: async (request) => {
        const prepared = this.#operations().prepare(
          request.operation,
          request.model,
        )
        if (!prepared) throw new Error("Operation unavailable.")
        try {
          return await prepared.execute(request)
        } finally {
          prepared.release()
        }
      },
      servedModels: () => [
        {
          model: "fixture-model",
          operations: ["decisions"],
          provider: this.#operationBinding.provider,
          upstreamModel: this.#operationBinding.upstreamModel,
        },
      ],
      subscribe: (listener) => {
        this.#operationListeners.add(listener)
        return () => this.#operationListeners.delete(listener)
      },
    }
  }

  acquireGeneration(): PluginGenerationLease {
    throw new Error("Fixture generation leases are not used.")
  }

  reconcile(settings: PluginSettings | undefined): Promise<void> {
    this.reconciledSettings = structuredClone(settings)
    return Promise.resolve()
  }

  list(): Array<PluginSnapshot> {
    return [this.#snapshot()]
  }

  get(id: string): PluginSnapshot | undefined {
    return id === "fixture" ? this.#snapshot() : undefined
  }

  listTools(pluginId: string): Array<PluginToolListing> {
    return pluginId === "fixture" ? [this.#listing()] : []
  }

  toolViews(pluginId: string): Array<PluginToolView> {
    return pluginId === "fixture" ?
        [{ ...this.#listing(), group: "read-only", permissionSource: "plugin" }]
      : []
  }

  async callTool(
    pluginId: string,
    _name: string,
    input: Record<string, unknown>,
    call: ToolCallContext,
  ): Promise<ToolResult> {
    if (pluginId !== "fixture")
      throw new PluginGatewayError(
        "unknown-plugin",
        pluginId,
        `Unknown plugin "${pluginId}".`,
      )
    call.progress?.({ progress: 1, total: 2, message: "halfway" })
    if (input.wait === true) {
      await new Promise<void>((_resolve, reject) => {
        call.signal.addEventListener(
          "abort",
          () => reject(new Error(String(call.signal.reason ?? "aborted"))),
          { once: true },
        )
      })
    }
    const reply = await call.elicit?.({
      message: "Continue?",
      requestedSchema: {
        type: "object",
        properties: { answer: { type: "string" } },
      },
    })
    const answer = reply?.content?.answer
    return result(typeof answer === "string" ? answer : "none")
  }

  operations(): OperationDispatch {
    return this.#operations()
  }

  serverTools(): Array<ServerToolView> {
    return [
      {
        pluginId: "fixture",
        name: "fixture_server",
        description: "Server fixture.",
        input_schema: { type: "object" },
        render: "hidden",
        offer: "always",
        clients: ["claude-code"],
        billed: true,
      },
    ]
  }

  pluginClientContributions(): Array<PluginClientContribution> {
    return BUILTIN_PLUGIN_CLIENT_CATALOG.map((value) => ({ ...value }))
  }

  prepareServerTool(
    _pluginId: string,
    _name: string,
    input: Record<string, unknown>,
  ): Promise<PreparedServerTool> {
    const calls = input.calls === 2 ? 2 : 1
    return Promise.resolve({
      pluginId: "fixture",
      name: "fixture_server",
      estimate: { operation: "decisions", body: {} },
      execute: async (call: ServerToolCall) => {
        if (input.runnerMultipart === true && this.#provider) {
          const bytes = Uint8Array.from({ length: 300_000 }, () => 67)
          const body = new FormData()
          body.append(
            "image[]",
            new StreamingOnlyFile([bytes], "runner.png", {
              type: "image/png",
            }),
          )
          body.append("prompt", "runner-originated")
          const invocation = call.nextProviderCall("decisions", "fixture-model")
          await this.#provider.postJson("/multipart", body, {
            signal: call.signal,
            errorMessage: "Fixture provider failed.",
            invocation,
          })
          return result("multipart")
        }
        if (input.providerReply === true && this.#provider) {
          const invocation = call.nextProviderCall("decisions", "fixture-model")
          const reply = await this.#provider.postJson<{ data: string }>(
            "/large",
            {},
            {
              signal: call.signal,
              errorMessage: "Fixture provider failed.",
              invocation,
            },
          )
          return result(reply.data)
        }
        const providerCallIds: Array<string> = []
        for (let index = 0; index < calls; index += 1) {
          const invocation = call.nextProviderCall("decisions", "fixture-model")
          providerCallIds.push(invocation.providerCallId)
          call.reportSpend?.({
            ...invocation,
            provider: "fixture-provider",
            result: {
              usage: {},
              cost: { amount: 3, unit: "nano_aiu", estimated: false },
            },
          })
        }
        return result(providerCallIds.join(","))
      },
      release: () => undefined,
    })
  }

  callServerTool(
    pluginId: string,
    name: string,
    input: Record<string, unknown>,
    call: ServerToolCall,
  ): Promise<ToolResult> {
    return this.prepareServerTool(pluginId, name, input).then((prepared) =>
      prepared.execute(call),
    )
  }

  runAction(): Promise<void> {
    return Promise.resolve()
  }

  updateConfig(_pluginId: string, config: unknown): Promise<void> {
    this.#config = structuredClone(config)
    this.#emit({ type: "settings", pluginId: "fixture" })
    return Promise.resolve()
  }

  setToolPermissions(
    _pluginId: string,
    _changes: Record<string, ToolPermission | null>,
  ): Promise<void> {
    return Promise.resolve()
  }

  importLegacyConfig(): Promise<boolean> {
    return Promise.resolve(true)
  }

  subscribe(listener: (event: PluginGatewayEvent) => void): () => void {
    this.#listeners.add(listener)
    return () => this.#listeners.delete(listener)
  }

  dispose(): Promise<void> {
    this.#listeners.clear()
    return Promise.resolve()
  }

  #emit(event: PluginGatewayEvent): void {
    for (const listener of this.#listeners) listener(event)
  }
}

async function connectedPair() {
  const root = await mkdtemp(path.join(os.tmpdir(), "remote-gateway-"))
  const spool = new GenerationSpoolStore({
    root: path.join(root, "spool"),
    generation,
  })
  const ports = createInMemoryIpcPair()
  const protocolErrors: Array<Error> = []
  const parentTransport = new BunIpcTransport(ports.parent, {
    role: "parent",
    generation,
    nonce,
    heartbeatIntervalMs: 0,
    heartbeatTimeoutMs: 0,
    onProtocolError: (error) => protocolErrors.push(error),
  })
  const runnerTransport = new BunIpcTransport(ports.runner, {
    role: "runner",
    generation,
    nonce,
    heartbeatIntervalMs: 0,
    heartbeatTimeoutMs: 0,
    onProtocolError: (error) => protocolErrors.push(error),
  })
  await Promise.all([parentTransport.connected, runnerTransport.connected])
  const runnerDispatcher = new DuplexRpcDispatcher(runnerTransport, "runner")
  const remoteRef: { current?: TransportPluginGateway } = {}
  const parentDispatcher = new DuplexRpcDispatcher(parentTransport, "parent", {
    onStateEvent: (event) => remoteRef.current?.handleStateEvent(event),
    onSpend: (_callId, invocationId, providerCallId, _amount, evidence) =>
      remoteRef.current?.handleSpend(invocationId, providerCallId, evidence),
  })
  const state = createPluginStateBroker(path.join(root, "state"))
  let providerCalls = 0
  const multipartParts: Array<string> = []
  const provider: ParentProviderBroker = {
    id: "fixture-provider",
    displayName: "Fixture Provider",
    snapshot: () => ({
      revision: 1,
      available: true,
      models: [
        {
          id: "fixture-model",
          type: "decisions",
          endpoints: ["/large", "/multipart"],
          preview: false,
        },
      ],
    }),
    subscribe: emptySubscription,
    postJson: async <T>(
      requestPath: string,
      body: Record<string, unknown> | FormData,
    ) => {
      providerCalls += 1
      if (requestPath === "/large") return { data: LARGE_PROVIDER_TEXT } as T
      if (!(body instanceof FormData))
        throw new Error("Multipart fixture did not receive FormData.")
      for (const [name, value] of body.entries()) {
        const part: unknown = value
        if (typeof part === "string") {
          multipartParts.push(`${name}:text:${part}`)
          continue
        }
        if (!(part instanceof Blob))
          throw new Error("Multipart fixture received an invalid part.")
        const bytes = new Uint8Array(await part.arrayBuffer())
        multipartParts.push(
          `${name}:blob:${bytes.byteLength}:${bytes[0]}:${bytes.at(-1)}`,
        )
      }
      return { multipart: true } as T
    },
    cost: () => ({ unit: "nano_aiu", amount: 4, estimated: false }),
  }
  const host: ParentHostServiceBroker = {
    snapshot: () => ({ revision: 1, appVersion: "test", maximalPort: 4150 }),
    openExternal: () => Promise.resolve(),
    logger: {
      debug: () => undefined,
      info: () => undefined,
      warn: () => undefined,
      error: () => undefined,
    },
  }
  const unregisterBrokers = registerParentBrokers(parentDispatcher, {
    state,
    provider,
    host,
    spool,
  })
  const blobs = new RunnerBlobBridge(runnerDispatcher, generation)
  const reverse = await createReverseServices(runnerDispatcher, blobs)
  const fixture = new RunnerFixtureGateway(reverse.provider)
  const unregister = registerRunnerGateway(
    runnerDispatcher,
    runnerTransport,
    fixture,
    blobs,
  )
  const remote = new TransportPluginGateway(
    parentDispatcher,
    generation,
    gatewayProjection(fixture),
    spool,
  )
  remoteRef.current = remote
  return {
    fixture,
    remote,
    spool,
    multipartParts,
    providerCalls: () => providerCalls,
    dispose: async () => {
      await remote.dispose()
      await unregister()
      reverse.dispose()
      await reverse.flush()
      unregisterBrokers()
      await Bun.sleep(0)
      if (parentDispatcher.inflight !== 0 || runnerDispatcher.inflight !== 0)
        throw new Error(
          `Gateway test leaked RPC: ${parentDispatcher.inflight}/${runnerDispatcher.inflight}`,
        )
      if (protocolErrors.length > 0)
        throw new Error(
          `Gateway protocol failed: ${protocolErrors.map((error) => error.message).join(" / ")}`,
        )
      await fixture.dispose()
      providerInvocationJournal.reset()
      await spool.close()
      await rm(root, { recursive: true, force: true })
    },
  }
}

function rejection(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => {
      throw new Error("Expected rejection.")
    },
    (error: unknown) => error,
  )
}

describe("reverse runner service brokers", () => {
  test("keeps settings, provider credentials, and host effects in the parent", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "runner-brokers-"))
    const spool = new GenerationSpoolStore({
      root: path.join(root, "spool"),
      generation,
    })
    const ports = createInMemoryIpcPair()
    const parentTransport = new BunIpcTransport(ports.parent, {
      role: "parent",
      generation,
      nonce,
      heartbeatIntervalMs: 0,
      heartbeatTimeoutMs: 0,
    })
    const runnerTransport = new BunIpcTransport(ports.runner, {
      role: "runner",
      generation,
      nonce,
      heartbeatIntervalMs: 0,
      heartbeatTimeoutMs: 0,
    })
    await Promise.all([parentTransport.connected, runnerTransport.connected])
    const parent = new DuplexRpcDispatcher(parentTransport, "parent")
    const runner = new DuplexRpcDispatcher(runnerTransport, "runner")
    const state = createPluginStateBroker(path.join(root, "state"))
    const opened: Array<string> = []
    let providerSawAbortSignal = false
    let providerRequestStarted: (() => void) | undefined
    let providerSnapshot = {
      revision: 3,
      available: true,
      models: [
        {
          id: "fixture-model",
          type: "decisions",
          endpoints: ["/fixture"],
          preview: false,
        },
      ],
    }
    const providerListeners = new Set<() => void>()
    const provider: ParentProviderBroker = {
      id: "parent-provider",
      displayName: "Parent Provider",
      snapshot: () => structuredClone(providerSnapshot),
      subscribe: (listener) => {
        providerListeners.add(listener)
        return () => providerListeners.delete(listener)
      },
      postJson: <T>(
        path: string,
        _body: Record<string, unknown> | FormData,
        options: import("@stuffbucket/maximal-plugin-sdk").ProviderRequestOptions,
      ) => {
        providerSawAbortSignal = options.signal instanceof AbortSignal
        if (path === "/wait") {
          providerRequestStarted?.()
          return new Promise<T>((_resolve, reject) => {
            options.signal?.addEventListener(
              "abort",
              () => reject(new Error(String(options.signal?.reason))),
              { once: true },
            )
          })
        }
        return Promise.resolve({ ok: true } as T)
      },
      cost: () => ({ unit: "nano_aiu", amount: 4, estimated: false }),
    }
    const host: ParentHostServiceBroker = {
      snapshot: () => ({ revision: 2, appVersion: "test", maximalPort: 4150 }),
      openExternal: (url) => {
        opened.push(url)
        return Promise.resolve()
      },
      logger: {
        debug: () => undefined,
        info: () => undefined,
        warn: () => undefined,
        error: () => undefined,
      },
    }
    const unregister = registerParentBrokers(parent, {
      state,
      provider,
      host,
      spool,
    })
    const reverse = await createReverseServices(
      runner,
      new RunnerBlobBridge(runner, generation),
    )
    try {
      const initial = await reverse.settingsAuthority.snapshot("fixture")
      const commit = await reverse.settingsAuthority.commit({
        pluginId: "fixture",
        baseRevision: initial.revision,
        baseEpoch: initial.epoch,
        kind: "config",
        text: '{"enabled":true}\n',
      })
      expect(commit).toMatchObject({ pluginId: "fixture", revision: 1 })

      const reply = await reverse.provider.postJson<Record<string, unknown>>(
        "/fixture",
        { input: true },
        {
          errorMessage: "Provider failed.",
          invocation: {
            invocationId: "reverse-invocation",
            providerCallId: "parent-issued-call",
            sequence: 1,
            operation: "decisions",
            model: "fixture-model",
          },
        },
      )
      expect(reply).toEqual({ ok: true })
      expect(
        reverse.provider.cost(reply, {
          operation: "decisions",
          model: "fixture-model",
        }),
      ).toEqual({ unit: "nano_aiu", amount: 4, estimated: false })
      expect(providerSawAbortSignal).toBe(true)

      let catalogChanges = 0
      const stopCatalog = reverse.provider.onCatalogChange(() => {
        catalogChanges += 1
      })
      providerSnapshot = {
        revision: 4,
        available: false,
        models: [],
      }
      for (const listener of providerListeners) listener()
      for (let attempt = 0; catalogChanges === 0 && attempt < 100; attempt += 1)
        await Bun.sleep(1)
      expect(catalogChanges).toBe(1)
      expect(reverse.provider.available()).toBe(false)
      expect(reverse.provider.model("fixture-model")).toBeUndefined()
      stopCatalog()

      let markProviderStarted!: () => void
      const providerStarted = new Promise<void>((resolve) => {
        markProviderStarted = resolve
      })
      providerRequestStarted = markProviderStarted
      const abort = new AbortController()
      const waiting = reverse.provider.postJson(
        "/wait",
        {},
        {
          signal: abort.signal,
          errorMessage: "Provider failed.",
          invocation: {
            invocationId: "cancelled-invocation",
            providerCallId: "cancelled-call",
            sequence: 1,
            operation: "decisions",
            model: "fixture-model",
          },
        },
      )
      await providerStarted
      abort.abort("cancelled by test")
      expect(String(await rejection(waiting))).toContain("cancelled by test")
      for (
        let attempt = 0;
        (parent.inflight !== 0 || runner.inflight !== 0) && attempt < 100;
        attempt += 1
      )
        await Bun.sleep(1)
      expect(parent.inflight).toBe(0)
      expect(runner.inflight).toBe(0)

      await reverse.host.openExternal("https://example.test/")
      expect(opened).toEqual(["https://example.test/"])
      expect(reverse.host.maximalPort()).toBe(4150)
    } finally {
      reverse.dispose()
      await reverse.flush()
      unregister()
      providerInvocationJournal.reset()
      await spool.close()
      await rm(root, { recursive: true, force: true })
    }
  })
})

describe("projected runner gateway transport", () => {
  test("round-trips projection, progress, elicitation, operations, and spend", async () => {
    const pair = await connectedPair()
    try {
      expect(pair.remote.list()).toMatchObject([
        { id: "fixture", lifecycle: "active" },
      ])
      expect(pair.remote.pluginClientContributions()).toEqual([
        ...BUILTIN_PLUGIN_CLIENT_CATALOG,
      ])
      const settings: PluginSettings = {
        fixture: {
          enabled: true,
          clients: ["claude-code"],
          access: {
            "app:claude-desktop": "allow",
            "connection:k-workiq": "ask",
          },
        },
      }
      await pair.remote.reconcile(settings)
      expect(pair.fixture.reconciledSettings).toEqual(settings)

      const lease = pair.remote.acquireGeneration()
      expect(lease.pluginClientContributions()).toEqual(
        pair.remote.pluginClientContributions(),
      )
      lease.release()
      const progress: Array<number> = []
      expect(
        await pair.remote.callTool(
          "fixture",
          "ask",
          {},
          {
            signal: new AbortController().signal,
            progress: (event) => progress.push(event.progress),
            elicit: () =>
              Promise.resolve({ action: "accept", content: { answer: "yes" } }),
          },
        ),
      ).toEqual(result("yes"))
      expect(progress).toEqual([1])

      expect(
        await pair.remote.operations().dispatch({
          operation: "decisions",
          model: "fixture-model",
          body: {},
          signal: new AbortController().signal,
          invocationId: "operation-invocation",
          providerCallId: "operation-call",
          sequence: 1,
          origin: { kind: "http", client: "test" },
        }),
      ).toMatchObject({ json: { transported: true } })

      let spendId = ""
      const prepared = await pair.remote.prepareServerTool(
        "fixture",
        "fixture_server",
        {},
      )
      const serverResult = await prepared.execute({
        signal: new AbortController().signal,
        invocationId: "server-invocation",
        nextProviderCall: () => {
          throw new Error("Runner must use parent-provisioned identities.")
        },
        model: "fixture-model",
        client: "test",
        reportSpend: (spend) => {
          spendId = spend.providerCallId
        },
      })
      expect(spendId).not.toBe("")
      expect(spendId).not.toContain("server-invocation")
      expect(serverResult).toEqual(result(spendId))

      const providerCalls: Array<string> = []
      const preparedTwice = await pair.remote.prepareServerTool(
        "fixture",
        "fixture_server",
        { calls: 2 },
      )
      const twiceResult = await preparedTwice.execute({
        signal: new AbortController().signal,
        invocationId: "two-call-invocation",
        nextProviderCall: () => {
          throw new Error("Runner must use parent-provisioned identities.")
        },
        model: "fixture-model",
        client: "test",
        reportSpend: (spend) => providerCalls.push(spend.providerCallId),
      })
      expect(providerCalls).toHaveLength(2)
      expect(new Set(providerCalls).size).toBe(2)
      expect(twiceResult).toEqual(result(providerCalls.join(",")))

      const stateEvent = new Promise<void>((resolve) => {
        const unsubscribe = pair.remote.subscribe((event) => {
          if (event.type !== "settings") return
          unsubscribe()
          resolve()
        })
      })
      await pair.remote.updateConfig("fixture", { version: 2 })
      await stateEvent
      expect(pair.remote.get("fixture")?.config).toEqual({ version: 2 })
    } finally {
      await pair.dispose()
    }
  })
})

describe("large projected gateway values", () => {
  test("round-trips a provider reply larger than the IPC envelope once", async () => {
    const pair = await connectedPair()
    try {
      const response = await pair.remote.operations().dispatch({
        operation: "decisions",
        model: "fixture-model",
        body: { providerReply: true },
        signal: new AbortController().signal,
        invocationId: "large-reply-invocation",
        providerCallId: "large-reply-call",
        sequence: 1,
        origin: { kind: "http", client: "test" },
      })
      expect(response.json).toEqual({ data: LARGE_PROVIDER_TEXT })
      expect(pair.providerCalls()).toBe(1)
      expect(pair.spool.openLeases).toBe(0)
    } finally {
      await pair.dispose()
    }
  })

  test("round-trips a large provider-backed server-tool result", async () => {
    const pair = await connectedPair()
    try {
      const prepared = await pair.remote.prepareServerTool(
        "fixture",
        "fixture_server",
        { providerReply: true },
      )
      const response = await prepared.execute({
        signal: new AbortController().signal,
        invocationId: "large-tool-invocation",
        nextProviderCall: () => {
          throw new Error("Runner must use parent-provisioned identities.")
        },
        model: "fixture-model",
        client: "test",
      })
      expect(response).toEqual(result(LARGE_PROVIDER_TEXT))
      expect(pair.providerCalls()).toBe(1)
      expect(pair.spool.openLeases).toBe(0)
    } finally {
      await pair.dispose()
    }
  })

  test("streams runner-originated multipart blobs before provider dispatch", async () => {
    const pair = await connectedPair()
    try {
      const prepared = await pair.remote.prepareServerTool(
        "fixture",
        "fixture_server",
        { runnerMultipart: true },
      )
      const response = await prepared.execute({
        signal: new AbortController().signal,
        invocationId: "runner-multipart-invocation",
        nextProviderCall: () => {
          throw new Error("Runner must use parent-provisioned identities.")
        },
        model: "fixture-model",
        client: "test",
      })
      expect(response).toEqual(result("multipart"))
      expect(pair.multipartParts).toEqual([
        "image[]:blob:300000:67:67",
        "prompt:text:runner-originated",
      ])
      expect(pair.providerCalls()).toBe(1)
      expect(pair.spool.openLeases).toBe(0)
    } finally {
      await pair.dispose()
    }
  })

  test("preserves large duplicate multipart fields and their order", async () => {
    const pair = await connectedPair()
    try {
      const first = Uint8Array.from({ length: 300_000 }, () => 65)
      const second = Uint8Array.from({ length: 310_000 }, () => 66)
      const body = new FormData()
      body.append(
        "image[]",
        new File([first], "first.png", { type: "image/png" }),
      )
      body.append("prompt", "turn red blue")
      body.append(
        "image[]",
        new File([second], "second.png", { type: "image/png" }),
      )
      const response = await pair.remote.operations().dispatch({
        operation: "decisions",
        model: "fixture-model",
        body,
        signal: new AbortController().signal,
        invocationId: "multipart-invocation",
        providerCallId: "multipart-call",
        sequence: 1,
        origin: { kind: "http", client: "test" },
      })
      expect(response.json).toEqual({ multipart: true })
      expect(pair.multipartParts).toEqual([
        "image[]:blob:300000:65:65",
        "prompt:text:turn red blue",
        "image[]:blob:310000:66:66",
      ])
      expect(pair.providerCalls()).toBe(1)
      expect(pair.spool.openLeases).toBe(0)
    } finally {
      await pair.dispose()
    }
  })
})

describe("projected runner gateway transport failures", () => {
  test("rejects malformed plugin access settings", async () => {
    const pair = await connectedPair()
    try {
      for (const access of [
        { "team:desktop": "allow" },
        { "app:claude-desktop": "sometimes" },
      ]) {
        const error = await rejection(
          pair.remote.reconcile({
            fixture: { access },
          } as unknown as PluginSettings),
        )
        expect(String(error)).toContain("Plugin access is invalid.")
      }
    } finally {
      await pair.dispose()
    }
  })

  test("rejects a prepared operation after its child registry changes", async () => {
    const pair = await connectedPair()
    try {
      const stale = pair.remote
        .operations()
        .prepare("decisions", "fixture-model")
      if (!stale) throw new Error("Expected fixture operation.")

      pair.fixture.replaceOperation("replacement-provider")
      expect(
        String(
          await rejection(
            stale.execute({
              body: {},
              signal: new AbortController().signal,
              invocationId: "stale-invocation",
              providerCallId: "stale-call",
              sequence: 1,
              origin: { kind: "http", client: "test" },
            }),
          ),
        ),
      ).toContain("registry changed before execution")
      stale.release()
      expect(pair.fixture.executedOperationProviders).toEqual([])
      expect(pair.fixture.releasedOperations).toBe(0)

      await pair.remote.refresh()
      const replacement = pair.remote
        .operations()
        .prepare("decisions", "fixture-model")
      if (!replacement) throw new Error("Expected replacement operation.")
      try {
        expect(
          await replacement.execute({
            body: {},
            signal: new AbortController().signal,
            invocationId: "replacement-invocation",
            providerCallId: "replacement-call",
            sequence: 1,
            origin: { kind: "http", client: "test" },
          }),
        ).toMatchObject({
          json: { transported: true, provider: "replacement-provider" },
        })
      } finally {
        replacement.release()
      }
      expect(pair.fixture.executedOperationProviders).toEqual([
        "replacement-provider",
      ])
      expect(pair.fixture.releasedOperations).toBe(1)
    } finally {
      await pair.dispose()
    }
  })

  test("round-trips typed failures and cancellation", async () => {
    const pair = await connectedPair()
    try {
      expect(
        await rejection(
          pair.remote.callTool(
            "missing",
            "ask",
            {},
            {
              signal: new AbortController().signal,
            },
          ),
        ),
      ).toMatchObject({
        name: "PluginGatewayError",
        code: "unknown-plugin",
        pluginId: "missing",
      })

      const controller = new AbortController()
      const pending = pair.remote.callTool(
        "fixture",
        "ask",
        { wait: true },
        { signal: controller.signal },
      )
      await Bun.sleep(0)
      controller.abort("cancelled by test")
      expect(await rejection(pending)).toMatchObject({ name: "AbortError" })
    } finally {
      await pair.dispose()
    }
  })
})
