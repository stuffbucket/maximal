/**
 * Refreshing a provider's allowance on demand: the rate limit, the Copilot
 * provider's parse of `/copilot_internal/user`, the route, and the refresh at
 * startup. Pinned by mutation testing (`bun run mutate`).
 */

import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test"
import consola from "consola"
import { Hono } from "hono"

import {
  __resetProviderWindowsForTests,
  listProviderWindows,
  observeProviderWindows,
  type ProviderQuotaWindow,
} from "~/lib/budget/provider-windows"
import {
  REFRESH_MIN_INTERVAL_MS,
  createAllowanceRefresher,
  type AllowanceRefresherDeps,
} from "~/lib/budget/refresh"
import {
  __resetBudgetServiceForTests,
  __setAllowanceRefresherForTests,
  refreshAllowanceAtStartup,
  refreshProviderAllowance,
} from "~/lib/budget/runtime"
import { writeConfig } from "~/lib/config/config"
import { BudgetStatusResponse } from "~/lib/config/settings-types"
import { createCopilotProvider } from "~/lib/plugins/providers/copilot"
import { state } from "~/lib/runtime-state/state"
import { closeUsageStore } from "~/lib/token-usage"
import { budgetRoutes } from "~/routes/settings/budget"
import * as githubUsage from "~/services/github/get-copilot-usage"

const DB_PATH_ENV = "COPILOT_API_SQLITE_DB_PATH"
const OBSERVED = "2026-11-10T12:00:00.000Z"

function window(id = "premium_interactions"): ProviderQuotaWindow {
  return {
    provider: "copilot",
    id,
    label: "Copilot premium allowance",
    unit: "requests",
    used: 50,
    limit: 300,
    percentRemaining: 83.3,
    resetsAt: "2026-12-01T00:00:00.000Z",
    kind: "fixed",
    observedAt: OBSERVED,
    source: "endpoint",
  }
}

interface Rig {
  deps: AllowanceRefresherDeps
  asked: Array<string>
  observed: Array<ReadonlyArray<ProviderQuotaWindow>>
  setNow(ms: number): void
  refresher: ReturnType<typeof createAllowanceRefresher>
}

function rig(
  provider: AllowanceRefresherDeps["provider"] = () => ({
    refreshQuotaWindows: () => Promise.resolve([window()]),
  }),
): Rig {
  let now = 1_000_000
  const asked: Array<string> = []
  const observed: Array<ReadonlyArray<ProviderQuotaWindow>> = []
  const deps: AllowanceRefresherDeps = {
    provider: (id) => {
      asked.push(id)
      return provider(id)
    },
    observe: (windows) => {
      observed.push(windows)
    },
    clock: () => now,
  }
  return {
    deps,
    asked,
    observed,
    setNow: (ms) => {
      now = ms
    },
    refresher: createAllowanceRefresher(deps),
  }
}

describe("the allowance refresher", () => {
  test("asks the provider, records what it says, and counts the windows", async () => {
    const r = rig()
    expect(await r.refresher.refresh("copilot")).toEqual({
      ok: true,
      windows: 1,
    })
    expect(r.asked).toEqual(["copilot"])
    expect(r.observed).toEqual([[window()]])
  })

  test("an unknown provider, and one with nothing to ask", async () => {
    expect(await rig(() => undefined).refresher.refresh("nobody")).toEqual({
      ok: false,
      reason: "unknown-provider",
    })
    const r = rig(() => ({}))
    expect(await r.refresher.refresh("plain")).toEqual({
      ok: false,
      reason: "unsupported",
    })
    expect(r.observed).toEqual([])
  })

  test("one ask per provider in 30 s: allowed at exactly 30 s, not a ms before", async () => {
    const r = rig()
    expect(REFRESH_MIN_INTERVAL_MS).toBe(30_000)
    await r.refresher.refresh("copilot")

    r.setNow(1_000_000 + 29_999)
    expect(await r.refresher.refresh("copilot")).toEqual({
      ok: false,
      reason: "rate-limited",
      retryAfterSeconds: 1,
    })
    r.setNow(1_000_000 + 30_000)
    expect((await r.refresher.refresh("copilot")).ok).toBe(true)
    expect(r.observed).toHaveLength(2)
  })

  test("says how long to wait, rounded up to a whole second", async () => {
    const r = rig()
    await r.refresher.refresh("copilot")
    r.setNow(1_000_000)
    expect(await r.refresher.refresh("copilot")).toMatchObject({
      retryAfterSeconds: 30,
    })
    r.setNow(1_000_000 + 10_001)
    expect(await r.refresher.refresh("copilot")).toMatchObject({
      retryAfterSeconds: 20,
    })
    r.setNow(1_000_000 + 10_000)
    expect(await r.refresher.refresh("copilot")).toMatchObject({
      retryAfterSeconds: 20,
    })
  })

  test("each provider has its own clock", async () => {
    const r = rig()
    await r.refresher.refresh("copilot")
    expect((await r.refresher.refresh("other")).ok).toBe(true)
    expect(await r.refresher.refresh("copilot")).toMatchObject({
      reason: "rate-limited",
    })
  })

  test("a rate-limited ask never reaches the provider", async () => {
    let calls = 0
    const r = rig(() => ({
      refreshQuotaWindows: () => {
        calls += 1
        return Promise.resolve([])
      },
    }))
    await r.refresher.refresh("copilot")
    await r.refresher.refresh("copilot")
    await r.refresher.refresh("copilot")
    expect(calls).toBe(1)
  })

  test("a provider that fails is reported, records nothing, and is not asked again at once", async () => {
    let calls = 0
    const r = rig(() => ({
      refreshQuotaWindows: () => {
        calls += 1
        return Promise.reject(new Error("GitHub is down"))
      },
    }))
    const debug = spyOn(consola, "debug").mockImplementation(
      Object.assign(() => {}, { raw: () => {} }),
    )
    try {
      expect(await r.refresher.refresh("copilot")).toEqual({
        ok: false,
        reason: "failed",
        message: "GitHub is down",
      })
      expect(debug.mock.calls[0][0]).toBe(
        "Could not refresh the copilot allowance",
      )
    } finally {
      debug.mockRestore()
    }
    expect(r.observed).toEqual([])
    expect(await r.refresher.refresh("copilot")).toMatchObject({
      reason: "rate-limited",
    })
    expect(calls).toBe(1)
  })

  test("a failure that isn't an Error is still worded", async () => {
    const r = rig(() => ({
      // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
      refreshQuotaWindows: () => Promise.reject("plain text"),
    }))
    expect(await r.refresher.refresh("copilot")).toMatchObject({
      message: "plain text",
    })
  })

  test("uses the real clock by default", async () => {
    const recorded: Array<number> = []
    const refresher = createAllowanceRefresher({
      provider: () => ({
        refreshQuotaWindows: () => {
          recorded.push(Date.now())
          return Promise.resolve([])
        },
      }),
      observe: () => {},
    })
    await refresher.refresh("copilot")
    expect(await refresher.refresh("copilot")).toMatchObject({
      reason: "rate-limited",
    })
    expect(recorded).toHaveLength(1)
  })
})

describe("the Copilot provider's refresh", () => {
  test("reads quota_snapshots as the usage parser documents", async () => {
    const provider = createCopilotProvider({
      getUsage: () =>
        Promise.resolve({
          quota_reset_date: "2026-12-01",
          quota_snapshots: {
            premium_interactions: {
              entitlement: 300,
              remaining: 250,
              percent_remaining: 83.3,
              overage_count: 0,
              overage_permitted: true,
              unlimited: false,
            },
            chat: { entitlement: 0, remaining: 0, unlimited: true },
          },
        }),
    })
    const windows = (await provider.refreshQuotaWindows?.()) ?? []
    expect(windows.map((w) => w.id).sort()).toEqual([
      "chat",
      "premium_interactions",
    ])
    const premium = windows.find((w) => w.id === "premium_interactions")
    expect(premium).toMatchObject({
      provider: "copilot",
      used: 50,
      limit: 300,
      resetsAt: "2026-12-01T00:00:00.000Z",
      source: "endpoint",
    })
  })

  test("an unrecognisable reply is no windows; a failure rejects", async () => {
    const empty = createCopilotProvider({
      getUsage: () => Promise.resolve(null),
    })
    expect(await empty.refreshQuotaWindows?.()).toEqual([])
    const failing = createCopilotProvider({
      getUsage: () => Promise.reject(new Error("401")),
    })
    const failure = await Promise.resolve(failing.refreshQuotaWindows?.()).then(
      () => undefined,
      (error: unknown) => error,
    )
    expect(failure).toBeInstanceOf(Error)
    expect((failure as Error).message).toBe("401")
  })

  test("by default it calls GitHub's /copilot_internal/user reader", async () => {
    const reader = spyOn(githubUsage, "getCopilotUsage").mockResolvedValue({
      quota_reset_date: "2026-12-01",
      quota_snapshots: {},
    } as Awaited<ReturnType<typeof githubUsage.getCopilotUsage>>)
    try {
      expect(await createCopilotProvider().refreshQuotaWindows?.()).toEqual([])
      expect(reader).toHaveBeenCalledTimes(1)
    } finally {
      reader.mockRestore()
    }
  })
})

const app = new Hono().route("/budget", budgetRoutes)

const post = (provider: string) =>
  app.request(`/budget/providers/${provider}/refresh`, { method: "POST" })

describe("POST /settings/api/budget/providers/:provider/refresh", () => {
  beforeEach(async () => {
    process.env[DB_PATH_ENV] = ":memory:"
    await closeUsageStore()
    __resetProviderWindowsForTests()
    __resetBudgetServiceForTests()
    writeConfig({})
  })

  afterEach(async () => {
    __setAllowanceRefresherForTests(undefined)
    __resetBudgetServiceForTests()
    await closeUsageStore()
    __resetProviderWindowsForTests()
    Reflect.deleteProperty(process.env, DB_PATH_ENV)
  })

  afterEach(() => {
    writeConfig({})
  })

  test("records the allowance and returns the new status", async () => {
    __setAllowanceRefresherForTests(
      createAllowanceRefresher({
        provider: () => ({
          refreshQuotaWindows: () => Promise.resolve([window()]),
        }),
        observe: observeProviderWindows,
      }),
    )
    const response = await post("copilot")
    expect(response.status).toBe(200)
    const body = BudgetStatusResponse.parse(await response.json())
    expect(body.provider_windows).toHaveLength(1)
    expect(body.provider_windows[0]).toMatchObject({
      provider: "copilot",
      id: "premium_interactions",
      used: 50,
      limit: 300,
      resets_at: "2026-12-01T00:00:00.000Z",
      source: "endpoint",
    })
    expect((await listProviderWindows()).map((w) => w.id)).toEqual([
      "premium_interactions",
    ])
  })

  test("a rule that follows the window starts following it at once", async () => {
    writeConfig({
      budget: {
        limits: [
          {
            id: "month",
            scope: { kind: "global" },
            limit: 1_000_000_000,
            limitReset: { follow: "copilot:premium_interactions" },
            action: "block",
          },
        ],
      },
    })
    __setAllowanceRefresherForTests(
      createAllowanceRefresher({
        provider: () => ({
          refreshQuotaWindows: () => Promise.resolve([window()]),
        }),
        observe: observeProviderWindows,
      }),
    )
    const before = BudgetStatusResponse.parse(
      await (await app.request("/budget")).json(),
    )
    expect(before.budgets[0].reset_basis).toBe("fallback")
    const after = BudgetStatusResponse.parse(
      await (await post("copilot")).json(),
    )
    expect(after.budgets[0]).toMatchObject({
      reset_basis: "provider",
      resets_at: "2026-12-01T00:00:00.000Z",
    })
  })

  test("a second ask within 30 s is a 429 with Retry-After", async () => {
    let now = 5_000_000
    __setAllowanceRefresherForTests(
      createAllowanceRefresher({
        provider: () => ({
          refreshQuotaWindows: () => Promise.resolve([window()]),
        }),
        observe: observeProviderWindows,
        clock: () => now,
      }),
    )
    expect((await post("copilot")).status).toBe(200)
    now += 12_000
    const limited = await post("copilot")
    expect(limited.status).toBe(429)
    expect(limited.headers.get("retry-after")).toBe("18")
    expect(await limited.json()).toEqual({
      error: {
        type: "rate_limited",
        message:
          "The copilot allowance was read moments ago; try again in 18 s",
        retry_after_seconds: 18,
      },
    })
    now += 18_000
    expect((await post("copilot")).status).toBe(200)
  })

  test("an unknown provider is a 404", async () => {
    const response = await post("nobody")
    expect(response.status).toBe(404)
    expect(await response.json()).toEqual({
      error: { type: "not_found", message: "Unknown provider 'nobody'" },
    })
  })

  test("a provider with nothing to read is a 400 unsupported", async () => {
    __setAllowanceRefresherForTests(
      createAllowanceRefresher({ provider: () => ({}), observe: () => {} }),
    )
    const response = await post("plain")
    expect(response.status).toBe(400)
    expect(await response.json()).toEqual({
      error: {
        type: "unsupported",
        message: "Provider 'plain' doesn't report an allowance to refresh",
      },
    })
  })

  test("a provider that can't be reached is a 502", async () => {
    __setAllowanceRefresherForTests(
      createAllowanceRefresher({
        provider: () => ({
          refreshQuotaWindows: () => Promise.reject(new Error("offline")),
        }),
        observe: () => {},
      }),
    )
    const response = await post("copilot")
    expect(response.status).toBe(502)
    expect(await response.json()).toEqual({
      error: {
        type: "refresh_failed",
        message: "Couldn't read the copilot allowance: offline",
      },
    })
  })
})

function watch(): Array<string> {
  const asked: Array<string> = []
  __setAllowanceRefresherForTests({
    refresh: (id) => {
      asked.push(id)
      return Promise.resolve({ ok: true, windows: 0 })
    },
  })
  return asked
}

describe("the refresh at startup", () => {
  const original = state.githubToken

  afterEach(() => {
    state.githubToken = original
    __setAllowanceRefresherForTests(undefined)
  })

  test("signed in: asks Copilot once", async () => {
    state.githubToken = "gho_test"
    const asked = watch()
    refreshAllowanceAtStartup()
    await Bun.sleep(5)
    expect(asked).toEqual(["copilot"])
  })

  test("not signed in: asks nobody", async () => {
    state.githubToken = undefined
    const asked = watch()
    refreshAllowanceAtStartup()
    await Bun.sleep(5)
    expect(asked).toEqual([])
  })

  test("a refresh that works tells the shell; one that fails doesn't throw", async () => {
    __setAllowanceRefresherForTests({
      refresh: () =>
        Promise.resolve({ ok: false, reason: "failed", message: "x" }),
    })
    expect(await refreshProviderAllowance("copilot")).toEqual({
      ok: false,
      reason: "failed",
      message: "x",
    })
  })
})
