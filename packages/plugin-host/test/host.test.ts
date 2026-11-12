import type { PluginModule } from "@stuffbucket/maximal-plugin-sdk"
import type { Context } from "@stuffbucket/maximal-plugin-sdk"
import type { PluginGateway } from "@stuffbucket/maximal-plugin-sdk/gateway"

import { afterEach, describe, expect, test } from "bun:test"
import { readdirSync, statSync } from "node:fs"
import path from "node:path"
import { z } from "zod"

import { PluginContractError } from "../src/index"
import * as echo from "./fixtures/echo"
import {
  buildHost,
  createHost,
  define,
  Empty,
  envelope,
  expectGatewayError,
  fakeHost,
  noop,
  runCleanups,
  seedSettings,
  tempDir,
  tool,
} from "./helpers"
import { rejectionMessage } from "./rejection"

afterEach(runCleanups)

describe("createPluginHost validation", () => {
  test("rejects malformed modules, duplicate ids and missing services", () => {
    const ok = define("alpha", Empty, () => {})
    expect(buildHost([{ ...ok, name: "Alpha" }])).toThrow(PluginContractError)
    expect(buildHost([{ ...ok, apply: undefined }])).toThrow(
      /must export apply/,
    )
    expect(buildHost([{ ...ok, Config: {} }])).toThrow(/Standard Schema/)
    expect(buildHost([ok, ok])).toThrow(/Duplicate plugin id "alpha"/)
    expect(buildHost([{ ...ok, inject: ["tools", "llm"] }])).toThrow(
      /requires missing service: llm/,
    )
  })

  test("starts with every plugin disabled", async () => {
    const { gateway } = createHost([define("alpha", Empty, () => {})])
    await gateway.reconcile(undefined)
    expect(gateway.list()).toEqual([
      {
        id: "alpha",
        kind: "extension",
        displayName: "ALPHA",
        description: "alpha plugin",
        homepage: "https://example.test/alpha",
        manifest: {
          id: "alpha",
          kind: "extension",
          displayName: "ALPHA",
          description: "alpha plugin",
          homepage: "https://example.test/alpha",
          settingsVersion: 1,
        },
        settingsVersion: 1,
        config: {},
        enabled: false,
        lifecycle: "disabled",
        tools: [],
        toolsSource: "none",
      },
    ])
    expect(gateway.get("alpha")?.lifecycle).toBe("disabled")
    expect(gateway.get("nope")).toBeUndefined()
  })
})

describe("reconcile", () => {
  test("enable → tools appear; disable → they vanish", async () => {
    const disposed: Array<string> = []
    const onDispose = () => void disposed.push("alpha")
    const alpha = define("alpha", Empty, (ctx) => {
      ctx.tools.register(tool("search"))
      ctx.surface.setStatus({ state: "ready", code: "ready", summary: "Ready" })
      ctx.effect(() => onDispose)
    })
    const { gateway, events } = createHost([alpha])

    await gateway.reconcile({ alpha: { enabled: true } })
    const snapshot = gateway.get("alpha")
    expect(snapshot?.lifecycle).toBe("active")
    expect(snapshot?.enabled).toBe(true)
    expect(snapshot?.status).toEqual({
      state: "ready",
      code: "ready",
      summary: "Ready",
    })
    expect(snapshot?.tools).toEqual([
      {
        name: "search",
        description: "search tool",
        annotations: { readOnlyHint: true },
      },
    ])
    expect(gateway.listTools("alpha")).toEqual([
      {
        name: "search",
        description: "search tool",
        inputSchema: { type: "object", properties: { q: { type: "string" } } },
        annotations: { readOnlyHint: true },
        permission: "allow",
      },
    ])
    expect(events).toContainEqual({ type: "tools", pluginId: "alpha" })
    expect(events).toContainEqual({ type: "status", pluginId: "alpha" })
    expect(events.filter((e) => e.type === "lifecycle")).toHaveLength(2) // starting, active

    events.length = 0
    await gateway.reconcile({ alpha: { enabled: false } })
    expect(disposed).toEqual(["alpha"])
    expect(gateway.get("alpha")).toMatchObject({
      lifecycle: "disabled",
      enabled: false,
      tools: [],
    })
    expect(gateway.get("alpha")?.status).toBeUndefined()
    expect(gateway.listTools("alpha")).toEqual([])
    expect(events).toEqual([
      { type: "tools", pluginId: "alpha" },
      { type: "status", pluginId: "alpha" },
      { type: "lifecycle", pluginId: "alpha" },
    ])
  })

  test("updateConfig reloads; an equal config (any key order) does not", async () => {
    const Config = z.object({
      greeting: z.string().default("hi"),
      punct: z.string().default("!"),
    })
    const applied: Array<z.output<typeof Config>> = []
    let disposals = 0
    const onDispose = () => void disposals++
    const alpha = define("alpha", Config, (ctx, config) => {
      applied.push(config)
      ctx.tools.register(tool(`say-${config.greeting}`))
      ctx.effect(() => onDispose)
    })
    const { gateway } = createHost([alpha])

    await gateway.reconcile({ alpha: { enabled: true } })
    expect(applied).toEqual([{ greeting: "hi", punct: "!" }])

    await gateway.reconcile({ alpha: { enabled: true } })
    expect(applied).toHaveLength(1)

    await gateway.updateConfig("alpha", { greeting: "yo", punct: "?" })
    await gateway.updateConfig("alpha", { punct: "?", greeting: "yo" })
    await gateway.reconcile({ alpha: { enabled: true } })
    expect(applied).toEqual([
      { greeting: "hi", punct: "!" },
      { greeting: "yo", punct: "?" },
    ])
    expect(disposals).toBe(1)
    expect(gateway.get("alpha")?.tools.map((t) => t.name)).toEqual(["say-yo"])
  })

  test("invalid config fails only that plugin, with a path-qualified error", async () => {
    const Config = z.object({
      endpoint: z.url().optional(),
      retries: z.number().int().default(3),
    })
    const alpha = define(
      "alpha",
      Config,
      (ctx) => void ctx.tools.register(tool("a")),
    )
    const beta = define(
      "beta",
      Empty,
      (ctx) => void ctx.tools.register(tool("b")),
    )
    const root = tempDir()
    seedSettings(
      root,
      "alpha",
      envelope("alpha", { endpoint: "not a url", retries: 1.5 }),
    )
    const { gateway } = createHost([alpha, beta], fakeHost(), root)

    await gateway.reconcile({
      alpha: { enabled: true },
      beta: { enabled: true },
    })
    const failed = gateway.get("alpha")
    expect(failed?.lifecycle).toBe("failed")
    expect(failed?.error).toMatch(/^alpha\.endpoint: /m)
    expect(failed?.error).toMatch(/^alpha\.retries: /m)
    expect(failed?.tools).toEqual([])
    expect(gateway.get("beta")?.lifecycle).toBe("active")
    await expectGatewayError(
      gateway.callTool(
        "alpha",
        "a",
        {},
        { signal: new AbortController().signal },
      ),
      "plugin-inactive",
    )

    // Same invalid config: stays failed; fixed config (edited on disk): recovers.
    await gateway.reconcile({
      alpha: { enabled: true },
      beta: { enabled: true },
    })
    expect(gateway.get("alpha")?.lifecycle).toBe("failed")
    seedSettings(root, "alpha", envelope("alpha", { retries: 2 }))
    await gateway.reconcile({
      alpha: { enabled: true },
      beta: { enabled: true },
    })
    expect(gateway.get("alpha")).toMatchObject({
      lifecycle: "active",
      tools: [{ name: "a" }],
    })
    expect(gateway.get("alpha")?.error).toBeUndefined()
  })

  test("apply throwing fails only that plugin and withdraws partial contributions", async () => {
    let attempts = 0
    let cleaned = 0
    const onCleanup = () => void cleaned++
    const flaky = define("flaky", Empty, (ctx) => {
      attempts++
      ctx.tools.register(tool("partial"))
      ctx.surface.setStatus({
        state: "working",
        code: "starting",
        summary: "Starting",
      })
      ctx.effect(() => onCleanup)
      if (attempts === 1) throw new Error("upstream exploded")
    })
    const steady = define(
      "steady",
      Empty,
      (ctx) => void ctx.tools.register(tool("ok")),
    )
    const { gateway, host } = createHost([flaky, steady])

    await gateway.reconcile({
      flaky: { enabled: true },
      steady: { enabled: true },
    })
    expect(gateway.get("flaky")).toMatchObject({
      lifecycle: "failed",
      error: "upstream exploded",
      tools: [],
    })
    expect(gateway.get("flaky")?.status).toBeUndefined()
    expect(cleaned).toBe(1)
    expect(gateway.get("steady")?.lifecycle).toBe("active")
    expect(
      host.logs.includes("error: [plugins] flaky: upstream exploded"),
    ).toBe(true)

    // Unchanged settings do not retry; toggling does.
    await gateway.reconcile({
      flaky: { enabled: true },
      steady: { enabled: true },
    })
    expect(attempts).toBe(1)
    await gateway.reconcile({
      flaky: { enabled: false },
      steady: { enabled: true },
    })
    await gateway.reconcile({
      flaky: { enabled: true },
      steady: { enabled: true },
    })
    expect(attempts).toBe(2)
    expect(gateway.get("flaky")?.lifecycle).toBe("active")
  })
})

describe("reconcile concurrency and settings", () => {
  test("concurrent reconciles are serialised", async () => {
    let active = 0
    let maxActive = 0
    const onDispose = () => void active--
    const slow = define("slow", Empty, async (ctx) => {
      active++
      maxActive = Math.max(maxActive, active)
      await new Promise((resolve) => setTimeout(resolve, 5))
      ctx.effect(() => onDispose)
    })
    const { gateway } = createHost([slow])
    await Promise.all([
      gateway.reconcile({ slow: { enabled: true } }),
      gateway.reconcile({ slow: { enabled: false } }),
      gateway.reconcile({ slow: { enabled: true } }),
    ])
    expect(maxActive).toBe(1)
    expect(gateway.get("slow")?.lifecycle).toBe("active")
  })

  test("unknown ids and malformed entries in settings are ignored", async () => {
    const { gateway } = createHost([define("alpha", Empty, () => {})])
    await gateway.reconcile({ ghost: { enabled: true }, alpha: null as never })
    expect(gateway.get("alpha")?.lifecycle).toBe("disabled")
  })
})

function searchPlugin(id: string): PluginModule {
  return define(
    id,
    Empty,
    (ctx) =>
      void ctx.tools.register(
        tool("search", () =>
          Promise.resolve({ content: [{ type: "text", text: id }] }),
        ),
      ),
  )
}

describe("tools", () => {
  test("duplicate tool names are rejected atomically", async () => {
    let ctxRef: Context | undefined
    const alpha = define("alpha", Empty, (ctx) => {
      ctxRef = ctx
      ctx.tools.registerAll([tool("one"), tool("two")])
    })
    const { gateway } = createHost([alpha])
    await gateway.reconcile({ alpha: { enabled: true } })
    const ctx = ctxRef as Context
    expect(() => ctx.tools.registerAll([tool("three"), tool("three")])).toThrow(
      PluginContractError,
    )
    expect(() => ctx.tools.register(tool("one"))).toThrow(
      /already registered tool "one"/,
    )
    expect(gateway.listTools("alpha").map((t) => t.name)).toEqual([
      "one",
      "two",
    ])
  })

  test("tools are namespaced per plugin", async () => {
    const { gateway } = createHost([
      searchPlugin("alpha"),
      searchPlugin("beta"),
    ])
    await gateway.reconcile({
      alpha: { enabled: true },
      beta: { enabled: true },
    })
    const signal = new AbortController().signal
    expect(await gateway.callTool("alpha", "search", {}, { signal })).toEqual({
      content: [{ type: "text", text: "alpha" }],
    })
    expect(await gateway.callTool("beta", "search", {}, { signal })).toEqual({
      content: [{ type: "text", text: "beta" }],
    })
  })

  test("callTool forwards input and call context; throws become isError", async () => {
    const seen: Array<{ input: unknown; sessionId?: string }> = []
    const alpha = define("alpha", Empty, (ctx) => {
      ctx.tools.register(
        tool("echo", (input, call) => {
          seen.push({
            input,
            ...(call.sessionId === undefined ?
              {}
            : { sessionId: call.sessionId }),
          })
          call.progress?.({ progress: 1, total: 1 })
          return Promise.resolve({
            content: [{ type: "text", text: "ok" }],
            structuredContent: { ok: true },
          })
        }),
      )
      ctx.tools.register(
        tool("boom", () => Promise.reject(new Error("tool failed"))),
      )
    })
    const { gateway } = createHost([alpha])
    await gateway.reconcile({ alpha: { enabled: true } })
    const progress: Array<unknown> = []
    const result = await gateway.callTool(
      "alpha",
      "echo",
      { q: "x" },
      {
        signal: new AbortController().signal,
        sessionId: "s1",
        progress: (update) => void progress.push(update),
      },
    )
    expect(result).toEqual({
      content: [{ type: "text", text: "ok" }],
      structuredContent: { ok: true },
    })
    expect(seen).toEqual([{ input: { q: "x" }, sessionId: "s1" }])
    expect(progress).toEqual([{ progress: 1, total: 1 }])
    expect(
      await gateway.callTool(
        "alpha",
        "boom",
        {},
        { signal: new AbortController().signal },
      ),
    ).toEqual({
      isError: true,
      content: [{ type: "text", text: "tool failed" }],
    })
  })

  test("in-flight calls are aborted when the plugin stops", async () => {
    let started = noop
    const startedPromise = new Promise<void>((resolve) => (started = resolve))
    const alpha = define("alpha", Empty, (ctx) => {
      ctx.tools.register(
        tool("hang", (_input, call) => {
          started()
          return new Promise((_resolve, reject) =>
            call.signal.addEventListener("abort", () =>
              reject(new Error("aborted")),
            ),
          )
        }),
      )
    })
    const { gateway } = createHost([alpha])
    await gateway.reconcile({ alpha: { enabled: true } })
    const pending = gateway.callTool(
      "alpha",
      "hang",
      {},
      { signal: new AbortController().signal },
    )
    await startedPromise
    await gateway.reconcile({})
    expect(await pending).toEqual({
      isError: true,
      content: [{ type: "text", text: "aborted" }],
    })
  })

  test("gateway errors: unknown-plugin, plugin-inactive, unknown-tool", async () => {
    const { gateway } = createHost([define("alpha", Empty, () => {})])
    const call = { signal: new AbortController().signal }
    await expectGatewayError(
      gateway.callTool("nope", "x", {}, call),
      "unknown-plugin",
    )
    await expectGatewayError(() => gateway.listTools("nope"), "unknown-plugin")
    await expectGatewayError(
      gateway.callTool("alpha", "x", {}, call),
      "plugin-inactive",
    )
    await gateway.reconcile({ alpha: { enabled: true } })
    await expectGatewayError(
      gateway.callTool("alpha", "x", {}, call),
      "unknown-tool",
    )
  })
})

describe("surface actions", () => {
  test("runAction dispatches to the registered handler", async () => {
    const signals: Array<AbortSignal> = []
    const alpha = define("alpha", Empty, (ctx) => {
      ctx.surface.setStatus({
        state: "needs-setup",
        code: "signin-needed",
        summary: "Sign in to continue",
        facts: [{ label: "Tenant", value: "contoso" }],
        actions: [{ id: "sign-in", label: "Sign in", kind: "primary" }],
      })
      ctx.surface.registerAction("sign-in", (signal) => {
        signals.push(signal)
        ctx.surface.setStatus({
          state: "ready",
          code: "ready",
          summary: "Signed in",
          actions: [{ id: "sign-out", label: "Sign out" }],
        })
        return Promise.resolve()
      })
      ctx.surface.registerAction("fail", () =>
        Promise.reject(new Error("action failed")),
      )
    })
    const { gateway, events } = createHost([alpha])
    await expectGatewayError(
      gateway.runAction("alpha", "sign-in"),
      "plugin-inactive",
    )
    await gateway.reconcile({ alpha: { enabled: true } })
    expect(gateway.get("alpha")?.status?.code).toBe("signin-needed")
    events.length = 0
    const controller = new AbortController()
    await gateway.runAction("alpha", "sign-in", controller.signal)
    expect(gateway.get("alpha")?.status?.code).toBe("ready")
    expect(events).toEqual([{ type: "status", pluginId: "alpha" }])
    controller.abort()
    expect(signals[0]?.aborted).toBe(true)
    expect(
      await rejectionMessage(gateway.runAction("alpha", "fail")),
    ).toContain("action failed")
    await expectGatewayError(
      gateway.runAction("alpha", "sign-out"),
      "unknown-action",
    )
    await expectGatewayError(
      gateway.runAction("ghost", "sign-in"),
      "unknown-plugin",
    )

    await gateway.reconcile({})
    await expectGatewayError(
      gateway.runAction("alpha", "sign-in"),
      "plugin-inactive",
    )
  })
})

describe("storage", () => {
  test("writes atomically into <root>/<id>/ with 0700 dir and 0600 files", async () => {
    const results: Array<string | undefined> = []
    let dir = ""
    const alpha = define("alpha", Empty, async (ctx) => {
      dir = ctx.storage.dir
      results.push(await ctx.storage.readText("cache.json"))
      await ctx.storage.writeText("cache.json", '{"a":1}')
      await ctx.storage.writeText("cache.json", '{"a":2}')
      results.push(await ctx.storage.readText("cache.json"))
      await ctx.storage.writeText("gone.txt", "x")
      await ctx.storage.delete("gone.txt")
      await ctx.storage.delete("never-existed.txt")
      results.push(await ctx.storage.readText("gone.txt"))
    })
    const { gateway, storageRoot } = createHost([alpha])
    await gateway.reconcile({ alpha: { enabled: true } })
    expect(gateway.get("alpha")?.lifecycle).toBe("active")
    expect(dir).toBe(path.join(storageRoot, "alpha"))
    expect(results).toEqual([undefined, '{"a":2}', undefined])
    expect(readdirSync(dir)).toEqual(["cache.json"])
    if (process.platform !== "win32") {
      expect(statSync(dir).mode & 0o777).toBe(0o700)
      expect(statSync(path.join(dir, "cache.json")).mode & 0o777).toBe(0o600)
    }
  })

  test("names that could escape the plugin dir are rejected", async () => {
    const errors: Array<string> = []
    const alpha = define("alpha", Empty, async (ctx) => {
      for (const name of [
        "../beta/x",
        "a/b",
        ".hidden",
        "",
        "..",
        String.raw`a\b`,
      ]) {
        try {
          await ctx.storage.writeText(name, "x")
        } catch (error) {
          errors.push((error as PluginContractError).code)
        }
      }
    })
    const { gateway, storageRoot } = createHost([alpha])
    await gateway.reconcile({ alpha: { enabled: true } })
    expect(errors).toEqual(
      Array.from({ length: 6 }, () => "invalid-storage-name"),
    )
    expect(readdirSync(storageRoot)).toEqual([])
  })
})

describe("host services and lifecycle", () => {
  test("ctx.host exposes openExternal, a prefixed logger and appVersion", async () => {
    let version = ""
    const alpha = define("alpha", Empty, async (ctx) => {
      version = ctx.host.appVersion
      ctx.host.logger.info("hello")
      await ctx.host.openExternal("https://login.example.test/")
    })
    const { gateway, host } = createHost([alpha])
    await gateway.reconcile({ alpha: { enabled: true } })
    expect(version).toBe("1.2.3")
    expect(host.logs).toContain("info: [plugin:alpha] hello")
    expect(host.opened).toEqual(["https://login.example.test/"])
  })

  test("ctx.host.maximalPort() answers the host's port, read when called", async () => {
    const ports: Array<number> = []
    const alpha = define("alpha", Empty, (ctx) => {
      ports.push(ctx.host.maximalPort())
    })
    const { gateway } = createHost([alpha])
    await gateway.reconcile({ alpha: { enabled: true } })
    expect(ports).toEqual([4141])
  })

  test("a status may carry attention; a malformed one is refused", async () => {
    const errors: Array<string> = []
    const alpha = define("alpha", Empty, (ctx) => {
      const base = { state: "ready", code: "ready", summary: "Ready" } as const
      ctx.surface.setStatus({
        ...base,
        attention: {
          summary: "Needs you",
          actions: [{ id: "approve-x", label: "Approve" }],
        },
      })
      for (const attention of [
        { summary: 1, actions: [] },
        { summary: "x", actions: "nope" },
        { summary: "x", actions: [{ id: "bad id!", label: "Approve" }] },
      ]) {
        try {
          ctx.surface.setStatus({ ...base, attention } as never)
        } catch (error) {
          errors.push((error as PluginContractError).code)
        }
      }
    })
    const { gateway } = createHost([alpha])
    await gateway.reconcile({ alpha: { enabled: true } })
    expect(errors).toEqual(Array.from({ length: 3 }, () => "invalid-status"))
    expect(gateway.get("alpha")?.status?.attention?.summary).toBe("Needs you")
  })

  test("listener failures are contained; unsubscribe stops delivery", async () => {
    const { gateway } = createHost([define("alpha", Empty, () => {})])
    const seen: Array<string> = []
    gateway.subscribe(() => {
      throw new Error("bad listener")
    })
    const unsubscribe = gateway.subscribe((event) => void seen.push(event.type))
    await gateway.reconcile({ alpha: { enabled: true } })
    expect(seen).toEqual(["lifecycle", "lifecycle"])
    unsubscribe()
    await gateway.reconcile({})
    expect(seen).toHaveLength(2)
  })

  test("dispose stops everything, is idempotent, and later reconciles are no-ops", async () => {
    let disposed = 0
    const onDispose = () => void disposed++
    const alpha = define("alpha", Empty, (ctx) => {
      ctx.tools.register(tool("x"))
      ctx.effect(() => onDispose)
    })
    const { gateway } = createHost([alpha])
    await gateway.reconcile({ alpha: { enabled: true } })
    await Promise.all([gateway.dispose(), gateway.dispose()])
    await gateway.dispose()
    expect(disposed).toBe(1)
    expect(gateway.get("alpha")).toMatchObject({
      lifecycle: "disabled",
      tools: [],
    })
    await gateway.reconcile({ alpha: { enabled: true } })
    expect(gateway.get("alpha")?.lifecycle).toBe("disabled")
    await expectGatewayError(
      gateway.callTool(
        "alpha",
        "x",
        {},
        { signal: new AbortController().signal },
      ),
      "plugin-inactive",
    )
  })
})

describe("ESM module namespace plugins", () => {
  test("a real module namespace loads, runs, and persists through storage", async () => {
    const { gateway, storageRoot } = createHost([echo])
    await gateway.updateConfig("echo", { prefix: "hey" })
    await gateway.reconcile({ echo: { enabled: true } })
    expect(gateway.get("echo")).toMatchObject({
      displayName: "Echo",
      lifecycle: "active",
      status: { state: "ready", summary: "Prefix: hey" },
      tools: [{ name: "echo" }],
    })
    expect(gateway.listTools("echo")[0]?.inputSchema).toMatchObject({
      type: "object",
      required: ["text"],
    })
    const result = await gateway.callTool(
      "echo",
      "echo",
      { text: "hi" },
      { signal: new AbortController().signal },
    )
    expect(result).toEqual({ content: [{ type: "text", text: "hey: hi" }] })
    expect(
      await Bun.file(path.join(storageRoot, "echo", "last.txt")).text(),
    ).toBe("hey: hi")
  })
})

// Compile-time: a typed plugin module is assignable to the host's plugin list.
const typed: PluginModule<{ endpoint: string }> = define(
  "typed",
  z.object({ endpoint: z.string().default("x") }),
  () => {},
)
const list: ReadonlyArray<PluginModule> = [typed]
void list
void (null as unknown as PluginGateway)
