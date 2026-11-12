/**
 * The `providers` service: host-supplied providers, plugin registration,
 * lifetime and validation, through a real host with
 * `services.extra: [providersService([...])]`.
 */
import type {
  Context,
  PluginModule,
  UpstreamProvider,
} from "@stuffbucket/maximal-plugin-sdk"

import { providersService } from "@stuffbucket/maximal-plugin-sdk/runtime"
import { afterEach, describe, expect, test } from "bun:test"

import { createPluginHost } from "../src/index"
import { runPluginConformance } from "../src/testing"
import {
  Empty,
  fakeHost,
  runCleanups,
  tempDir,
  testSettingsAuthority,
} from "./helpers"

function noop() {}
const noopSubscribe = () => noop
const emptyReply = () => Promise.resolve({} as never)

/** What `ctx` sees as the `local` provider. */
const localId = (ctx: Context): string | undefined =>
  ctx.providers.get("local")?.id

function fakeProvider(
  id: string,
  overrides: Partial<UpstreamProvider> = {},
): UpstreamProvider {
  return {
    id,
    displayName: id.toUpperCase(),
    postJson: emptyReply,
    model: () => undefined,
    onCatalogChange: noopSubscribe,
    available: () => true,
    cost: () => undefined,
    ...overrides,
  }
}

function modelPlugin(
  name: string,
  apply: (ctx: Context) => void,
): PluginModule {
  return {
    name,
    manifest: {
      id: name,
      kind: "model",
      displayName: name,
      description: `${name} uses providers`,
      settingsVersion: 1,
    },
    inject: ["providers"],
    Config: Empty,
    apply,
  }
}

const gateways: Array<{ dispose(): Promise<void> }> = []
afterEach(async () => {
  for (const gateway of gateways.splice(0)) await gateway.dispose()
  await runCleanups()
})

function start(
  plugins: Array<PluginModule>,
  initial: Array<UpstreamProvider> = [fakeProvider("copilot")],
) {
  const storageRoot = tempDir()
  const gateway = createPluginHost({
    plugins,
    services: {
      host: fakeHost(),
      storageRoot,
      settingsAuthority: testSettingsAuthority(storageRoot),
      extra: [providersService(initial)],
    },
  })
  gateways.push(gateway)
  return gateway
}

const on = { enabled: true }

describe("providers", () => {
  test("a plugin sees the host-supplied providers", async () => {
    let seen: unknown
    const gateway = start([
      modelPlugin("alpha", (ctx) => {
        seen = {
          copilot: ctx.providers.get("copilot")?.displayName,
          missing: ctx.providers.get("nope"),
          list: ctx.providers.list(),
        }
      }),
    ])
    await gateway.reconcile({ alpha: on })
    expect(seen).toEqual({
      copilot: "COPILOT",
      missing: undefined,
      list: [{ id: "copilot", displayName: "COPILOT" }],
    })
  })

  test("a plugin's provider is available to others and withdrawn with its fiber", async () => {
    let beta: Context | undefined
    const gateway = start([
      modelPlugin("alpha", (ctx) => {
        ctx.providers.register(fakeProvider("local"))
      }),
      modelPlugin("beta", (ctx) => {
        beta = ctx
      }),
    ])
    await gateway.reconcile({ alpha: on, beta: on })
    expect(beta && localId(beta)).toBe("local")
    await gateway.reconcile({ beta: on })
    expect(beta && localId(beta)).toBeUndefined()
    await gateway.reconcile({ alpha: on, beta: on })
    expect(beta && localId(beta)).toBe("local")
  })

  test("the returned disposer withdraws one provider, idempotently", async () => {
    let dispose: (() => void) | undefined
    let alphaCtx: Context | undefined
    const gateway = start([
      modelPlugin("alpha", (ctx) => {
        alphaCtx = ctx
        dispose = ctx.providers.register(fakeProvider("local"))
      }),
    ])
    await gateway.reconcile({ alpha: on })
    expect(alphaCtx && localId(alphaCtx)).toBe("local")
    dispose?.()
    dispose?.()
    expect(alphaCtx && localId(alphaCtx)).toBeUndefined()
  })

  test("registering an id that is taken fails the plugin", async () => {
    let before: string | undefined
    const gateway = start([
      modelPlugin("alpha", (ctx) => {
        before = ctx.providers.get("copilot")?.displayName
        ctx.providers.register(fakeProvider("copilot"))
      }),
    ])
    await gateway.reconcile({ alpha: on })
    const alpha = gateway.get("alpha")
    expect(alpha?.lifecycle).toBe("failed")
    expect(alpha?.error).toMatch(/provider "copilot".*already registered/)
    expect(before).toBe("COPILOT")
  })

  test("malformed providers are refused", async () => {
    const errors: Array<unknown> = []
    const gateway = start([
      modelPlugin("alpha", (ctx) => {
        const attempts = [
          fakeProvider("Bad Id"),
          fakeProvider("ok", { displayName: "" }),
          { ...fakeProvider("ok"), postJson: undefined },
        ]
        for (const attempt of attempts) {
          try {
            ctx.providers.register(attempt as UpstreamProvider)
          } catch (caught) {
            errors.push(caught)
          }
        }
      }),
    ])
    await gateway.reconcile({ alpha: on })
    expect(errors).toHaveLength(3)
    for (const error of errors)
      expect(error).toMatchObject({ code: "invalid-provider" })
  })

  test("two host-supplied providers with one id are refused at construction", () => {
    expect(() =>
      start([], [fakeProvider("copilot"), fakeProvider("copilot")]),
    ).toThrow(/already registered/)
  })
})

runPluginConformance(
  modelPlugin("conformant", (ctx) => {
    ctx.providers.register(fakeProvider("local"))
  }),
  { harness: { extraServices: [providersService([fakeProvider("copilot")])] } },
)
