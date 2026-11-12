import type {
  PluginGenerationLease,
  PluginSnapshot,
} from "@stuffbucket/maximal-plugin-sdk/gateway"

import { describe, expect, test } from "bun:test"

import {
  GenerationAffinityCoordinator,
  SessionAffinityClosedError,
} from "~/lib/plugins/generation-affinity"

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((yes, no) => {
    resolve = yes
    reject = no
  })
  return { promise, resolve, reject }
}

async function waitFor(check: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (check()) return
    await Bun.sleep(0)
  }
  throw new Error("condition not reached")
}

const unsupported = (): never => {
  throw new Error("not used by affinity tests")
}

function generation(
  id: string,
  releases: Array<string>,
): PluginGenerationLease {
  let released = false
  return {
    generationId: id,
    get: () => undefined as PluginSnapshot | undefined,
    listTools: unsupported,
    toolViews: unsupported,
    serverTools: unsupported,
    operations: unsupported,
    callTool: unsupported,
    prepareServerTool: unsupported,
    release: () => {
      if (released) return
      released = true
      releases.push(id)
    },
  }
}

interface HarnessOptions {
  release?: (
    generationId: string,
    sessionId: string,
    signal: AbortSignal,
  ) => Promise<void>
}

function harness(options: HarnessOptions = {}) {
  let current = "n"
  let now = 0
  const releases: Array<string> = []
  const upstreamReleases: Array<string> = []
  const closes: Array<string> = []
  const notifications: Array<string> = []
  const coordinator = new GenerationAffinityCoordinator({
    acquireGeneration: () => generation(current, releases),
    releaseUpstreamSession: async (generationId, sessionId, signal) => {
      upstreamReleases.push(`${generationId}:${sessionId}`)
      await options.release?.(generationId, sessionId, signal)
    },
    closeDownstream: (sessionId) => {
      closes.push(sessionId)
    },
    onMigrated: (sessionId) => {
      notifications.push(sessionId)
    },
    now: () => now,
  })
  return {
    coordinator,
    releases,
    upstreamReleases,
    closes,
    notifications,
    setCurrent(value: string) {
      current = value
    },
    setNow(value: number) {
      now = value
    },
  }
}

describe("generation affinity coordinator", () => {
  test("active-call cutover and multiple calls never split one session", async () => {
    const h = harness()
    const first = await h.coordinator.acquire("session")
    h.setCurrent("n+1")
    h.coordinator.cutover("n+1", 100)
    const second = await h.coordinator.acquire("session")

    expect(first.generation.generationId).toBe("n")
    expect(second.generation.generationId).toBe("n")
    expect(h.upstreamReleases).toEqual([])
    first.release()
    expect(h.upstreamReleases).toEqual([])
    second.release()
    await waitFor(() => h.notifications.length === 1)

    const third = await h.coordinator.acquire("session")
    expect(third.generation.generationId).toBe("n+1")
    third.release()
    expect(h.releases).toEqual(["n"])
    expect(h.notifications).toEqual(["session"])
    await h.coordinator.closeAll()
  })

  test("idle migration releases upstream state, preserves id, and emits one list_changed", async () => {
    const h = harness()
    const call = await h.coordinator.acquire("same-id")
    call.release()
    h.setCurrent("n+1")
    h.coordinator.cutover("n+1", 100)
    h.coordinator.cutover("n+1", 100)
    await waitFor(() => h.notifications.length === 1)

    expect(h.upstreamReleases).toEqual(["n:same-id"])
    expect(h.notifications).toEqual(["same-id"])
    const migrated = await h.coordinator.acquire("same-id")
    expect(migrated.generation.generationId).toBe("n+1")
    migrated.release()
    await h.coordinator.closeAll()
  })

  test("release failure closes downstream once and cleans refs", async () => {
    const h = harness({
      release: () => Promise.reject(new Error("release failed")),
    })
    const call = await h.coordinator.acquire("session")
    call.release()
    h.setCurrent("n+1")
    h.coordinator.cutover("n+1", 100)
    await waitFor(() => h.closes.length === 1)

    expect(h.closes).toEqual(["session"])
    expect(h.releases).toEqual(["n"])
    expect(h.coordinator.diagnostics().drainBlockers).toEqual([])
  })

  test("drain deadline closes active downstream and releases after terminal call", async () => {
    const h = harness()
    const call = await h.coordinator.acquire("session")
    h.setCurrent("n+1")
    h.coordinator.cutover("n+1", 10)
    h.setNow(10)
    h.coordinator.expireDrain()
    h.coordinator.expireDrain()
    await waitFor(() => h.closes.length === 1)

    expect(h.closes).toEqual(["session"])
    expect(h.releases).toEqual([])
    call.release()
    expect(h.releases).toEqual(["n"])
    expect(h.coordinator.diagnostics().drainBlockers).toEqual([])
  })

  test("an acquire waiting on migration cannot return a closed released generation", async () => {
    const releasing = deferred<undefined>()
    const h = harness({ release: () => releasing.promise })
    const first = await h.coordinator.acquire("session")
    first.release()
    h.setCurrent("n+1")
    h.coordinator.cutover("n+1", 100)
    const waiting = h.coordinator.acquire("session")
    await waitFor(() => h.upstreamReleases.length === 1)
    await h.coordinator.closeSession("session")
    releasing.resolve(undefined)

    let failure: unknown
    try {
      await waiting
    } catch (error) {
      failure = error
    }
    expect(failure).toBeInstanceOf(SessionAffinityClosedError)
    expect(h.releases).toEqual(["n"])
  })

  test("rapid cutovers retarget an idle migration to the latest generation", async () => {
    const releasing = deferred<undefined>()
    const h = harness({ release: () => releasing.promise })
    const first = await h.coordinator.acquire("session")
    first.release()
    h.setCurrent("n+1")
    h.coordinator.cutover("n+1", 100)
    await waitFor(() => h.upstreamReleases.length === 1)
    h.setCurrent("n+2")
    h.coordinator.cutover("n+2", 100)
    releasing.resolve(undefined)
    await waitFor(() => h.notifications.length === 1)

    const latest = await h.coordinator.acquire("session")
    expect(latest.generation.generationId).toBe("n+2")
    latest.release()
    expect(h.closes).toEqual([])
    expect(h.notifications).toEqual(["session"])
    await h.coordinator.closeAll()
  })

  test("concurrent close and cutover have one terminal disposition", async () => {
    const releasing = deferred<undefined>()
    const h = harness({ release: () => releasing.promise })
    const call = await h.coordinator.acquire("session")
    call.release()
    h.setCurrent("n+1")
    h.coordinator.cutover("n+1", 100)
    await waitFor(() => h.upstreamReleases.length === 1)
    await h.coordinator.closeSession("session")
    releasing.resolve(undefined)
    await Bun.sleep(0)

    expect(h.closes).toEqual([])
    expect(h.notifications).toEqual([])
    expect(h.releases).toEqual(["n"])
    expect(h.coordinator.diagnostics()).toEqual({
      pinnedSessions: [],
      drainBlockers: [],
    })
  })

  test("nested drain reasons pin migration and appear in diagnostics", async () => {
    const h = harness()
    const call = await h.coordinator.acquire("session")
    const nested = h.coordinator.acquireSessionDrainLease(
      "session",
      "spend-acknowledgment",
      "ack-1",
    )
    call.release()
    h.setCurrent("n+1")
    h.coordinator.cutover("n+1", 100)

    expect(h.coordinator.diagnostics().drainBlockers).toEqual([
      {
        generationId: "n",
        count: 2,
        blockers: [
          {
            generationId: "n",
            reason: "session-affinity",
            detail: "session",
          },
          {
            generationId: "n",
            reason: "spend-acknowledgment",
            detail: "ack-1",
          },
        ],
      },
    ])
    expect(h.upstreamReleases).toEqual([])
    nested.release()
    await waitFor(() => h.notifications.length === 1)
    expect(h.coordinator.diagnostics().pinnedSessions[0]?.generationId).toBe(
      "n+1",
    )
    await h.coordinator.closeAll()
  })
})
