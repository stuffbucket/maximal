import type {
  PluginGateway,
  PluginGenerationLease,
  PreparedOperation,
  ServerToolView,
} from "@stuffbucket/maximal-plugin-sdk/gateway"

import { afterEach, describe, expect, test } from "bun:test"

import type { BudgetDecision } from "~/lib/budget/service"
import type { BudgetHold, BudgetService } from "~/lib/budget/service"

import { dispatchWithBudget } from "~/lib/budget/dispatch"
import {
  ProviderInvocationJournal,
  providerInvocationJournal,
} from "~/lib/plugins/provider-broker"
import { planServerTools } from "~/routes/messages/server-tools/plan"
import { pluginServerToolListings } from "~/routes/messages/server-tools/plugin-listings"

const COST = 275_000_000
const COST_RESULT = {
  unit: "nano_aiu" as const,
  amount: COST,
  estimated: false,
}

function gate() {
  let resolve!: () => void
  const promise = new Promise<void>((yes) => {
    resolve = yes
  })
  return { promise, resolve }
}

const unsupported = (): never => {
  throw new Error("not used by this accounting lifecycle test")
}

function persistedHold(
  settle: BudgetHold["settle"],
  unreconcile: BudgetHold["unreconcile"] = () => Promise.resolve(),
): BudgetHold {
  return {
    id: "hold-accounting",
    estimateNanoAiu: 600_000_000,
    persisted: true,
    settle,
    commit: () => Promise.resolve(),
    release: () => Promise.resolve(),
    unreconcile,
  }
}

function budgetFor(
  decision: BudgetDecision,
  fallback: BudgetHold,
): BudgetService {
  return {
    reserve: () => Promise.resolve(decision),
    reserveCleared: () => Promise.resolve(fallback),
    check: () =>
      Promise.resolve(decision.ok ? { ok: true, warnings: [] } : decision),
    heldNanoAiu: () => 0,
    stop: () => {},
  }
}

function admittedBudget(hold: BudgetHold): BudgetService {
  return budgetFor({ ok: true, hold, warnings: [] }, hold)
}

function preparedOperation(
  journal: ProviderInvocationJournal,
  onInvocation: (invocationId: string) => void,
): PreparedOperation {
  return {
    operation: "images.generations",
    model: "client-image-model",
    pluginId: "images",
    binding: { provider: "copilot", upstreamModel: "provider-image-model" },
    execute: (request) => {
      onInvocation(request.invocationId)
      const invocation = {
        invocationId: request.invocationId,
        providerCallId: request.providerCallId,
        sequence: request.sequence,
        operation: "images.generations" as const,
        model: "provider-image-model",
      }
      journal.observe({ invocation, provider: "copilot", cost: COST_RESULT })
      return Promise.resolve({
        json: { ok: true },
        usage: { output_tokens: 1 },
        cost: COST_RESULT,
        invocationId: request.invocationId,
        providerCallId: request.providerCallId,
        sequence: request.sequence,
      })
    },
    release: () => {},
  }
}

function dispatch(
  prepared: PreparedOperation,
  budget: BudgetService,
  journal: ProviderInvocationJournal,
) {
  return dispatchWithBudget(
    prepared,
    {
      body: { prompt: "draw" },
      signal: new AbortController().signal,
      origin: { kind: "http", client: "test" },
    },
    { provider: "copilot", budget, journal, record: () => null },
  )
}

interface ServerToolFixture {
  readonly gateway: PluginGateway
  readonly counts: { generationReleases: number; preparedReleases: number }
  readonly invocationId: () => string | undefined
}

function serverToolFixture(): ServerToolFixture {
  const counts = { generationReleases: 0, preparedReleases: 0 }
  let invocationId: string | undefined
  const view: ServerToolView = {
    pluginId: "images-tools",
    name: "generate_image",
    description: "Generate an image",
    input_schema: { type: "object", properties: {} },
    render: "hidden",
    offer: "always",
    clients: ["claude-code"],
    billed: true,
  }
  const generation: PluginGenerationLease = {
    generationId: "generation-one",
    get: unsupported,
    listTools: unsupported,
    toolViews: unsupported,
    serverTools: () => [view],
    operations: unsupported,
    callTool: unsupported,
    prepareServerTool: () =>
      Promise.resolve({
        pluginId: view.pluginId,
        name: view.name,
        estimate: {
          operation: "images.generations" as const,
          provider: "copilot",
          body: { prompt: "draw", quality: "low" },
        },
        execute: (call) => {
          const invocation = call.nextProviderCall(
            "images.generations",
            "provider-image-model",
          )
          invocationId = invocation.invocationId
          providerInvocationJournal.observe({
            invocation,
            provider: "copilot",
            cost: COST_RESULT,
          })
          call.reportSpend?.({
            ...invocation,
            provider: "copilot",
            result: { usage: { output_tokens: 1 }, cost: COST_RESULT },
          })
          return Promise.resolve({
            content: [{ type: "text" as const, text: "done" }],
          })
        },
        release: () => {
          counts.preparedReleases += 1
        },
      }),
    release: () => {
      counts.generationReleases += 1
    },
  }
  const gateway: PluginGateway = {
    acquireGeneration: () => generation,
    reconcile: unsupported,
    list: unsupported,
    get: unsupported,
    listTools: unsupported,
    toolViews: unsupported,
    callTool: unsupported,
    operations: unsupported,
    serverTools: unsupported,
    prepareServerTool: unsupported,
    callServerTool: unsupported,
    runAction: unsupported,
    updateConfig: unsupported,
    setToolPermissions: unsupported,
    importLegacyConfig: unsupported,
    subscribe: unsupported,
    dispose: unsupported,
  }
  return { gateway, counts, invocationId: () => invocationId }
}

const toolUse = {
  type: "tool_use" as const,
  id: "toolu_accounting",
  name: "generate_image",
  input: { prompt: "draw" },
}

const toolCall = {
  signal: new AbortController().signal,
  model: "claude-test",
  client: "claude-code",
}

afterEach(() => providerInvocationJournal.reset())

describe("provider observation settlement lifetime", () => {
  test("operation evidence remains until durable settlement succeeds", async () => {
    const journal = new ProviderInvocationJournal()
    const settlementStarted = gate()
    const settlement = gate()
    let invocationId: string | undefined
    const hold = persistedHold(async () => {
      settlementStarted.resolve()
      await settlement.promise
    })

    const pending = dispatch(
      preparedOperation(journal, (id) => {
        invocationId = id
      }),
      admittedBudget(hold),
      journal,
    )
    await settlementStarted.promise

    expect(invocationId).toBeDefined()
    expect(journal.unacknowledged(invocationId ?? "")).toHaveLength(1)
    settlement.resolve()
    await pending
    expect(journal.unacknowledged(invocationId ?? "")).toEqual([])
  })

  test("operation evidence remains when durable settlement fails", async () => {
    const journal = new ProviderInvocationJournal()
    const failure = new Error("settlement failed")
    let invocationId: string | undefined
    let orphanReason = ""
    const hold = persistedHold(
      () => Promise.reject(failure),
      (reason) => {
        orphanReason = reason
        return Promise.resolve()
      },
    )

    const caught = await dispatch(
      preparedOperation(journal, (id) => {
        invocationId = id
      }),
      admittedBudget(hold),
      journal,
    ).catch((error: unknown) => error)

    expect(caught).toBe(failure)
    expect(orphanReason).toBe("settlement-failed")
    expect(journal.unacknowledged(invocationId ?? "")).toHaveLength(1)
  })

  test("server-tool evidence remains pending and clears after settlement", async () => {
    const fixture = serverToolFixture()
    const settlementStarted = gate()
    const settlement = gate()
    const hold = persistedHold(async () => {
      settlementStarted.resolve()
      await settlement.promise
    })
    const [listing] = pluginServerToolListings(
      fixture.gateway,
      () => {},
      admittedBudget(hold),
    )

    const pending = listing.run(toolUse, toolCall)
    await settlementStarted.promise
    expect(
      providerInvocationJournal.unacknowledged(fixture.invocationId() ?? ""),
    ).toHaveLength(1)

    settlement.resolve()
    expect((await pending).ok).toBe(true)
    expect(
      providerInvocationJournal.unacknowledged(fixture.invocationId() ?? ""),
    ).toEqual([])
    expect(fixture.counts.preparedReleases).toBe(1)
    listing.release?.()
  })

  test("server-tool evidence remains when settlement fails", async () => {
    const fixture = serverToolFixture()
    const failure = new Error("server-tool settlement failed")
    let settlements = 0
    const hold = persistedHold(() => {
      settlements += 1
      return Promise.reject(failure)
    })
    const [listing] = pluginServerToolListings(
      fixture.gateway,
      () => {},
      admittedBudget(hold),
    )

    const caught = await listing
      .run(toolUse, toolCall)
      .catch((error: unknown) => error)

    expect(caught).toBe(failure)
    expect(settlements).toBe(1)
    expect(
      providerInvocationJournal.unacknowledged(fixture.invocationId() ?? ""),
    ).toHaveLength(1)
    expect(fixture.counts.preparedReleases).toBe(1)
    listing.release?.()
  })
})

describe("server-tool lease release", () => {
  test("budget refusal plus repeated plan release releases each pin once", async () => {
    const fixture = serverToolFixture()
    const fallback = persistedHold(() => Promise.resolve())
    const refusing = budgetFor(
      {
        ok: false,
        refusal: {
          limitId: "tool-limit",
          label: "Tool limit",
          scope: { kind: "plugin", id: "images-tools" },
          unit: "nano_aiu",
          limit: 0,
          used: 0,
          held: 0,
          requested: 600_000_000,
          resetsAtMs: null,
          resetEstimated: false,
          inFlight: false,
          message: "Tool limit is exhausted.",
          creditUsd: 0.01,
        },
      },
      fallback,
    )
    const listings = pluginServerToolListings(
      fixture.gateway,
      () => {},
      refusing,
    )
    const plan = planServerTools({
      payload: {
        tools: [
          {
            name: "Read",
            description: "Read a file",
            input_schema: { type: "object", properties: {} },
          },
        ],
      },
      listings,
      declared: new Set(),
      request: { ...toolCall, compact: false },
      logger: { warn: () => {} },
    })

    const run = await plan.tools.get("generate_image")?.run(toolUse)
    expect(run?.ok).toBe(false)
    expect(fixture.counts.preparedReleases).toBe(1)
    plan.release()
    plan.release()
    expect(fixture.counts.generationReleases).toBe(1)
  })
})
