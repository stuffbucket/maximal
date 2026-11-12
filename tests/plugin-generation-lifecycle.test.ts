import { describe, expect, test } from "bun:test"

import {
  PluginGenerationLifecycleRegistry,
  RELEASE_UPSTREAM_SESSION_METHOD,
} from "~/lib/plugins/generation-lifecycle"

async function rejectionOf(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise
  } catch (error) {
    return error
  }
  throw new Error("Expected promise to reject.")
}

describe("plugin generation lifecycle registry", () => {
  test("routes upstream release to the selected generation and unregisters it", async () => {
    const registry = new PluginGenerationLifecycleRegistry()
    const calls: Array<{ method: string; params: unknown }> = []
    const unregister = registry.registerGeneration("n", {
      dispatch(method, params) {
        calls.push({ method, params })
        return Promise.resolve(null)
      },
    })

    await registry.releaseUpstreamSession(
      "n",
      "session-a",
      new AbortController().signal,
    )
    expect(calls).toEqual([
      {
        method: RELEASE_UPSTREAM_SESSION_METHOD,
        params: { sessionId: "session-a" },
      },
    ])

    unregister()
    const error = await rejectionOf(
      registry.releaseUpstreamSession(
        "n",
        "session-a",
        new AbortController().signal,
      ),
    )
    expect(error).toBeInstanceOf(Error)
    expect((error as Error).message).toContain("unavailable")
  })

  test("delivers cutover deadlines and removes subscribers", () => {
    const registry = new PluginGenerationLifecycleRegistry()
    const notices: Array<{ generationId: string; deadline: number }> = []
    const unsubscribe = registry.subscribeCutovers(
      (generationId, drainDeadline) => {
        notices.push({ generationId, deadline: drainDeadline })
      },
    )

    registry.publishCutover("n+1", 1234)
    unsubscribe()
    registry.publishCutover("n+2", 5678)
    expect(notices).toEqual([{ generationId: "n+1", deadline: 1234 }])
  })

  test("does not dispatch an already aborted release", async () => {
    const registry = new PluginGenerationLifecycleRegistry()
    let calls = 0
    registry.registerGeneration("n", {
      dispatch() {
        calls += 1
        return Promise.resolve(null)
      },
    })
    const abort = new AbortController()
    abort.abort()

    const error = await rejectionOf(
      registry.releaseUpstreamSession("n", "session-a", abort.signal),
    )
    expect(error).toBeInstanceOf(Error)
    expect(calls).toBe(0)
  })
})
