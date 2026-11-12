import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"

import { EpochTrackedStateBroker } from "~/lib/plugins/runner/epoch-tracker"
import { createPluginStateBroker } from "~/lib/plugins/state-broker"

async function rejectionOf(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise
  } catch (error) {
    return error
  }
  throw new Error("Expected promise to reject.")
}

const roots: Array<string> = []

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  )
})

async function root(): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "epoch-tracker-"))
  roots.push(directory)
  return directory
}

describe("EpochTrackedStateBroker", () => {
  test("keeps a synchronous epoch current across local control mutations", async () => {
    const tracked = new EpochTrackedStateBroker(
      createPluginStateBroker(await root()),
    )
    expect(await tracked.sync()).toBe(0)
    expect(tracked.cachedEpoch()).toBe(0)

    await tracked.advanceEpoch("provider:test", "digest-1")
    expect(tracked.cachedEpoch()).toBe(1)

    const selected = await tracked.commitGeneration({
      commitId: "commit",
      handoffIdempotencyKey: "key",
      generationId: "generation",
      inventoryDigest: "inventory",
      baseEpoch: 1,
      pluginRevisions: {},
    })
    expect(selected.epoch).toBe(2)
    expect(tracked.cachedEpoch()).toBe(2)
  })

  test("refreshes after a mutation that fails at its durable point", async () => {
    const directory = await root()
    let fail = true
    const tracked = new EpochTrackedStateBroker(
      createPluginStateBroker(directory, {
        fault: (point) => {
          if (point === "after-commit-point" && fail) {
            fail = false
            throw new Error("crashed after the commit point")
          }
        },
      }),
    )
    await tracked.sync()
    expect(
      String(await rejectionOf(tracked.advanceEpoch("kind", "digest"))),
    ).toContain("crashed")
    expect(tracked.cachedEpoch()).toBe(1)
  })
})
