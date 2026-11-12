import type {
  PluginModule,
  PluginResourceLifecycle,
} from "@stuffbucket/maximal-plugin-sdk"
import type { PluginSettingsAuthority } from "@stuffbucket/maximal-plugin-sdk/runtime"

import {
  createFileStorage,
  createStorageSettingsAuthority,
} from "@stuffbucket/maximal-plugin-sdk/runtime"
import { afterEach, describe, expect, test } from "bun:test"
import { z } from "zod"

import { pluginHostInternals } from "../src/host"
import { createPluginHost, PluginGatewayError } from "../src/index"
import {
  createHost,
  define,
  Empty,
  expectGatewayError,
  fakeHost,
  runCleanups,
  tempDir,
  tool,
} from "./helpers"

interface Catalog {
  version: string
}

const external = (specifier: string) =>
  ({ type: "external", specifier }) as const

async function eventually(check: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (check()) return
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
  throw new Error("condition did not become true")
}

function failFirstSnapshotAfterCommit(
  authority: PluginSettingsAuthority,
): PluginSettingsAuthority {
  let failNextSnapshot = false
  return {
    snapshot: (pluginId) => {
      if (!failNextSnapshot) return authority.snapshot(pluginId)
      failNextSnapshot = false
      return Promise.reject(new Error("post-commit snapshot failed"))
    },
    commit: (proposal) => authority.commit(proposal),
    epoch: () => authority.epoch(),
    beginTransaction: () => {
      const transaction = authority.beginTransaction()
      return {
        ...transaction,
        finish: async () => {
          const commits = await transaction.finish()
          failNextSnapshot = true
          return commits
        },
      }
    },
  }
}

function provider(
  version: string,
  options: { fail?: boolean; partial?: boolean } = {},
): PluginModule {
  const base = define("provider", Empty, (ctx) => {
    ctx.provide("catalog", { version } satisfies Catalog)
    if (options.partial) {
      ctx.tools.register(tool("partial"))
      ctx.surface.registerAction("partial", () => Promise.resolve())
      ctx.surface.setStatus({
        state: "working",
        code: "partial",
        summary: "Partial",
      })
    }
    if (options.fail) throw new Error(`provider ${version} failed`)
  })
  return { ...base, provides: ["catalog"] }
}

function consumer(
  observed: Array<string>,
  cleanups: Array<string>,
): PluginModule {
  const base = define("consumer", Empty, (ctx) => {
    const catalog = ctx.get("catalog") as Catalog
    observed.push(catalog.version)
    ctx.tools.register(tool("consume"))
    ctx.surface.registerAction("refresh", () => Promise.resolve())
    ctx.surface.setStatus({
      state: "ready",
      code: `catalog-${catalog.version}`,
      summary: `Catalog ${catalog.version}`,
    })
    // eslint-disable-next-line unicorn/consistent-function-scoping -- captures this activation's catalog and cleanup sink
    ctx.effect(() => () => void cleanups.push(catalog.version))
  })
  return {
    ...base,
    inject: [...(base.inject as ReadonlyArray<string>), "catalog"],
  }
}

afterEach(runCleanups)

// eslint-disable-next-line max-lines-per-function -- dependency lifecycle scenarios share provider and consumer fixtures
describe("Cordis dependency lifecycle", () => {
  test("keeps a stable pending fiber and activates it when the provider arrives", async () => {
    const observed: Array<string> = []
    const cleanups: Array<string> = []
    const { gateway } = createHost([
      consumer(observed, cleanups),
      provider("one"),
    ])

    await gateway.reconcile({ consumer: { enabled: true } })
    const pendingFiber = pluginHostInternals(gateway)?.fiber("consumer")
    expect(pendingFiber).toBeDefined()
    expect(gateway.get("consumer")).toMatchObject({
      lifecycle: "waiting",
      waitingForServices: ["catalog"],
      waitingReason: "Waiting for required service: catalog.",
      tools: [],
    })

    await gateway.reconcile({ consumer: { enabled: true } })
    expect(pluginHostInternals(gateway)?.fiber("consumer")).toBe(pendingFiber)
    expect(observed).toEqual([])

    await gateway.reconcile({
      consumer: { enabled: true },
      provider: { enabled: true },
    })
    await eventually(() => gateway.get("consumer")?.lifecycle === "active")
    expect(observed).toEqual(["one"])
    expect(gateway.listTools("consumer").map((item) => item.name)).toEqual([
      "consume",
    ])
    expect(gateway.get("consumer")?.status?.code).toBe("catalog-one")
    expect(cleanups).toEqual([])
  })

  test("fences exclusive resources across delayed dependency activation epochs", async () => {
    const calls = { prepare: 0, commit: 0, revoke: 0 }
    const lifecycles: Array<PluginResourceLifecycle> = []
    const base = define("consumer", Empty, () => {})
    const dependent: PluginModule = {
      ...base,
      inject: [...(base.inject as ReadonlyArray<string>), "catalog"],
      apply: (ctx) => {
        void ctx.get("catalog")
        const lifecycle: PluginResourceLifecycle = {
          declaration: {
            mode: "exclusive",
            resources: ["fixture:delayed-singleton"],
          },
          prepare: () => {
            calls.prepare += 1
            return Promise.resolve()
          },
          commit: () => {
            calls.commit += 1
            return Promise.resolve()
          },
          revoke: () => {
            calls.revoke += 1
            return Promise.resolve()
          },
          resume: () => Promise.resolve(),
        }
        lifecycles.push(lifecycle)
        return lifecycle
      },
    }
    const { gateway } = createHost([dependent, provider("one")])

    await gateway.reconcile({ consumer: { enabled: true } })
    expect(gateway.get("consumer")?.lifecycle).toBe("waiting")
    expect(calls).toEqual({ prepare: 0, commit: 0, revoke: 0 })

    await gateway.reconcile({
      consumer: { enabled: true },
      provider: { enabled: true },
    })
    await eventually(() => gateway.get("consumer")?.lifecycle === "active")
    expect(calls).toEqual({ prepare: 1, commit: 1, revoke: 0 })
    expect(lifecycles).toHaveLength(1)
    expect(
      gateway
        .resourceLifecycle()
        .list()
        .find((item) => item.pluginId === "consumer"),
    ).toMatchObject({ pluginId: "consumer", phase: "committed" })

    await gateway.removePlugin("provider")
    await eventually(() => gateway.get("consumer")?.lifecycle === "waiting")
    expect(calls).toEqual({ prepare: 1, commit: 1, revoke: 1 })
    expect(gateway.resourceLifecycle().list()).toEqual([])

    await gateway.addPlugin(provider("two"), external("fixture:provider-two"))
    await eventually(() => gateway.get("consumer")?.lifecycle === "active")
    expect(calls).toEqual({ prepare: 2, commit: 2, revoke: 1 })
    expect(lifecycles).toHaveLength(2)
    expect(
      gateway
        .resourceLifecycle()
        .list()
        .find((item) => item.pluginId === "consumer"),
    ).toMatchObject({ pluginId: "consumer", phase: "committed" })

    await gateway.reconcile({
      consumer: { enabled: false },
      provider: { enabled: true },
    })
    expect(calls).toEqual({ prepare: 2, commit: 2, revoke: 2 })
    expect(
      gateway
        .resourceLifecycle()
        .list()
        .find((item) => item.pluginId === "consumer"),
    ).toBeUndefined()
  })

  test("delayed candidate activation prepares without binding before generation commit", async () => {
    const calls = { prepare: 0, commit: 0, revoke: 0 }
    const base = define("consumer", Empty, () => {})
    const dependent: PluginModule = {
      ...base,
      inject: [...(base.inject as ReadonlyArray<string>), "catalog"],
      apply: (ctx) => {
        void ctx.get("catalog")
        return {
          declaration: {
            mode: "exclusive" as const,
            resources: ["fixture:candidate-singleton"],
          },
          prepare: () => {
            calls.prepare += 1
            return Promise.resolve()
          },
          commit: () => {
            calls.commit += 1
            return Promise.resolve()
          },
          revoke: () => {
            calls.revoke += 1
            return Promise.resolve()
          },
          resume: () => Promise.resolve(),
        }
      },
    }
    const storageRoot = tempDir()
    const storage = createFileStorage(storageRoot)
    const gateway = createPluginHost({
      plugins: [dependent, provider("one")],
      services: {
        host: fakeHost(),
        storageRoot,
        storage,
        settingsAuthority: createStorageSettingsAuthority(storage),
      },
      resourceActivation: { mode: "candidate" },
    })
    try {
      await gateway.reconcile({ consumer: { enabled: true } })
      expect(calls).toEqual({ prepare: 0, commit: 0, revoke: 0 })

      await gateway.reconcile({
        consumer: { enabled: true },
        provider: { enabled: true },
      })
      await eventually(() => gateway.get("consumer")?.lifecycle === "active")
      expect(calls).toEqual({ prepare: 1, commit: 0, revoke: 0 })
      expect(
        gateway
          .resourceLifecycle()
          .list()
          .find((item) => item.pluginId === "consumer"),
      ).toMatchObject({ pluginId: "consumer", phase: "prepared" })

      await gateway.resourceLifecycle().commit()
      expect(calls).toEqual({ prepare: 1, commit: 1, revoke: 0 })
      expect(
        gateway
          .resourceLifecycle()
          .list()
          .find((item) => item.pluginId === "consumer"),
      ).toMatchObject({ pluginId: "consumer", phase: "committed" })
    } finally {
      await gateway.dispose()
    }
    expect(calls.revoke).toBe(1)
  })

  test("provider removal and re-add restarts the consumer without leaked contributions", async () => {
    const observed: Array<string> = []
    const cleanups: Array<string> = []
    const { gateway } = createHost([
      provider("one"),
      consumer(observed, cleanups),
    ])
    await gateway.reconcile({
      provider: { enabled: true },
      consumer: { enabled: true },
    })
    await eventually(() => gateway.get("consumer")?.lifecycle === "active")

    await gateway.removePlugin("provider")
    await eventually(() => gateway.get("consumer")?.lifecycle === "waiting")
    expect(gateway.listTools("consumer")).toEqual([])
    expect(gateway.get("consumer")?.status).toBeUndefined()
    await expectGatewayError(
      gateway.runAction("consumer", "refresh"),
      "plugin-inactive",
    )
    expect(cleanups).toEqual(["one"])

    await gateway.addPlugin(provider("two"), external("fixture:provider-two"))
    await eventually(() => gateway.get("consumer")?.lifecycle === "active")
    expect(observed).toEqual(["one", "two"])
    expect(gateway.listTools("consumer").map((item) => item.name)).toEqual([
      "consume",
    ])
    expect(gateway.get("consumer")?.status?.code).toBe("catalog-two")
    await gateway.runAction("consumer", "refresh")
  })

  test("dependency withdrawal aborts the old activation epoch and reactivation gets a fresh signal", async () => {
    const signals: Array<AbortSignal> = []
    const base = define("consumer", Empty, (ctx) => {
      ctx.tools.register(
        tool("probe", (_input, call) => {
          signals.push(call.signal)
          return Promise.resolve({ content: [{ type: "text", text: "ok" }] })
        }),
      )
      void ctx.get("catalog")
    })
    const dependent = {
      ...base,
      inject: [...(base.inject as ReadonlyArray<string>), "catalog"],
    }
    const { gateway } = createHost([provider("one"), dependent])
    await gateway.reconcile({
      provider: { enabled: true },
      consumer: { enabled: true },
    })
    await eventually(() => gateway.get("consumer")?.lifecycle === "active")
    const call = { signal: new AbortController().signal }
    await gateway.callTool("consumer", "probe", {}, call)

    await gateway.removePlugin("provider")
    await eventually(() => gateway.get("consumer")?.lifecycle === "waiting")
    expect(signals[0]?.aborted).toBe(true)

    await gateway.addPlugin(provider("two"), external("fixture:provider-two"))
    await eventually(() => gateway.get("consumer")?.lifecycle === "active")
    await gateway.callTool("consumer", "probe", {}, call)
    expect(signals[1]).not.toBe(signals[0])
    expect(signals[1]?.aborted).toBe(false)
  })

  test("provider replacement restarts the consumer once with no duplicate tools, actions, or status", async () => {
    const observed: Array<string> = []
    const cleanups: Array<string> = []
    const { gateway } = createHost([
      provider("one"),
      consumer(observed, cleanups),
    ])
    await gateway.reconcile({
      provider: { enabled: true },
      consumer: { enabled: true },
    })
    await eventually(() => gateway.get("consumer")?.lifecycle === "active")

    await gateway.replacePlugin(
      "provider",
      provider("two"),
      external("fixture:provider-two"),
    )
    await eventually(
      () =>
        gateway.get("consumer")?.lifecycle === "active"
        && gateway.get("consumer")?.status?.code === "catalog-two",
    )
    expect(observed).toEqual(["one", "two"])
    expect(cleanups).toEqual(["one"])
    expect(gateway.listTools("consumer").map((item) => item.name)).toEqual([
      "consume",
    ])
    await gateway.runAction("consumer", "refresh")
    expect(gateway.get("provider")?.source).toEqual({
      type: "external",
      specifier: "fixture:provider-two",
    })
  })

  test("a partially failing provider cleans up and leaves its consumer waiting", async () => {
    const observed: Array<string> = []
    const { gateway } = createHost([
      provider("broken", { fail: true, partial: true }),
      consumer(observed, []),
    ])
    await gateway.reconcile({
      provider: { enabled: true },
      consumer: { enabled: true },
    })
    await eventually(() => gateway.get("provider")?.lifecycle === "failed")
    await eventually(() => gateway.get("consumer")?.lifecycle === "waiting")

    expect(gateway.get("provider")).toMatchObject({
      lifecycle: "failed",
      tools: [],
      error: "provider broken failed",
    })
    expect(gateway.get("provider")?.status).toBeUndefined()
    expect(gateway.listTools("provider")).toEqual([])
    await expectGatewayError(
      gateway.runAction("provider", "partial"),
      "plugin-inactive",
    )
    expect(observed).toEqual([])
  })

  test("shutdown disposes pending fibers", async () => {
    const { gateway } = createHost([consumer([], []), provider("one")])
    await gateway.reconcile({ consumer: { enabled: true } })
    expect(gateway.get("consumer")?.lifecycle).toBe("waiting")
    expect(pluginHostInternals(gateway)?.fiber("consumer")).toBeDefined()

    await gateway.dispose()
    expect(pluginHostInternals(gateway)?.fiber("consumer")).toBeUndefined()
    expect(gateway.get("consumer")).toMatchObject({
      enabled: false,
      lifecycle: "disabled",
      tools: [],
    })
  })
})

// eslint-disable-next-line max-lines-per-function -- mutable inventory lifecycle scenarios share fixtures
describe("mutable inventory", () => {
  test("a post-commit load failure clears buffering before later events", async () => {
    const storageRoot = tempDir()
    const storage = createFileStorage(storageRoot)
    const authority = failFirstSnapshotAfterCommit(
      createStorageSettingsAuthority(storage),
    )
    const gateway = createPluginHost({
      plugins: [],
      services: {
        host: fakeHost(),
        storageRoot,
        storage,
        settingsAuthority: authority,
      },
    })
    const events: Array<string> = []
    const unsubscribe = gateway.subscribe((event) =>
      events.push(`${event.type}:${event.pluginId}`),
    )
    try {
      await gateway.reconcile({ alpha: { enabled: true } })
      const alpha = define("alpha", Empty, (ctx) => {
        ctx.tools.register(tool("one"))
      })

      const error = await gateway
        .replaceInventory([
          { module: alpha, source: external("fixture:alpha") },
        ])
        .catch((cause: unknown) => cause)
      expect(error).toEqual(new Error("post-commit snapshot failed"))

      events.length = 0
      await gateway.reconcile({ alpha: { enabled: false } })
      expect(events).toContain("lifecycle:alpha")
    } finally {
      unsubscribe()
      await gateway.dispose()
    }
  })

  test("adds, removes, and replaces entries while retaining the last desired settings", async () => {
    const { gateway, events } = createHost([])
    await gateway.reconcile({ alpha: { enabled: true } })

    await gateway.addPlugin(
      define("alpha", Empty, (ctx) => void ctx.tools.register(tool("one"))),
      external("fixture:alpha-one"),
    )
    expect(gateway.get("alpha")).toMatchObject({
      lifecycle: "active",
      source: { type: "external", specifier: "fixture:alpha-one" },
      tools: [{ name: "one" }],
    })

    await gateway.replacePlugin(
      "alpha",
      define("alpha", Empty, (ctx) => void ctx.tools.register(tool("two"))),
      external("fixture:alpha-two"),
    )
    expect(gateway.listTools("alpha").map((item) => item.name)).toEqual(["two"])

    await gateway.removePlugin("alpha")
    expect(gateway.get("alpha")).toBeUndefined()
    expect(events.filter((event) => event.type === "inventory")).toHaveLength(3)
  })

  test("failed replacement restores and restarts the previous entry", async () => {
    let oldStarts = 0
    const old = define("alpha", Empty, (ctx) => {
      oldStarts++
      ctx.tools.register(tool("old"))
      ctx.surface.setStatus({ state: "ready", code: "old", summary: "Old" })
    })
    const replacement = define("alpha", Empty, (ctx) => {
      ctx.tools.register(tool("leaked"))
      ctx.surface.registerAction("leaked", () => Promise.resolve())
      ctx.surface.setStatus({
        state: "working",
        code: "leaked",
        summary: "Leaked",
      })
      throw new Error("replacement exploded")
    })
    const { gateway } = createHost([old])
    await gateway.reconcile({ alpha: { enabled: true } })

    expect(
      await gateway
        .replacePlugin("alpha", replacement, external("fixture:broken"))
        .then(
          () => "resolved",
          (error: unknown) =>
            error instanceof Error ? error.message : String(error),
        ),
    ).toContain("was not ready and was rolled back")
    expect(oldStarts).toBe(2)
    expect(gateway.get("alpha")).toMatchObject({
      lifecycle: "active",
      source: { type: "built-in" },
      status: { code: "old" },
      tools: [{ name: "old" }],
    })
    expect(gateway.listTools("alpha").map((item) => item.name)).toEqual(["old"])
    await expectGatewayError(
      gateway.runAction("alpha", "leaked"),
      "unknown-action",
    )
    await gateway.reconcile({ alpha: { enabled: false } })
    expect(gateway.toolViews("alpha").map((item) => item.name)).toEqual(["old"])
  })

  test("restores the previous record while failed candidate cleanup stays quarantined", async () => {
    let oldStarts = 0
    let failRevoke = true
    let candidatePhysical = false
    const old = define("alpha", Empty, (ctx) => {
      oldStarts += 1
      ctx.tools.register(tool("old"))
      ctx.surface.setStatus({ state: "ready", code: "old", summary: "Old" })
    })
    const base = define("alpha", Empty, () => {})
    const replacement: PluginModule = {
      ...base,
      apply: (ctx) => {
        ctx.tools.register(tool("candidate"))
        return {
          declaration: {
            mode: "exclusive" as const,
            resources: ["fixture:replacement-singleton"],
          },
          prepare: () => Promise.resolve(),
          commit: () => {
            candidatePhysical = true
            throw new Error("candidate commit failed")
          },
          revoke: () => {
            if (failRevoke) throw new Error("candidate revoke failed")
            candidatePhysical = false
            return Promise.resolve()
          },
          resume: () => Promise.resolve(),
        }
      },
    }
    const { gateway } = createHost([old])
    await gateway.reconcile({ alpha: { enabled: true } })

    const replacementError = await gateway
      .replacePlugin("alpha", replacement, external("fixture:quarantined"))
      .then(
        () => undefined,
        (error: unknown) => error,
      )
    expect(replacementError).toBeInstanceOf(PluginGatewayError)
    expect(replacementError as PluginGatewayError).toMatchObject({
      code: "replacement-not-ready",
      pluginId: "alpha",
    })
    expect((replacementError as Error).message).toContain("cleanup failed")
    expect((replacementError as Error).message).toContain(
      "rollback is deferred",
    )
    expect(candidatePhysical).toBe(true)
    expect(oldStarts).toBe(1)
    expect(gateway.get("alpha")).toMatchObject({
      lifecycle: "failed",
      source: { type: "built-in" },
      tools: [],
    })
    expect(gateway.resourceLifecycle().list()).toMatchObject([
      {
        pluginId: "alpha",
        declaration: {
          mode: "exclusive",
          resources: ["fixture:replacement-singleton"],
        },
        phase: "committed",
      },
    ])

    failRevoke = false
    await gateway.reconcile({ alpha: { enabled: true } })
    expect(candidatePhysical).toBe(false)
    expect(oldStarts).toBe(2)
    expect(gateway.get("alpha")).toMatchObject({
      lifecycle: "active",
      source: { type: "built-in" },
      status: { code: "old" },
      tools: [{ name: "old" }],
    })
    expect(gateway.resourceLifecycle().list()).toEqual([
      {
        pluginId: "alpha",
        declaration: { mode: "overlap-safe" },
        phase: "committed",
      },
    ])
  })

  test("queued config updates resolve the replacement record", async () => {
    const OldConfig = z.object({ old: z.string().optional() })
    const NewConfig = z.object({ next: z.string().default("initial") })
    const seen: Array<string> = []
    const old = define("alpha", OldConfig, () => {})
    const replacement = define("alpha", NewConfig, (_ctx, config) => {
      seen.push(config.next)
    })
    const { gateway } = createHost([old])
    await gateway.reconcile({ alpha: { enabled: true } })

    const replacing = gateway.replacePlugin(
      "alpha",
      replacement,
      external("fixture:replacement"),
    )
    const updating = gateway.updateConfig("alpha", { next: "updated" })
    await Promise.all([replacing, updating])

    expect(seen).toEqual(["initial", "updated"])
    expect(gateway.get("alpha")).toMatchObject({
      lifecycle: "active",
      config: { next: "updated" },
      source: { type: "external", specifier: "fixture:replacement" },
    })
  })

  test("a permission write queued during failed replacement survives rollback", async () => {
    let candidateStarted!: () => void
    const started = new Promise<void>((resolve) => {
      candidateStarted = resolve
    })
    let releaseCandidate!: () => void
    const released = new Promise<void>((resolve) => {
      releaseCandidate = resolve
    })
    const old = define("alpha", Empty, (ctx) => {
      ctx.tools.register(tool("read"))
    })
    const replacement = define("alpha", Empty, async () => {
      candidateStarted()
      await released
      throw new Error("candidate failed")
    })
    const { gateway } = createHost([old])
    await gateway.reconcile({ alpha: { enabled: true } })

    const replacementResult = gateway
      .replacePlugin("alpha", replacement, external("fixture:broken"))
      .then(
        () => undefined,
        (error: unknown) => error,
      )
    await started
    const permissionWrite = gateway.setToolPermissions("alpha", {
      read: "block",
    })
    releaseCandidate()

    const replacementError = await replacementResult
    expect(replacementError).toBeInstanceOf(PluginGatewayError)
    expect((replacementError as PluginGatewayError).code).toBe(
      "replacement-not-ready",
    )
    await permissionWrite
    // Re-read the settings file to prove rollback did not merely leave the
    // permission in memory while restoring an older file on disk.
    await gateway.reconcile({ alpha: { enabled: true } })
    expect(gateway.toolViews("alpha")).toHaveLength(1)
    expect(gateway.toolViews("alpha")[0]).toMatchObject({
      name: "read",
      permission: "block",
      permissionSource: "user",
    })
  })

  test("a waiting replacement rolls back and cannot activate on later provider arrival", async () => {
    let candidateStarts = 0
    const old = define("alpha", Empty, (ctx) => {
      ctx.tools.register(tool("old"))
    })
    const candidateBase = define("alpha", Empty, (ctx) => {
      candidateStarts++
      void ctx.get("catalog")
      ctx.tools.register(tool("candidate"))
    })
    const candidate = {
      ...candidateBase,
      inject: [...(candidateBase.inject as ReadonlyArray<string>), "catalog"],
    }
    const { gateway } = createHost([old, provider("one")])
    await gateway.reconcile({ alpha: { enabled: true } })

    const replacementError = await gateway
      .replacePlugin("alpha", candidate, external("fixture:waiting"))
      .then(
        () => undefined,
        (error: unknown) => error,
      )
    expect(replacementError).toBeInstanceOf(PluginGatewayError)
    expect(replacementError as PluginGatewayError).toMatchObject({
      code: "replacement-not-ready",
      pluginId: "alpha",
    })
    expect((replacementError as Error).message).toContain(
      "Waiting for required service: catalog.",
    )
    expect(gateway.get("alpha")).toMatchObject({
      lifecycle: "active",
      source: { type: "built-in" },
      tools: [{ name: "old" }],
    })

    await gateway.reconcile({
      alpha: { enabled: true },
      provider: { enabled: true },
    })
    await eventually(() => gateway.get("provider")?.lifecycle === "active")
    expect(candidateStarts).toBe(0)
    expect(gateway.listTools("alpha").map((item) => item.name)).toEqual(["old"])
  })

  test("requires explicit, well-formed service declarations", () => {
    const dependency = define("consumer", Empty, () => {})
    expect(() =>
      createHost([{ ...dependency, inject: ["tools", "catalog"] }]),
    ).toThrow(/requires missing service: catalog/)
    expect(() =>
      createHost([{ ...dependency, provides: ["Bad Service"] }]),
    ).toThrow(/invalid or duplicate provided service/)
    expect(() =>
      createHost([{ ...dependency, provides: ["catalog", "catalog"] }]),
    ).toThrow(/invalid or duplicate provided service/)
  })
})
