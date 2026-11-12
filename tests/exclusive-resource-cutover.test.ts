import type { PluginResourceLifecycle } from "@stuffbucket/maximal-plugin-sdk"

import { describe, expect, test } from "bun:test"

import { DurableExclusiveResourceManager } from "~/lib/plugins/exclusive-resource-cutover"

const RESOURCE = "figjam-bridge:4150"

interface HookProbe {
  prepare: number
  commit: number
  revoke: number
  resume: number
}

function lifecycle(probe: HookProbe): PluginResourceLifecycle {
  return {
    declaration: { mode: "exclusive", resources: [RESOURCE] },
    prepare() {
      probe.prepare += 1
    },
    commit() {
      probe.commit += 1
    },
    revoke() {
      probe.revoke += 1
    },
    resume() {
      probe.resume += 1
    },
  }
}

function probe(): HookProbe {
  return { prepare: 0, commit: 0, revoke: 0, resume: 0 }
}

async function generations() {
  const manager = new DurableExclusiveResourceManager<object>()
  const oldProbe = probe()
  const newProbe = probe()
  const current = manager.createGeneration("old", [
    { pluginId: "figjam", hooks: lifecycle(oldProbe) },
  ])
  manager.createGeneration("new", [
    { pluginId: "figjam", hooks: lifecycle(newProbe) },
  ])
  await current.prepare()
  await current.commit()
  expect(manager.leases.owner(RESOURCE)).toBe("old/figjam")
  return { manager, oldProbe, newProbe }
}

function handoffInput(options: {
  commitDurably: (key: string) => Promise<"committed" | "not-committed">
  queryDurableCommit: (key: string) => Promise<"committed" | "not-committed">
}) {
  return {
    commitId: "commit-new",
    idempotencyKey: "handoff-old-new",
    fromGenerationId: "old",
    toGenerationId: "new",
    resources: [RESOURCE],
    ...options,
  }
}

describe("durable exclusive-resource cutover", () => {
  test("retries an unknown acknowledgement with the same tuple and key", async () => {
    const { manager, oldProbe, newProbe } = await generations()
    const queriedKeys: Array<string> = []
    const committedKeys: Array<string> = []
    let queryCount = 0
    let selected = false

    await manager.handoff(
      handoffInput({
        commitDurably(key) {
          committedKeys.push(key)
          selected = true
          return Promise.reject(new Error("durable acknowledgement lost"))
        },
        queryDurableCommit(key) {
          queriedKeys.push(key)
          queryCount += 1
          if (queryCount === 2)
            return Promise.reject(new Error("durable store unavailable"))
          return Promise.resolve(selected ? "committed" : "not-committed")
        },
      }),
      new AbortController().signal,
    )

    expect(committedKeys).toEqual(["handoff-old-new"])
    expect(queriedKeys).toEqual([
      "handoff-old-new",
      "handoff-old-new",
      "handoff-old-new",
    ])
    expect(oldProbe.resume).toBe(0)
    expect(oldProbe.revoke).toBe(1)
    expect(newProbe.commit).toBe(1)
    expect(manager.leases.owner(RESOURCE)).toBe("new/figjam")
  })

  test("a committed durable selection converges to N+1 without restoring N", async () => {
    const { manager, oldProbe, newProbe } = await generations()
    let commits = 0

    await manager.handoff(
      handoffInput({
        commitDurably() {
          commits += 1
          return Promise.resolve("committed")
        },
        queryDurableCommit() {
          return Promise.resolve("committed")
        },
      }),
      new AbortController().signal,
    )

    expect(commits).toBe(0)
    expect(oldProbe.revoke).toBe(1)
    expect(oldProbe.resume).toBe(0)
    expect(newProbe.prepare).toBe(1)
    expect(newProbe.commit).toBe(1)
    expect(manager.leases.owner(RESOURCE)).toBe("new/figjam")
  })
})
