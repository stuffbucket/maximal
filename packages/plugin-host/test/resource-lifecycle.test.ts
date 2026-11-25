import type {
  PluginLifecycleContext,
  PluginResourceDeclaration,
  PluginResourceLifecycle,
} from "@stuffbucket/maximal-plugin-sdk"

import { ExclusiveResourceLeaseRegistry } from "@stuffbucket/maximal-plugin-sdk"
import { describe, expect, test } from "bun:test"

import {
  HostGenerationResourceLifecycle,
  ManagedPluginResourceLifecycle,
} from "../src/resource-lifecycle"

interface HookState {
  declaration: PluginResourceDeclaration
  commits: number
  physical: boolean
  failCommit: boolean
  failRevoke: boolean
}

function hooks(state: HookState): PluginResourceLifecycle {
  return {
    get declaration() {
      return state.declaration
    },
    prepare: () => Promise.resolve(),
    commit: () => {
      state.commits += 1
      state.physical = true
      if (state.failCommit) throw new Error("commit failed")
      return Promise.resolve()
    },
    revoke: () => {
      if (state.failRevoke) throw new Error("revoke failed")
      state.physical = false
      return Promise.resolve()
    },
    resume(context: PluginLifecycleContext) {
      return this.commit(context)
    },
  }
}

function state(resource: string): HookState {
  return {
    declaration: { mode: "exclusive", resources: [resource] },
    commits: 0,
    physical: false,
    failCommit: false,
    failRevoke: false,
  }
}

// Four fixture fields keep each ownership assertion explicit.
// eslint-disable-next-line max-params
function slot(
  pluginId: string,
  generationId: string,
  value: HookState,
  leases: ExclusiveResourceLeaseRegistry,
): ManagedPluginResourceLifecycle {
  return new ManagedPluginResourceLifecycle({
    pluginId,
    generationId,
    hooks: hooks(value),
    leases,
  })
}

describe("managed plugin resource lifecycle", () => {
  test("commits a restarted child slot even when its declaration is unchanged", async () => {
    const leases = new ExclusiveResourceLeaseRegistry()
    const value = state("fixture:singleton")
    const managed = slot("plugin", "generation", value, leases)

    await managed.prepare()
    await managed.commit()
    value.physical = false
    await managed.sync()

    expect(value.commits).toBe(2)
    expect(value.physical).toBe(true)
    expect(leases.snapshot()).toEqual({
      "fixture:singleton": "generation/plugin",
    })
  })

  test("retains a new parent lease when child commit is ambiguous", async () => {
    const leases = new ExclusiveResourceLeaseRegistry()
    const value = state("fixture:singleton")
    value.declaration = { mode: "overlap-safe" }
    const managed = slot("plugin", "generation", value, leases)
    await managed.prepare()
    await managed.commit()

    value.declaration = {
      mode: "exclusive",
      resources: ["fixture:singleton"],
    }
    value.failCommit = true
    expect(
      String(await managed.sync().catch((error: unknown) => error)),
    ).toContain("commit failed")

    expect(value.physical).toBe(true)
    expect(leases.snapshot()).toEqual({
      "fixture:singleton": "generation/plugin",
    })

    value.failCommit = false
    await managed.sync()
    expect(value.physical).toBe(true)
    expect(value.commits).toBe(3)
  })

  test("keeps the old lease until a replacement is bound", async () => {
    const leases = new ExclusiveResourceLeaseRegistry()
    const value = state("fixture:old")
    const managed = slot("plugin", "generation", value, leases)
    await managed.prepare()
    await managed.commit()
    leases.acquire("foreign", ["fixture:new"])

    value.declaration = {
      mode: "exclusive",
      resources: ["fixture:new"],
    }
    expect(
      String(await managed.sync().catch((error: unknown) => error)),
    ).toContain("already leased by foreign")
    expect(value.commits).toBe(1)
    expect(leases.snapshot()).toEqual({
      "fixture:old": "generation/plugin",
      "fixture:new": "foreign",
    })

    leases.release("foreign", ["fixture:new"])
    value.failCommit = true
    expect(
      String(await managed.sync().catch((error: unknown) => error)),
    ).toContain("commit failed")
    expect(leases.snapshot()).toEqual({
      "fixture:old": "generation/plugin",
      "fixture:new": "generation/plugin",
    })

    value.failCommit = false
    await managed.sync()
    expect(leases.snapshot()).toEqual({
      "fixture:new": "generation/plugin",
    })
  })
})

describe("generation resource lifecycle", () => {
  test("rolls back earlier slots when a later commit fails", async () => {
    const leases = new ExclusiveResourceLeaseRegistry()
    const first = state("fixture:first")
    const second = state("fixture:second")
    second.failCommit = true
    const firstSlot = slot("a", "generation", first, leases)
    const secondSlot = slot("b", "generation", second, leases)
    const generation = new HostGenerationResourceLifecycle({
      slots: () => [secondSlot, firstSlot],
      overlapSafe: () => [],
    })
    await generation.prepare()

    expect(
      String(await generation.commit().catch((error: unknown) => error)),
    ).toContain("commit failed")
    expect(first.physical).toBe(false)
    expect(firstSlot.view().phase).toBe("prepared")
    expect(secondSlot.view().phase).toBe("prepared")
    expect(leases.snapshot()).toEqual({})

    second.failCommit = false
    await generation.commit()
    expect(firstSlot.view().phase).toBe("committed")
    expect(secondSlot.view().phase).toBe("committed")
    expect(first.physical).toBe(true)
    expect(second.physical).toBe(true)
  })

  test("keeps a failed rollback slot and its lease quarantined", async () => {
    const leases = new ExclusiveResourceLeaseRegistry()
    const first = state("fixture:first")
    const second = state("fixture:second")
    first.failRevoke = true
    second.failCommit = true
    const firstSlot = slot("a", "generation", first, leases)
    const secondSlot = slot("b", "generation", second, leases)
    const generation = new HostGenerationResourceLifecycle({
      slots: () => [firstSlot, secondSlot],
      overlapSafe: () => [],
    })
    await generation.prepare()

    const failure = await generation.commit().catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(AggregateError)
    expect(first.physical).toBe(true)
    expect(firstSlot.view().phase).toBe("committed")
    expect(leases.snapshot()).toEqual({
      "fixture:first": "generation/a",
    })
  })
})
