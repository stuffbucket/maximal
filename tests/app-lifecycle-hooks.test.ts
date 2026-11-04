/**
 * Boot/shutdown hooks are driven through the app registry, so a new client
 * that declares `onBoot`/`onShutdown` can't be left out of the lifecycle.
 */

import { describe, expect, test } from "bun:test"

import type { ClientApp } from "~/apps/index"

import { runAppBootHooks, runAppShutdownHooks } from "~/apps/registry"

function fakeApp(
  id: ClientApp["id"],
  calls: Array<string>,
  throws = false,
): ClientApp {
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
    runAppBootHooks([
      fakeApp("claude-code", calls, true),
      fakeApp("codex", calls),
    ])
    expect(calls).toEqual(["claude-code:boot", "codex:boot"])
  })

  test("every app's onShutdown runs and reports failures", () => {
    const calls: Array<string> = []
    const result = runAppShutdownHooks([
      fakeApp("claude-code", calls, true),
      fakeApp("codex", calls),
    ])

    expect(calls).toEqual(["claude-code:shutdown", "codex:shutdown"])
    expect(result.attempted).toEqual(["claude-code", "codex"])
    expect(result.completed).toEqual(["codex"])
    expect(result.failed).toHaveLength(1)
    expect(result.failed[0]?.appId).toBe("claude-code")
    expect(result.failed[0]?.error).toEqual(new Error("claude-code failed"))
  })

  test("the real registry wires Claude Desktop into boot", async () => {
    const { getApp } = await import("~/apps/registry")
    expect(typeof getApp("claude-desktop")?.onBoot).toBe("function")
    expect(typeof getApp("claude-code")?.onBoot).toBe("function")
  })
})
