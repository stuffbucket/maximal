/**
 * Boot/shutdown hooks are driven through the app registry, so a new client
 * that declares `onBoot`/`onShutdown` can't be left out of the lifecycle.
 */

import { describe, expect, test } from "bun:test"

import type { ClientApp } from "~/apps/index"

import { runAppBootHooks, runAppShutdownHooks } from "~/apps/registry"

function fakeApp(id: string, calls: Array<string>, throws = false): ClientApp {
  const hook = (phase: string) => () => {
    calls.push(`${id}:${phase}`)
    if (throws) throw new Error(`${id} failed`)
  }
  return {
    id,
    onBoot: hook("boot"),
    onShutdown: hook("shutdown"),
  } as unknown as ClientApp
}

describe("app lifecycle hooks", () => {
  test("every app's onBoot runs, even after one throws", () => {
    const calls: Array<string> = []
    runAppBootHooks([fakeApp("a", calls, true), fakeApp("b", calls)])
    expect(calls).toEqual(["a:boot", "b:boot"])
  })

  test("every app's onShutdown runs, even after one throws", () => {
    const calls: Array<string> = []
    runAppShutdownHooks([fakeApp("a", calls, true), fakeApp("b", calls)])
    expect(calls).toEqual(["a:shutdown", "b:shutdown"])
  })

  test("the real registry wires Claude Desktop into boot", async () => {
    const { getApp } = await import("~/apps/registry")
    expect(typeof getApp("claude-desktop")?.onBoot).toBe("function")
    expect(typeof getApp("claude-code")?.onBoot).toBe("function")
  })
})
