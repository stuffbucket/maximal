import type { Fiber } from "@deepseek-ai/cordis"

import { Context as CordisContext } from "@deepseek-ai/cordis"
import { describe, expect, test } from "bun:test"
import { z } from "zod"

import {
  PluginContractError,
  type Context,
  type PluginModule,
  type ToolDefinition,
} from "../src/index"
import { mountPlugin, PluginRuntime } from "../src/runtime/index"
import { createTestbed, loadPlugin, waitFor } from "../src/testing/index"
import { rejection, rejectionMessage } from "./rejection"

function tool(name: string, text = name): ToolDefinition {
  return {
    name,
    description: `${name} tool`,
    inputSchema: { type: "object", properties: {} },
    execute: () => Promise.resolve({ content: [{ type: "text", text }] }),
  }
}

function plugin<C>(
  name: string,
  apply: (ctx: Context, config: C) => void | Promise<void>,
  Config: PluginModule<C>["Config"],
): PluginModule<C> {
  return {
    name,
    manifest: {
      id: name,
      kind: "extension",
      displayName: "Example",
      description: "Example plugin",
      settingsVersion: 1,
    },
    inject: ["tools", "surface", "storage", "host"],
    Config,
    apply,
  }
}

const Empty = z.object({})

const noop = () => {}

describe("runtime mounting", () => {
  test("disposes a new fiber when its runtime slot cannot attach", async () => {
    const root = new CordisContext()
    let candidate: Fiber | undefined
    class RejectingRuntime extends PluginRuntime {
      override attach(_pluginId: string, handle: Fiber): never {
        candidate = handle.ctx.fiber
        throw new Error("slot collision")
      }
    }

    expect(
      await rejectionMessage(
        mountPlugin(
          root,
          new RejectingRuntime(),
          "candidate",
          { name: "candidate", apply: () => {} },
          {},
        ),
      ),
    ).toBe("slot collision")
    expect(candidate).toBeDefined()
    expect(candidate?.state).toBe(4)
    await root.fiber.dispose()
  })
})

describe("testing harness", () => {
  test("tools appear on load and vanish on dispose", async () => {
    const loaded = await loadPlugin(
      plugin(
        "example",
        (ctx) => {
          ctx.tools.register(tool("alpha"))
          ctx.tools.register(tool("beta"))
        },
        Empty,
      ),
    )
    expect(loaded.tools().map((t) => t.name)).toEqual(["alpha", "beta"])
    expect(await loaded.callTool("alpha")).toEqual({
      content: [{ type: "text", text: "alpha" }],
    })
    const { testbed } = loaded
    await loaded.dispose()
    expect(testbed.runtime.tools("example")).toEqual([])
    expect(testbed.events.at(-1)).toEqual({
      type: "tools",
      pluginId: "example",
    })
  })

  test("config defaults are applied and invalid config is rejected with a path", async () => {
    const Config = z.object({
      endpoint: z.url().default("https://example.test/mcp"),
    })
    let seen: unknown
    const module = plugin(
      "cfg",
      (_ctx, config: z.output<typeof Config>) => {
        seen = config
      },
      Config,
    )
    const loaded = await loadPlugin(module)
    expect(seen).toEqual({ endpoint: "https://example.test/mcp" })
    await loaded.dispose()

    const failure = loadPlugin(module, { endpoint: "nope" })
    expect(await rejection(failure)).toBeInstanceOf(PluginContractError)
    expect(await rejectionMessage(failure)).toMatch(/^cfg\.endpoint: /)
  })

  test("register returns a disposer and duplicates throw", async () => {
    let disposeAlpha = noop
    const loaded = await loadPlugin(
      plugin(
        "dup",
        (ctx) => {
          disposeAlpha = ctx.tools.register(tool("alpha"))
          expect(() => ctx.tools.register(tool("alpha"))).toThrow(
            PluginContractError,
          )
        },
        Empty,
      ),
    )
    expect(loaded.tools().map((t) => t.name)).toEqual(["alpha"])
    disposeAlpha()
    disposeAlpha()
    expect(loaded.tools()).toEqual([])
    await loaded.dispose()
  })

  test("registerAll replaces atomically; a duplicate leaves the old set intact", async () => {
    let ctxRef: Context | undefined
    const loaded = await loadPlugin(
      plugin(
        "bulk",
        (ctx) => {
          ctxRef = ctx
          ctx.tools.register(tool("single"))
          ctx.tools.registerAll([tool("a"), tool("b")])
        },
        Empty,
      ),
    )
    const ctx = ctxRef as Context
    expect(loaded.tools().map((t) => t.name)).toEqual(["a", "b"])

    let error: unknown
    try {
      ctx.tools.registerAll([tool("c"), tool("c")])
    } catch (caught) {
      error = caught
    }
    expect(error).toBeInstanceOf(PluginContractError)
    expect((error as PluginContractError).code).toBe("duplicate-tool")
    expect(loaded.tools().map((t) => t.name)).toEqual(["a", "b"])

    expect(() =>
      ctx.tools.registerAll([tool("d"), { ...tool("e"), name: "bad name" }]),
    ).toThrow(/invalid name/)
    expect(loaded.tools().map((t) => t.name)).toEqual(["a", "b"])

    for (let i = 0; i < 20; i++) ctx.tools.registerAll([tool(`t${i}`)])
    expect(loaded.tools().map((t) => t.name)).toEqual(["t19"])
    // Superseded registrations release their cordis effects.
    expect(
      loaded.fiber.getEffects().filter((e) => e.label.startsWith("tools."))
        .length,
    ).toBe(1)
    expect(ctx.tools.list().map((t) => t.name)).toEqual(["t19"])

    await loaded.dispose()
    expect(loaded.testbed.runtime.tools("bulk")).toEqual([])
  })

  test("tool throws become isError results; abort signal fires on dispose", async () => {
    let signal: AbortSignal | undefined
    const loaded = await loadPlugin(
      plugin(
        "throws",
        (ctx) => {
          ctx.tools.register({
            ...tool("boom"),
            execute: () => Promise.reject(new Error("kaboom")),
          })
          ctx.tools.register({
            ...tool("wait"),
            execute: (_input, call) => {
              signal = call.signal
              return Promise.resolve({ content: [] })
            },
          })
        },
        Empty,
      ),
    )
    expect(await loaded.callTool("boom")).toEqual({
      isError: true,
      content: [{ type: "text", text: "kaboom" }],
    })
    await loaded.callTool("wait")
    expect(signal?.aborted).toBe(false)
    await loaded.dispose()
    expect(signal?.aborted).toBe(true)
  })

  test("status and actions are per plugin and withdrawn on dispose", async () => {
    let ran = 0
    const loaded = await loadPlugin(
      plugin(
        "surface",
        (ctx) => {
          ctx.surface.registerAction("sign-in", () => {
            ran++
            ctx.surface.setStatus({
              state: "ready",
              code: "ready",
              summary: "Signed in",
            })
            return Promise.resolve()
          })
          ctx.surface.setStatus({
            state: "needs-setup",
            code: "signin-needed",
            summary: "Sign in",
            actions: [{ id: "sign-in", label: "Sign in", kind: "primary" }],
          })
          expect(() =>
            ctx.surface.registerAction("sign-in", () => Promise.resolve()),
          ).toThrow(/already registered/)
          expect(() =>
            ctx.surface.setStatus({ state: "bogus" } as never),
          ).toThrow(PluginContractError)
        },
        Empty,
      ),
    )
    expect(loaded.status()?.code).toBe("signin-needed")
    expect(loaded.actions()).toEqual(["sign-in"])
    await loaded.runAction("sign-in")
    expect(ran).toBe(1)
    expect(loaded.status()?.code).toBe("ready")
    expect(Object.isFrozen(loaded.status())).toBe(true)
    const { testbed } = loaded
    await loaded.dispose()
    expect(testbed.runtime.status("surface")).toBeUndefined()
    expect(testbed.runtime.actionIds("surface")).toEqual([])
  })
})

describe("testing harness services", () => {
  test("storage is private per plugin and validates names", async () => {
    const testbed = createTestbed({ storage: { one: { "seed.json": "{}" } } })
    const reads: Array<string | undefined> = []
    const make = (name: string) =>
      plugin(
        name,
        async (ctx) => {
          reads.push(await ctx.storage.readText("seed.json"))
          await ctx.storage.writeText("token.json", name)
          expect(ctx.storage.dir).toBe(`/memory/plugins/${name}`)
          expect(
            await rejection(ctx.storage.writeText("../escape", "x")),
          ).toBeInstanceOf(PluginContractError)
          expect(
            await rejection(ctx.storage.readText(".hidden")),
          ).toBeInstanceOf(PluginContractError)
        },
        Empty,
      )
    await testbed.load(make("one"))
    await testbed.load(make("two"))
    expect(reads).toEqual(["{}", undefined])
    expect(testbed.storage.files("one")).toEqual({
      "seed.json": "{}",
      "token.json": "one",
    })
    expect(testbed.storage.files("two")).toEqual({ "token.json": "two" })
    await testbed.dispose()
  })

  test("host: openExternal records http(s) URLs only; logger is prefixed", async () => {
    const opened: Array<string> = []
    const loaded = await loadPlugin(
      plugin(
        "hosty",
        async (ctx) => {
          await ctx.host.openExternal("https://login.example.test/authorize")
          expect(
            await rejection(ctx.host.openExternal("file:///etc/passwd")),
          ).toBeInstanceOf(PluginContractError)
          ctx.host.logger.info("hello", 1)
          expect(ctx.host.appVersion).toBe("9.9.9")
        },
        Empty,
      ),
      undefined,
      { appVersion: "9.9.9", openExternal: (url) => void opened.push(url) },
    )
    expect(loaded.testbed.host.opened).toEqual([
      "https://login.example.test/authorize",
    ])
    expect(opened).toEqual(["https://login.example.test/authorize"])
    expect(loaded.testbed.host.logs).toEqual([
      { level: "info", message: "[plugin:hosty] hello", args: [1] },
    ])
    await loaded.dispose()
  })

  test("sub-plugins register on behalf of their parent plugin", async () => {
    const loaded = await loadPlugin(
      plugin(
        "parent",
        async (ctx) => {
          await ctx.plugin({
            name: "child",
            apply(child: Context) {
              child.tools.register(tool("from-child"))
            },
          })
        },
        Empty,
      ),
    )
    expect(loaded.tools().map((t) => t.name)).toEqual(["from-child"])
    await loaded.dispose()
    expect(loaded.testbed.runtime.tools("parent")).toEqual([])
  })

  test("apply throwing rejects load and leaves nothing behind", async () => {
    const testbed = createTestbed()
    const failing = plugin(
      "failing",
      (ctx) => {
        ctx.tools.register(tool("leak"))
        ctx.surface.setStatus({
          state: "working",
          code: "starting",
          summary: "…",
        })
        throw new Error("apply failed")
      },
      Empty,
    )
    expect(await rejectionMessage(testbed.load(failing))).toContain(
      "apply failed",
    )
    expect(testbed.runtime.tools("failing")).toEqual([])
    expect(testbed.runtime.status("failing")).toBeUndefined()
    expect(testbed.runtime.isAttached("failing")).toBe(false)
    await testbed.dispose()
  })

  test("module validation: bad id, missing service, missing manifest", async () => {
    const testbed = createTestbed()
    expect(
      await rejectionMessage(
        testbed.load({ ...plugin("ok", () => {}, Empty), name: "Bad_Id" }),
      ),
    ).toMatch(/name matching/)
    expect(
      await rejectionMessage(
        testbed.load({
          ...plugin("ok", () => {}, Empty),
          inject: ["database"],
        }),
      ),
    ).toMatch(/requires missing service: database/)
    const noManifest = {
      ...plugin("ok", () => {}, Empty),
      manifest: undefined,
    } as unknown as PluginModule
    expect(await rejectionMessage(testbed.load(noManifest))).toMatch(
      /manifest: must be an object/,
    )
    await testbed.dispose()
  })

  test("services are unavailable to code not loaded as a plugin", async () => {
    const testbed = createTestbed()
    expect(() => testbed.ctx.tools.register(tool("x"))).toThrow(
      /only available to plugins/,
    )
    await testbed.dispose()
  })

  test("waitFor polls until true and times out otherwise", async () => {
    let flag = false
    setTimeout(() => {
      flag = true
    }, 10)
    await waitFor(() => flag)
    expect(
      await rejectionMessage(
        waitFor(() => false, { timeoutMs: 20, message: "never" }),
      ),
    ).toContain("never")
  })
})
