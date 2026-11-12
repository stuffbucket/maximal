/**
 * The `operations` service: registration, lifetime, resolution and dispatch,
 * through a real host with `services.extra: [operationsService]`.
 */
import type {
  Context,
  ModelOperation,
  OperationHandler,
  OperationRequest,
  PluginModule,
} from "@stuffbucket/maximal-plugin-sdk"

import { isOperationUnavailableError } from "@stuffbucket/maximal-plugin-sdk"
import { operationsService } from "@stuffbucket/maximal-plugin-sdk/runtime"
import { afterEach, describe, expect, test } from "bun:test"

import { createPluginHost, PluginContractError } from "../src/index"
import { runPluginConformance } from "../src/testing"
import { Empty, fakeHost, runCleanups, tempDir } from "./helpers"

interface Served {
  operation?: ModelOperation
  model: string
  provider?: string
  upstreamModel?: string
}

/** A `model` plugin that registers one handler (and exposes its disposer). */
function serving(
  id: string,
  served: ReadonlyArray<Served>,
  options: {
    operation?: ModelOperation
    calls?: Array<OperationRequest>
    onRegistered?: (dispose: () => void) => void
  } = {},
): PluginModule {
  return {
    name: id,
    manifest: {
      id,
      kind: "model",
      displayName: id,
      description: `${id} serves operations`,
      settingsVersion: 1,
    },
    inject: ["operations"],
    Config: Empty,
    apply(ctx: Context) {
      for (const entry of served) {
        const handler: OperationHandler = {
          operation: entry.operation ?? options.operation ?? "decisions",
          bindings: [
            {
              model: entry.model,
              provider: entry.provider ?? "copilot",
              upstreamModel: entry.upstreamModel ?? entry.model,
            },
          ],
          handle: (request) => {
            options.calls?.push(request)
            return Promise.resolve({
              json: { by: id, upstream: request.binding.upstreamModel },
              usage: { input_tokens: 1 },
            })
          },
        }
        const dispose = ctx.operations.register(handler)
        options.onRegistered?.(dispose)
      }
    },
  }
}

function hostOf(plugins: Array<PluginModule>) {
  const gateway = createPluginHost({
    plugins,
    services: {
      host: fakeHost(),
      storageRoot: tempDir(),
      extra: [operationsService],
    },
  })
  return gateway
}

const request = (
  operation: ModelOperation,
  model: string,
): Omit<OperationRequest, "binding"> => ({
  operation,
  model,
  body: { prompt: "x" },
  signal: new AbortController().signal,
  origin: { kind: "http", client: "test" },
})

const on = { enabled: true }
const handle = () => Promise.resolve({ json: {}, usage: {} })
const gateways: Array<{ dispose(): Promise<void> }> = []
afterEach(async () => {
  for (const gateway of gateways.splice(0)) await gateway.dispose()
  await runCleanups()
})
function start(plugins: Array<PluginModule>) {
  const gateway = hostOf(plugins)
  gateways.push(gateway)
  return gateway
}

describe("operations: registration and lifetime", () => {
  test("a registered handler is served while its plugin is enabled and withdrawn when it is disabled", async () => {
    const gateway = start([serving("alpha", [{ model: "m1" }])])
    const ops = gateway.operations()
    let notified = 0
    const unsubscribe = ops.subscribe(() => (notified += 1))

    expect(ops.servedModels()).toEqual([])
    await gateway.reconcile({ alpha: on })
    expect(ops.servedModels()).toEqual([
      {
        model: "m1",
        provider: "copilot",
        upstreamModel: "m1",
        operations: ["decisions"],
      },
    ])
    expect(notified).toBe(1)

    await gateway.reconcile({ alpha: { enabled: false } })
    expect(ops.servedModels()).toEqual([])
    expect(ops.resolve("decisions", "m1")).toBeUndefined()
    expect(notified).toBe(2)

    unsubscribe()
    await gateway.reconcile({ alpha: on })
    expect(notified).toBe(2)
  })

  test("a config reload withdraws the old fiber's registrations and re-registers", async () => {
    const gateway = start([serving("alpha", [{ model: "m1" }])])
    await gateway.reconcile({ alpha: on })
    await gateway.updateConfig("alpha", {})
    await gateway.reconcile({ alpha: on })
    expect(gateway.operations().servedModels()).toHaveLength(1)
  })

  test("the returned disposer withdraws one registration, idempotently, and frees its key", async () => {
    const disposers: Array<() => void> = []
    const gateway = start([
      serving("alpha", [{ model: "m1" }], {
        onRegistered: (dispose) => disposers.push(dispose),
      }),
    ])
    await gateway.reconcile({ alpha: on })
    const ops = gateway.operations()
    expect(ops.resolve("decisions", "m1")).toBeDefined()
    disposers[0]()
    disposers[0]()
    expect(ops.resolve("decisions", "m1")).toBeUndefined()
  })

  test("a duplicate (operation, provider, upstreamModel) fails the second plugin and leaves the first serving", async () => {
    const gateway = start([
      serving("alpha", [{ model: "m1" }]),
      serving("beta", [{ model: "other", upstreamModel: "m1" }]),
    ])
    await gateway.reconcile({ alpha: on, beta: on })
    expect(gateway.get("alpha")?.lifecycle).toBe("active")
    const beta = gateway.get("beta")
    expect(beta?.lifecycle).toBe("failed")
    expect(beta?.error).toMatch(/already does/)
    expect(gateway.operations().resolve("decisions", "m1")?.pluginId).toBe(
      "alpha",
    )
    expect(gateway.operations().resolve("decisions", "other")).toBeUndefined()
  })

  test("the same upstream model under another operation or provider is not a duplicate", async () => {
    const gateway = start([
      serving("alpha", [
        { model: "m1" },
        { model: "m1", operation: "systemone" },
        { model: "m1", provider: "foundry" },
      ]),
    ])
    await gateway.reconcile({ alpha: on })
    expect(gateway.get("alpha")?.lifecycle).toBe("active")
    expect(gateway.operations().servedModels()).toHaveLength(2)
  })

  test("a handler listing a binding twice is refused whole", async () => {
    let error: unknown
    const twice: PluginModule = {
      ...serving("alpha", []),
      apply(ctx) {
        const binding = { model: "m", provider: "p", upstreamModel: "u" }
        try {
          ctx.operations.register({
            operation: "decisions",
            bindings: [binding, binding],
            handle: () => Promise.resolve({ json: {}, usage: {} }),
          })
        } catch (caught) {
          error = caught
        }
      },
    }
    const gateway = start([twice])
    await gateway.reconcile({ alpha: on })
    expect(error).toBeInstanceOf(PluginContractError)
    expect(error).toMatchObject({ code: "duplicate-operation" })
    expect(gateway.operations().servedModels()).toEqual([])
  })

  test("malformed registrations throw invalid-operation", async () => {
    const errors: Array<unknown> = []
    const bad: PluginModule = {
      ...serving("alpha", []),
      apply(ctx) {
        const attempts = [
          { operation: "nope", bindings: [], handle },
          { operation: "decisions", bindings: [], handle },
          {
            operation: "decisions",
            bindings: [{ model: "m", provider: "a/b", upstreamModel: "u" }],
            handle,
          },
          {
            operation: "decisions",
            bindings: [{ model: "", provider: "a", upstreamModel: "u" }],
            handle,
          },
          {
            operation: "decisions",
            bindings: [{ model: "m", provider: "a", upstreamModel: "u" }],
          },
        ]
        for (const attempt of attempts) {
          try {
            ctx.operations.register(attempt as unknown as OperationHandler)
          } catch (caught) {
            errors.push(caught)
          }
        }
      },
    }
    const gateway = start([bad])
    await gateway.reconcile({ alpha: on })
    expect(errors).toHaveLength(5)
    for (const error of errors)
      expect(error).toMatchObject({ code: "invalid-operation" })
    expect(gateway.operations().servedModels()).toEqual([])
  })
})

describe("operations: resolve and dispatch", () => {
  test('"provider/model" matches exactly, even when the bare id is ambiguous', async () => {
    const gateway = start([
      serving("alpha", [{ model: "shared", provider: "copilot" }]),
      serving("beta", [{ model: "shared", provider: "foundry" }]),
    ])
    await gateway.reconcile({ alpha: on, beta: on })
    const ops = gateway.operations()
    expect(ops.resolve("decisions", "foundry/shared")).toEqual({
      pluginId: "beta",
      binding: { provider: "foundry", upstreamModel: "shared" },
    })
    expect(ops.resolve("decisions", "copilot/shared")?.pluginId).toBe("alpha")
    expect(ops.resolve("decisions", "bing/shared")).toBeUndefined()
  })

  test("a bare id resolves only when exactly one enabled binding serves it", async () => {
    const gateway = start([
      serving("alpha", [{ model: "shared", provider: "copilot" }]),
      serving("beta", [{ model: "shared", provider: "foundry" }]),
    ])
    const ops = gateway.operations()
    await gateway.reconcile({ alpha: on })
    expect(ops.resolve("decisions", "shared")?.pluginId).toBe("alpha")

    await gateway.reconcile({ alpha: on, beta: on })
    expect(ops.resolve("decisions", "shared")).toBeUndefined()

    await gateway.reconcile({ beta: on })
    expect(ops.resolve("decisions", "shared")?.pluginId).toBe("beta")
  })

  test("resolution is per operation", async () => {
    const gateway = start([
      serving("alpha", [{ model: "m1", operation: "images.generations" }]),
    ])
    await gateway.reconcile({ alpha: on })
    const ops = gateway.operations()
    expect(ops.resolve("images.generations", "m1")).toBeDefined()
    expect(ops.resolve("images.edits", "m1")).toBeUndefined()
  })

  test("dispatch calls the handler with the resolved binding", async () => {
    const calls: Array<OperationRequest> = []
    const gateway = start([
      serving(
        "alpha",
        [{ model: "client-name", provider: "copilot", upstreamModel: "up-1" }],
        { calls },
      ),
    ])
    await gateway.reconcile({ alpha: on })
    const result = await gateway
      .operations()
      .dispatch(request("decisions", "copilot/client-name"))
    expect(result.json).toEqual({ by: "alpha", upstream: "up-1" })
    expect(calls).toHaveLength(1)
    expect(calls[0].binding).toEqual({
      provider: "copilot",
      upstreamModel: "up-1",
    })
    expect(calls[0].model).toBe("copilot/client-name")
  })

  test("an unresolved model throws OperationUnavailableError", async () => {
    const gateway = start([serving("alpha", [{ model: "m1" }])])
    const ops = gateway.operations()
    // plugin not enabled yet
    const off = await ops
      .dispatch(request("decisions", "m1"))
      .catch((error: unknown) => error)
    expect(isOperationUnavailableError(off)).toBe(true)
    expect(off).toMatchObject({ operation: "decisions", model: "m1" })

    await gateway.reconcile({ alpha: on })
    const unknown = await ops
      .dispatch(request("decisions", "nope"))
      .catch((error: unknown) => error)
    expect(isOperationUnavailableError(unknown)).toBe(true)
  })

  test("a host without the operations service answers unavailable", async () => {
    const gateway = createPluginHost({
      plugins: [],
      services: { host: fakeHost(), storageRoot: tempDir() },
    })
    gateways.push(gateway)
    const ops = gateway.operations()
    expect(ops.servedModels()).toEqual([])
    expect(ops.resolve("decisions", "m1")).toBeUndefined()
    expect(ops.subscribe(() => {})).toBeInstanceOf(Function)
    const error = await ops
      .dispatch(request("decisions", "m1"))
      .catch((caught: unknown) => caught)
    expect(isOperationUnavailableError(error)).toBe(true)
  })

  test("servedModels merges the operations one binding serves", async () => {
    const gateway = start([
      serving("alpha", [
        { model: "m1", operation: "images.generations" },
        { model: "m1", operation: "images.edits" },
      ]),
    ])
    await gateway.reconcile({ alpha: on })
    expect(gateway.operations().servedModels()).toEqual([
      {
        model: "m1",
        provider: "copilot",
        upstreamModel: "m1",
        operations: ["images.generations", "images.edits"],
      },
    ])
  })
})

runPluginConformance(serving("conformant", [{ model: "m1" }]), {
  harness: { extraServices: [operationsService] },
})
