/**
 * The `serverTools` service and the gateway's `serverTools()` /
 * `callServerTool()`: registration is bound to the plugin's fiber, names are
 * unique across plugins, and a call reaches the tool with the host's budget
 * scope.
 */
import type {
  Context,
  PluginModule,
  ServerToolDefinition,
} from "@stuffbucket/maximal-plugin-sdk"

import { serverToolsService } from "@stuffbucket/maximal-plugin-sdk/runtime"
import { afterEach, describe, expect, test } from "bun:test"
import { z } from "zod"

import { createPluginHost, PluginContractError } from "../src/index"
import { runPluginConformance } from "../src/testing"
import { fakeHost, runCleanups, tempDir } from "./helpers"
import { rejection } from "./rejection"

afterEach(runCleanups)

function serverTool(
  name: string,
  overrides: Partial<ServerToolDefinition> = {},
): ServerToolDefinition {
  return {
    name,
    description: `${name} server tool`,
    input_schema: { type: "object", properties: { q: { type: "string" } } },
    render: "hidden",
    offer: "always",
    execute: (input) =>
      Promise.resolve({
        content: [{ type: "text", text: `${name}:${JSON.stringify(input)}` }],
      }),
    ...overrides,
  }
}

function provider(id: string, register: (ctx: Context) => void): PluginModule {
  return {
    name: id,
    manifest: {
      id,
      kind: "model",
      displayName: id.toUpperCase(),
      description: `${id} plugin`,
      settingsVersion: 1,
    },
    inject: ["serverTools"],
    Config: z.object({}),
    apply: register,
  }
}

function hostWith(plugins: Array<PluginModule>) {
  return createPluginHost({
    plugins,
    services: {
      host: fakeHost(),
      storageRoot: tempDir(),
      extra: [serverToolsService],
    },
  })
}

const call = () => ({
  signal: new AbortController().signal,
  model: "claude-sonnet-4.6",
  client: "claude-code",
})

describe("ctx.serverTools", () => {
  test("lists active plugins' tools by name, and withdraws them with the plugin", async () => {
    const zed = provider("zed", (ctx) => {
      ctx.serverTools.register(serverTool("zeta"))
    })
    const amp = provider("amp", (ctx) => {
      ctx.serverTools.register(serverTool("beta", { clients: ["codex"] }))
      ctx.serverTools.register(serverTool("alpha"))
    })
    const gateway = hostWith([zed, amp])
    try {
      expect(gateway.serverTools()).toEqual([])
      await gateway.reconcile({
        zed: { enabled: true },
        amp: { enabled: true },
      })
      expect(gateway.serverTools().map((tool) => tool.name)).toEqual([
        "alpha",
        "beta",
        "zeta",
      ])
      expect(gateway.serverTools()).toContainEqual({
        pluginId: "amp",
        name: "beta",
        description: "beta server tool",
        input_schema: {
          type: "object",
          properties: { q: { type: "string" } },
        },
        render: "hidden",
        offer: "always",
        clients: ["codex"],
      })
      // Offered to Claude Code unless the plugin says otherwise.
      expect(
        gateway.serverTools().find((tool) => tool.name === "alpha")?.clients,
      ).toEqual(["claude-code"])

      await gateway.reconcile({ zed: { enabled: true } })
      expect(gateway.serverTools().map((tool) => tool.name)).toEqual(["zeta"])
    } finally {
      await gateway.dispose()
    }
  })

  test("a disposer withdraws just that registration", async () => {
    let drop: (() => void) | undefined
    const plugin = provider("amp", (ctx) => {
      drop = ctx.serverTools.register(serverTool("alpha"))
      ctx.serverTools.register(serverTool("beta"))
    })
    const gateway = hostWith([plugin])
    try {
      await gateway.reconcile({ amp: { enabled: true } })
      drop?.()
      drop?.()
      expect(gateway.serverTools().map((tool) => tool.name)).toEqual(["beta"])
    } finally {
      await gateway.dispose()
    }
  })

  test("refuses a name another plugin, or the same plugin, already has", async () => {
    const errors: Array<unknown> = []
    const first = provider("first", (ctx) => {
      ctx.serverTools.register(serverTool("alpha"))
      try {
        ctx.serverTools.register(serverTool("alpha"))
      } catch (error) {
        errors.push(error)
      }
    })
    const second = provider("second", (ctx) => {
      try {
        ctx.serverTools.register(serverTool("alpha"))
      } catch (error) {
        errors.push(error)
      }
    })
    const gateway = hostWith([first, second])
    try {
      await gateway.reconcile({
        first: { enabled: true },
        second: { enabled: true },
      })
      expect(errors).toHaveLength(2)
      for (const error of errors) {
        expect(error).toBeInstanceOf(PluginContractError)
        expect(error).toMatchObject({ code: "duplicate-server-tool" })
      }
      expect(gateway.serverTools()).toHaveLength(1)
      expect(gateway.serverTools()[0]?.pluginId).toBe("first")
    } finally {
      await gateway.dispose()
    }
  })

  test("refuses a malformed definition", async () => {
    const bad: Array<[string, unknown]> = [
      ["not an object", 42],
      ["a name that is not snake_case", serverTool("Bad-Name")],
      ["no description", { ...serverTool("alpha"), description: "" }],
      [
        "a schema that is not an object type",
        { ...serverTool("alpha"), input_schema: { type: "string" } },
      ],
      ["an unknown render", { ...serverTool("alpha"), render: "loud" }],
      ["an unknown offer", { ...serverTool("alpha"), offer: "sometimes" }],
      [
        "a hidden tool offered when the client declares it",
        serverTool("alpha", { offer: "when-client-declares" }),
      ],
      ["an empty client list", serverTool("alpha", { clients: [] })],
      ["no execute", { ...serverTool("alpha"), execute: undefined }],
    ]
    const seen: Array<string> = []
    const plugin = provider("amp", (ctx) => {
      for (const [label, definition] of bad) {
        try {
          ctx.serverTools.register(definition as ServerToolDefinition)
          seen.push(`${label}: accepted`)
        } catch (error) {
          expect(error).toMatchObject({ code: "invalid-server-tool" })
          seen.push(`${label}: refused`)
        }
      }
    })
    const gateway = hostWith([plugin])
    try {
      await gateway.reconcile({ amp: { enabled: true } })
      expect(seen).toEqual(bad.map(([label]) => `${label}: refused`))
      expect(gateway.serverTools()).toEqual([])
    } finally {
      await gateway.dispose()
    }
  })

  test("a later change to the definition object cannot swap its handler", async () => {
    const definition = serverTool("alpha")
    const plugin = provider("amp", (ctx) => {
      ctx.serverTools.register(definition)
    })
    const gateway = hostWith([plugin])
    try {
      await gateway.reconcile({ amp: { enabled: true } })
      definition.execute = () =>
        Promise.resolve({ content: [{ type: "text", text: "swapped" }] })
      definition.input_schema.properties = { evil: {} }
      const result = await gateway.callServerTool("amp", "alpha", {}, call())
      expect(result.content).toEqual([{ type: "text", text: "alpha:{}" }])
      expect(gateway.serverTools()[0]?.input_schema).toEqual({
        type: "object",
        properties: { q: { type: "string" } },
      })
    } finally {
      await gateway.dispose()
    }
  })
})

describe("gateway.callServerTool", () => {
  test("runs the tool with the call, the host's budget scope and a lifetime-bound signal", async () => {
    let seen: Parameters<ServerToolDefinition["execute"]>[1] | undefined
    const plugin = provider("amp", (ctx) => {
      ctx.serverTools.register(
        serverTool("alpha", {
          execute: (_input, received) => {
            seen = received
            return Promise.resolve({
              content: [{ type: "text", text: "done" }],
            })
          },
        }),
      )
    })
    const gateway = hostWith([plugin])
    try {
      await gateway.reconcile({ amp: { enabled: true } })
      const caller = new AbortController()
      const result = await gateway.callServerTool(
        "amp",
        "alpha",
        { q: "x" },
        {
          signal: caller.signal,
          sessionId: "session-1",
          model: "claude-sonnet-4.6",
          client: "claude-code",
          budget: { plugin: "someone-else", tool: "other" },
        },
      )
      expect(result).toEqual({ content: [{ type: "text", text: "done" }] })
      expect(seen).toMatchObject({
        sessionId: "session-1",
        model: "claude-sonnet-4.6",
        client: "claude-code",
        budget: { plugin: "amp", tool: "alpha" },
      })
      expect(seen?.signal.aborted).toBe(false)
      caller.abort()
      expect(seen?.signal.aborted).toBe(true)
    } finally {
      await gateway.dispose()
    }
  })

  test("a throwing tool and an invalid result both come back as error results", async () => {
    const plugin = provider("amp", (ctx) => {
      ctx.serverTools.register(
        serverTool("boom", {
          execute: () => Promise.reject(new Error("it broke")),
        }),
      )
      ctx.serverTools.register(
        serverTool("junk", {
          execute: () => Promise.resolve("nope" as never),
        }),
      )
    })
    const gateway = hostWith([plugin])
    try {
      await gateway.reconcile({ amp: { enabled: true } })
      expect(await gateway.callServerTool("amp", "boom", {}, call())).toEqual({
        isError: true,
        content: [{ type: "text", text: "it broke" }],
      })
      expect(await gateway.callServerTool("amp", "junk", {}, call())).toEqual({
        isError: true,
        content: [
          {
            type: "text",
            text: 'Server tool "junk" returned an invalid result.',
          },
        ],
      })
    } finally {
      await gateway.dispose()
    }
  })

  test("throws for an unknown plugin, an inactive plugin and an unknown tool", async () => {
    const plugin = provider("amp", (ctx) => {
      ctx.serverTools.register(serverTool("alpha"))
    })
    const gateway = hostWith([plugin])
    try {
      expect(
        await rejection(gateway.callServerTool("nope", "alpha", {}, call())),
      ).toMatchObject({ code: "unknown-plugin" })
      expect(
        await rejection(gateway.callServerTool("amp", "alpha", {}, call())),
      ).toMatchObject({ code: "plugin-inactive" })
      await gateway.reconcile({ amp: { enabled: true } })
      expect(
        await rejection(gateway.callServerTool("amp", "missing", {}, call())),
      ).toMatchObject({ code: "unknown-tool" })
    } finally {
      await gateway.dispose()
    }
  })

  test("a plugin's server tools are not MCP tools", async () => {
    const plugin = provider("amp", (ctx) => {
      ctx.serverTools.register(serverTool("alpha"))
    })
    const gateway = hostWith([plugin])
    try {
      await gateway.reconcile({ amp: { enabled: true } })
      expect(gateway.listTools("amp")).toEqual([])
    } finally {
      await gateway.dispose()
    }
  })
})

test("a host without the service refuses a plugin that injects it", () => {
  const plugin = provider("amp", () => {})
  expect(() =>
    createPluginHost({
      plugins: [plugin],
      services: { host: fakeHost(), storageRoot: tempDir() },
    }),
  ).toThrow(/requires missing service: serverTools/)
})

runPluginConformance(
  provider("conform", (ctx) => {
    ctx.serverTools.register(serverTool("alpha"))
  }),
  { harness: { extraServices: [serverToolsService] } },
)
