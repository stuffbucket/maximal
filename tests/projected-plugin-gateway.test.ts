/* eslint-disable max-lines-per-function -- one describe covers the projection scenarios. */
import type {
  ModelOperation,
  OperationDispatch,
  PluginGateway,
  PluginGatewayEvent,
  PluginGenerationLease,
  PluginSettings,
  PluginSnapshot,
  PluginToolListing,
  PluginToolView,
  PreparedOperation,
  PreparedServerTool,
  ServerToolCall,
  ServerToolView,
  ToolCallContext,
  ToolPermission,
  ToolResult,
} from "@stuffbucket/maximal-plugin-sdk/gateway"

import { describe, expect, test } from "bun:test"

import { ProjectedPluginGateway } from "~/lib/plugins/projected-gateway"

async function rejectionOf(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise
  } catch (error) {
    return error
  }
  throw new Error("Expected promise to reject.")
}

const noop = (): void => {}
const toolResult = (text: string): ToolResult => ({
  content: [{ type: "text", text }],
})

function snapshot(id: string, generation: string): PluginSnapshot {
  const manifest = {
    id,
    kind: "model" as const,
    displayName: `${id} ${generation}`,
    description: generation,
    settingsVersion: 1,
  }
  return {
    ...manifest,
    source: { type: "built-in" },
    manifest,
    config: { generation },
    enabled: true,
    lifecycle: "active",
    tools: [{ name: "echo", description: generation }],
    toolsSource: "live",
  }
}

class FakeGateway implements PluginGateway {
  readonly counts = new Map<string, number>()
  readonly prepared: Array<string> = []
  readonly calls: Array<string> = []
  updateConfigImpl?: (config: unknown) => Promise<void>
  projectionError?: Error
  readonly #listeners = new Set<(event: PluginGatewayEvent) => void>()

  emit(event: PluginGatewayEvent): void {
    for (const listener of this.#listeners) listener(event)
  }
  readonly #generation: string
  #snapshot: PluginSnapshot
  disposed = false

  constructor(generation: string) {
    this.#generation = generation
    this.#snapshot = snapshot("plugin", generation)
  }

  count(name: string): number {
    return this.counts.get(name) ?? 0
  }

  resetCounts(): void {
    this.counts.clear()
  }

  #count(name: string): void {
    this.counts.set(name, this.count(name) + 1)
  }

  #listing(): PluginToolListing {
    return {
      name: "echo",
      description: this.#generation,
      inputSchema: { type: "object" },
      permission: "allow",
    }
  }

  #toolView(): PluginToolView {
    return {
      ...this.#listing(),
      group: "read-only",
      permissionSource: "plugin",
    }
  }

  #serverTool(): ServerToolView {
    return {
      pluginId: "plugin",
      name: "server_echo",
      description: this.#generation,
      input_schema: { type: "object" },
      render: "hidden",
      offer: "always",
      clients: ["claude-code"],
      billed: true,
    }
  }

  #operations(): OperationDispatch {
    const binding = { provider: this.#generation, upstreamModel: "model" }
    const resolve = (operation: ModelOperation, model: string) =>
      operation === "decisions" && model === "model" ?
        { pluginId: "plugin", binding }
      : undefined
    return {
      resolve: (operation, model) => {
        this.#count("operations.resolve")
        return resolve(operation, model)
      },
      prepare: (operation, model): PreparedOperation | undefined => {
        this.#count("operations.prepare")
        const target = resolve(operation, model)
        if (!target) return undefined
        this.prepared.push(this.#generation)
        let released = false
        return {
          operation,
          model,
          pluginId: target.pluginId,
          binding: target.binding,
          execute: (request) => {
            if (released) return Promise.reject(new Error("released"))
            this.calls.push(`operation:${this.#generation}`)
            return Promise.resolve({
              json: { generation: this.#generation },
              usage: {},
              invocationId: request.invocationId,
              providerCallId: request.providerCallId,
              sequence: request.sequence,
            })
          },
          release: () => {
            released = true
          },
        }
      },
      dispatch: async (request) => {
        const prepared = this.#operations().prepare(
          request.operation,
          request.model,
        )
        if (!prepared) throw new Error("unavailable")
        try {
          return await prepared.execute(request)
        } finally {
          prepared.release()
        }
      },
      servedModels: () => {
        this.#count("operations.servedModels")
        return [
          {
            model: "model",
            operations: ["decisions"],
            provider: this.#generation,
            upstreamModel: "model",
          },
        ]
      },
      subscribe: () => noop,
    }
  }

  acquireGeneration(): PluginGenerationLease {
    throw new Error("Projected tests must not acquire a target lease.")
  }

  async reconcile(_settings: PluginSettings | undefined): Promise<void> {}

  list(): Array<PluginSnapshot> {
    this.#count("list")
    if (this.projectionError) throw this.projectionError
    return [structuredClone(this.#snapshot)]
  }

  get(id: string): PluginSnapshot | undefined {
    this.#count("get")
    return id === "plugin" ? structuredClone(this.#snapshot) : undefined
  }

  listTools(pluginId: string): Array<PluginToolListing> {
    this.#count("listTools")
    return pluginId === "plugin" ? [this.#listing()] : []
  }

  toolViews(pluginId: string): Array<PluginToolView> {
    this.#count("toolViews")
    return pluginId === "plugin" ? [this.#toolView()] : []
  }

  // eslint-disable-next-line max-params -- implements PluginGateway.callTool
  callTool(
    _pluginId: string,
    _name: string,
    _input: Record<string, unknown>,
    _call: ToolCallContext,
  ): Promise<ToolResult> {
    this.calls.push(`tool:${this.#generation}`)
    return Promise.resolve(toolResult(this.#generation))
  }

  operations(): OperationDispatch {
    this.#count("operations")
    return this.#operations()
  }

  serverTools(): Array<ServerToolView> {
    this.#count("serverTools")
    return [this.#serverTool()]
  }

  prepareServerTool(
    _pluginId: string,
    _name: string,
    _input: Record<string, unknown>,
  ): Promise<PreparedServerTool> {
    this.prepared.push(`server:${this.#generation}`)
    let released = false
    return Promise.resolve({
      pluginId: "plugin",
      name: "server_echo",
      estimate: {
        operation: "decisions",
        provider: this.#generation,
        body: {},
      },
      execute: (_call: ServerToolCall) => {
        if (released) return Promise.reject(new Error("released"))
        released = true
        this.calls.push(`server:${this.#generation}`)
        return Promise.resolve(toolResult(this.#generation))
      },
      release: () => {
        released = true
      },
    })
  }

  // eslint-disable-next-line max-params -- implements PluginGateway.callServerTool
  async callServerTool(
    pluginId: string,
    name: string,
    input: Record<string, unknown>,
    call: ServerToolCall,
  ): Promise<ToolResult> {
    const prepared = await this.prepareServerTool(pluginId, name, input)
    return await prepared.execute(call)
  }

  async runAction(): Promise<void> {}

  async updateConfig(_pluginId: string, config: unknown): Promise<void> {
    await this.updateConfigImpl?.(config)
    this.#snapshot = { ...this.#snapshot, config: structuredClone(config) }
  }

  async setToolPermissions(
    _pluginId: string,
    _changes: Record<string, ToolPermission | null>,
  ): Promise<void> {}

  importLegacyConfig(): Promise<boolean> {
    return Promise.resolve(false)
  }

  subscribe(listener: (event: PluginGatewayEvent) => void): () => void {
    this.#listeners.add(listener)
    return () => this.#listeners.delete(listener)
  }

  dispose(): Promise<void> {
    this.disposed = true
    return Promise.resolve()
  }
}

const call = {
  signal: new AbortController().signal,
  model: "model",
  client: "claude-code",
}

describe("projected plugin gateway", () => {
  test("serves immutable synchronous reads without target calls", () => {
    const target = new FakeGateway("n")
    const gateway = new ProjectedPluginGateway(target, "n")
    target.resetCounts()

    const listed = gateway.list()
    const found = gateway.get("plugin")
    const tools = gateway.listTools("plugin")
    const views = gateway.toolViews("plugin")
    const serverTools = gateway.serverTools()
    const operations = gateway.operations()
    const resolved = operations.resolve("decisions", "model")
    const models = operations.servedModels()
    if (!found) throw new Error("Expected projected plugin.")

    listed[0].displayName = "changed"
    found.config = { changed: true }
    tools[0].description = "changed"
    views[0].description = "changed"
    serverTools[0].description = "changed"
    models[0].model = "changed"

    expect(gateway.get("plugin")?.displayName).toBe("plugin n")
    expect(gateway.get("plugin")?.config).toEqual({ generation: "n" })
    expect(gateway.listTools("plugin")[0]?.description).toBe("n")
    expect(gateway.toolViews("plugin")[0]?.description).toBe("n")
    expect(gateway.serverTools()[0]?.description).toBe("n")
    expect(gateway.operations()).toBe(operations)
    expect(resolved?.binding.provider).toBe("n")
    expect(gateway.operations().servedModels()[0]?.model).toBe("model")
    expect(
      [...target.counts.values()].reduce((sum, value) => sum + value, 0),
    ).toBe(0)
  })

  test("atomically refreshes a mutation before its promise resolves", async () => {
    const target = new FakeGateway("n")
    const gateway = new ProjectedPluginGateway(target, "n")

    await gateway.updateConfig("plugin", { updated: true })

    expect(gateway.get("plugin")?.config).toEqual({ updated: true })
  })

  test("preserves command and projection failures without leaking its generation ref", async () => {
    const oldTarget = new FakeGateway("n")
    const newTarget = new FakeGateway("n+1")
    const commandError = new Error("command failed")
    const projectionError = new Error("projection failed")
    oldTarget.updateConfigImpl = () => {
      oldTarget.projectionError = projectionError
      return Promise.reject(commandError)
    }
    const gateway = new ProjectedPluginGateway(oldTarget, "n")

    const failure = await rejectionOf(
      gateway.updateConfig("plugin", { updated: true }),
    )
    expect(failure).toBeInstanceOf(AggregateError)
    expect((failure as AggregateError).errors).toEqual([
      commandError,
      projectionError,
    ])
    expect(gateway.generationDiagnostics()).toContainEqual({
      generationId: "n",
      active: true,
      refs: 0,
      disposed: false,
    })

    gateway.replaceGeneration(newTarget, "n+1")
    await gateway.waitForGenerationDisposed("n")
    expect(oldTarget.disposed).toBe(true)
  })

  test("pins an in-flight mutation to its original generation", async () => {
    const oldTarget = new FakeGateway("n")
    const newTarget = new FakeGateway("n+1")
    let finish!: () => void
    const blocked = new Promise<void>((resolve) => {
      finish = resolve
    })
    oldTarget.updateConfigImpl = () => blocked
    const gateway = new ProjectedPluginGateway(oldTarget, "n")

    const mutation = gateway.updateConfig("plugin", { updated: true })
    await Promise.resolve()
    gateway.replaceGeneration(newTarget, "n+1")

    expect(oldTarget.disposed).toBe(false)
    expect(gateway.generationDiagnostics()).toContainEqual({
      generationId: "n",
      active: false,
      refs: 1,
      disposed: false,
    })
    finish()
    await mutation
    await gateway.waitForGenerationDisposed("n")
    expect(oldTarget.disposed).toBe(true)
    expect(gateway.get("plugin")?.config).toEqual({ generation: "n+1" })
  })

  test("keeps old leases and prepared operations on the old generation", async () => {
    const oldTarget = new FakeGateway("n")
    const newTarget = new FakeGateway("n+1")
    const gateway = new ProjectedPluginGateway(oldTarget, "n")
    const facade = gateway
    const oldLease = gateway.acquireGeneration()
    const prepared = oldLease.operations().prepare("decisions", "model")
    expect(prepared).toBeDefined()
    if (!prepared) throw new Error("Expected prepared operation.")

    gateway.replaceGeneration(newTarget, "n+1")

    expect(gateway).toBe(facade)
    expect(oldTarget.disposed).toBe(false)
    expect(oldLease.get("plugin")?.description).toBe("n")
    expect(gateway.get("plugin")?.description).toBe("n+1")
    const newLease = gateway.acquireGeneration()
    expect(newLease.generationId).toBe("n+1")
    newLease.release()
    expect(
      (
        await prepared.execute({
          body: {},
          signal: call.signal,
          invocationId: "invocation",
          providerCallId: "provider-call",
          sequence: 1,
          origin: { kind: "http", client: "test" },
        })
      ).json,
    ).toEqual({
      generation: "n",
    })
    expect(oldTarget.calls).toEqual(["operation:n"])
    expect(newTarget.calls).toEqual([])

    prepared.release()
    expect(oldTarget.disposed).toBe(false)
    oldLease.release()
    await Promise.resolve()
    expect(oldTarget.disposed).toBe(true)
  })

  test("pins tool permission, approval, call, and output lookup through cutover", async () => {
    const oldTarget = new FakeGateway("n")
    const gateway = new ProjectedPluginGateway(oldTarget, "n")
    const lease = gateway.acquireGeneration()
    const offered = lease.listTools("plugin")[0]
    const newTarget = new FakeGateway("n+1")

    await Promise.resolve() // approval boundary
    gateway.replaceGeneration(newTarget, "n+1")
    const output = await lease.callTool(
      "plugin",
      offered.name,
      {},
      {
        signal: call.signal,
        approved: true,
      },
    )
    const projected = lease
      .listTools("plugin")
      .find((tool) => tool.name === offered.name)
    lease.release()
    await Promise.resolve()

    expect(projected?.description).toBe("n")
    expect(output.content[0]).toMatchObject({ text: "n" })
    expect(oldTarget.calls).toEqual(["tool:n"])
    expect(newTarget.calls).toEqual([])
    expect(oldTarget.disposed).toBe(true)
  })

  test("pins server-tool preparation and execution through cutover", async () => {
    const oldTarget = new FakeGateway("n")
    const gateway = new ProjectedPluginGateway(oldTarget, "n")
    const lease = gateway.acquireGeneration()
    const newTarget = new FakeGateway("n+1")

    gateway.replaceGeneration(newTarget, "n+1")
    const prepared = await lease.prepareServerTool("plugin", "server_echo", {})
    expect(prepared.estimate?.provider).toBe("n")
    const output = await prepared.execute({
      ...call,
      invocationId: "invocation",
      nextProviderCall: (operation, model) => ({
        invocationId: "invocation",
        providerCallId: "provider-call",
        sequence: 1,
        operation,
        model,
      }),
    })
    prepared.release()
    lease.release()
    await Promise.resolve()

    expect(output.content[0]).toMatchObject({ text: "n" })
    expect(oldTarget.calls).toEqual(["server:n"])
    expect(newTarget.calls).toEqual([])
    expect(oldTarget.disposed).toBe(true)
  })

  test("reports and awaits generation drain without ever retiring early", async () => {
    const oldTarget = new FakeGateway("n")
    const newTarget = new FakeGateway("n+1")
    const gateway = new ProjectedPluginGateway(oldTarget, "n")
    expect(gateway.currentGenerationId()).toBe("n")
    const lease = gateway.acquireGeneration()
    const prepared = await gateway.prepareServerTool(
      "plugin",
      "server_echo",
      {},
    )

    // An active generation is never idle.
    let activeIdle = false
    void gateway.waitForGenerationIdle("n").then(() => {
      activeIdle = true
    })
    gateway.replaceGeneration(newTarget, "n+1")
    expect(gateway.isActiveGateway(newTarget)).toBe(true)
    expect(gateway.isActiveGateway(oldTarget)).toBe(false)
    await Promise.resolve()
    expect(activeIdle).toBe(false)
    expect(gateway.generationDiagnostics()).toContainEqual({
      generationId: "n",
      active: false,
      refs: 2,
      disposed: false,
    })

    // The wait is abortable and the abort retires nothing.
    const abort = new AbortController()
    const aborted = gateway.waitForGatewayIdle(oldTarget, {
      signal: abort.signal,
    })
    abort.abort(new Error("gave up"))
    expect(String(await rejectionOf(aborted))).toContain("gave up")
    expect(oldTarget.disposed).toBe(false)

    lease.release()
    await Promise.resolve()
    expect(activeIdle).toBe(false)
    expect(oldTarget.disposed).toBe(false)
    prepared.release()
    await gateway.waitForGenerationIdle("n")
    await gateway.waitForGenerationDisposed("n")
    expect(activeIdle).toBe(true)
    expect(oldTarget.disposed).toBe(true)
    expect(newTarget.disposed).toBe(false)
    expect(
      gateway.generationDiagnostics().map((item) => item.generationId),
    ).toEqual(["n+1"])
    // Untracked generations are idle already.
    await gateway.waitForGenerationIdle("never-existed")
  })

  test("re-installs the active generation's id on a fresh gateway only", () => {
    const first = new FakeGateway("n")
    const second = new FakeGateway("n")
    const gateway = new ProjectedPluginGateway(first, "n")
    gateway.replaceGeneration(second, "n")
    expect(gateway.currentGenerationId()).toBe("n")
    expect(gateway.isActiveGateway(second)).toBe(true)
    expect(() => gateway.replaceGeneration(second, "n")).toThrow(
      "already exists",
    )
  })

  test("publishes cutover events to subscribers", () => {
    const gateway = new ProjectedPluginGateway(new FakeGateway("n"), "n")
    const seen: Array<string> = []
    gateway.subscribe((event) => seen.push(event.type))
    gateway.publishEvent({ type: "inventory", pluginId: "plugin" })
    expect(seen).toEqual(["inventory"])
  })

  test("holds a generation's own events behind the publisher when events are external", async () => {
    const oldTarget = new FakeGateway("n")
    const newTarget = new FakeGateway("n+1")
    const gateway = new ProjectedPluginGateway(oldTarget, "n", {
      externalEvents: true,
    })
    const seen: Array<string> = []
    gateway.subscribe((event) => seen.push(`${event.type}:${event.pluginId}`))

    // The pointer and snapshot swap synchronously, yet nothing reaches
    // subscribers: the new generation cannot bypass the publisher.
    gateway.replaceGeneration(newTarget, "n+1")
    newTarget.emit({ type: "lifecycle", pluginId: "early" })
    oldTarget.emit({ type: "lifecycle", pluginId: "old" })
    await Promise.resolve()
    expect(gateway.currentGenerationId()).toBe("n+1")
    expect(seen).toEqual([])

    // The publisher orders pre-install, diff and post-install events itself.
    gateway.publishEvent({ type: "tools", pluginId: "buffered" })
    gateway.publishEvent({ type: "inventory", pluginId: "diff" })
    gateway.publishEvent({ type: "status", pluginId: "after" })
    expect(seen).toEqual(["tools:buffered", "inventory:diff", "status:after"])
  })
})
