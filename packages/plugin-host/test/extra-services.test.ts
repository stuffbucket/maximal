/**
 * `createPluginHost({ services: { extra } })`: app-provided services join the
 * names a plugin may inject, and a name nobody provides is still refused.
 */
import type { Context, PluginModule } from "@stuffbucket/maximal-plugin-sdk"

import { Service } from "@stuffbucket/maximal-plugin-sdk"
import {
  type PluginRuntime,
  type PluginServiceFactory,
} from "@stuffbucket/maximal-plugin-sdk/runtime"
import { afterEach, describe, expect, test } from "bun:test"
import { z } from "zod"

import { createPluginHost, PluginContractError } from "../src/index"
import {
  createLifecycleHarness,
  type LifecycleHarness,
  runPluginConformance,
} from "../src/testing"
import { fakeHost, noop, runCleanups, tempDir } from "./helpers"

/** A fake app service: reports which plugin asked for it. */
interface Greeter {
  greet(): string
}

declare module "@stuffbucket/maximal-plugin-sdk" {
  interface AppServices {
    greeter: Greeter
  }
}

const RUNTIME = Symbol("test.greeter.runtime")

class GreeterService extends Service implements Greeter {
  declare [RUNTIME]: PluginRuntime

  constructor(ctx: Context, runtime: PluginRuntime, name = "greeter") {
    super(ctx, name)
    this[RUNTIME] = runtime
  }

  greet(): string {
    return `hello from ${this[RUNTIME].slotOf(this.ctx, "greeter").id}`
  }
}

const greeter: PluginServiceFactory = (root, runtime) =>
  new GreeterService(root, runtime)

const release = () => noop
const asTools: PluginServiceFactory = (root, runtime) =>
  new GreeterService(root, runtime, "tools")

/** A `model` plugin: no tools, one app service. */
const greeted: PluginModule = {
  name: "greeted",
  manifest: {
    id: "greeted",
    kind: "model",
    displayName: "Greeted",
    description: "Uses an app-provided service.",
    settingsVersion: 1,
  },
  inject: ["surface", "greeter"],
  Config: z.object({}),
  apply(ctx) {
    ctx.effect(release, "greeted lifecycle")
    ctx.surface.setStatus({
      state: "ready",
      code: "ready",
      summary: ctx.greeter.greet(),
    })
  },
}

function hostWith(
  plugins: Array<PluginModule>,
  extra?: Array<PluginServiceFactory>,
) {
  return createPluginHost({
    plugins,
    services: { host: fakeHost(), storageRoot: tempDir(), extra },
  })
}

let harness: LifecycleHarness | undefined
afterEach(async () => {
  const current = harness
  harness = undefined
  await current?.dispose()
  await runCleanups()
})

describe("services.extra", () => {
  test("an extra service is injectable and sees the calling plugin", async () => {
    const gateway = hostWith([greeted], [greeter])
    try {
      await gateway.reconcile({ greeted: { enabled: true } })
      const snapshot = gateway.get("greeted")
      expect(snapshot?.lifecycle).toBe("active")
      expect(snapshot?.kind).toBe("model")
      expect(snapshot?.status?.summary).toBe("hello from greeted")
    } finally {
      await gateway.dispose()
    }
  })

  test("a plugin injecting a service nobody provides is refused", () => {
    expect(() => hostWith([greeted])).toThrow(
      /Plugin "greeted" requires missing service: greeter/,
    )
    const other: PluginModule = {
      ...greeted,
      name: "other",
      manifest: { ...greeted.manifest, id: "other" },
      inject: ["surface", "nope"],
    }
    let error: unknown
    try {
      hostWith([other], [greeter])
    } catch (caught) {
      error = caught
    }
    expect(error).toBeInstanceOf(PluginContractError)
    expect(error).toMatchObject({ code: "missing-service", pluginId: "other" })
  })

  test("an extra service may not reuse a built-in or an earlier extra name", () => {
    const taken = /has been registered/
    expect(() => hostWith([], [asTools])).toThrow(taken)
    expect(() => hostWith([], [greeter, greeter])).toThrow(taken)
  })

  test("the lifecycle harness runs a model plugin with an extra service", async () => {
    harness = createLifecycleHarness({
      plugins: [greeted],
      extraServices: [greeter],
    })
    await harness.enable("greeted")
    expect(harness.snapshot("greeted").status?.summary).toBe(
      "hello from greeted",
    )
    await harness.disable("greeted")
    expect(harness.snapshot("greeted").lifecycle).toBe("disabled")
  })
})

runPluginConformance(greeted, { harness: { extraServices: [greeter] } })
