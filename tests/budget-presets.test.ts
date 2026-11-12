/**
 * Reset and persona presets: the pure builders and GET /settings/api/budget/presets.
 * Presets are suggestions; nothing here may change the config.
 */

import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test"
import { Hono } from "hono"

import {
  buildBudgetPresets,
  personaPresets,
  resetPresets,
  slugOf,
} from "~/lib/budget/presets"
import { __resetProviderWindowsForTests } from "~/lib/budget/provider-windows"
import { __resetBudgetServiceForTests } from "~/lib/budget/runtime"
import { BudgetLimitId } from "~/lib/budget/schema"
import { getConfig, writeConfig } from "~/lib/config/config"
import {
  BudgetLimitPutRequest,
  BudgetPresetsResponse,
} from "~/lib/config/settings-types"
import { closeUsageStore } from "~/lib/token-usage"
import { budgetRoutes } from "~/routes/settings/budget"

const DB_PATH_ENV = "COPILOT_API_SQLITE_DB_PATH"
const AIU = 1_000_000_000
const USD = { unit: "usd", creditUsd: 0.01 } as const

function buildApp(): Hono {
  const app = new Hono()
  app.route("/budget", budgetRoutes)
  return app
}

describe("reset presets", () => {
  test("the fixed choices, in the order a person would look for them", () => {
    const presets = resetPresets([])
    expect(presets.map((preset) => preset.id)).toEqual([
      "daily",
      "weekly",
      "monthly-1",
      "every-5h",
      "every-24h",
      "every-7d",
      "never",
    ])
    const byId = new Map(presets.map((preset) => [preset.id, preset]))
    expect(byId.get("every-5h")).toMatchObject({
      label: "Every 5 hours (rolling)",
      limit_reset: { every: { hours: 5 } },
      window: null,
    })
    expect(byId.get("every-24h")?.limit_reset).toEqual({ every: { hours: 24 } })
    expect(byId.get("every-7d")?.limit_reset).toEqual({ every: { days: 7 } })
    expect(byId.get("monthly-1")).toMatchObject({
      label: "Monthly on the 1st",
      limit_reset: { monthly: { day: 1 } },
    })
    expect(byId.get("weekly")?.label).toBe("Weekly")
    expect(byId.get("daily")?.limit_reset).toBe("daily")
    expect(byId.get("never")?.limit_reset).toBe("never")
  })

  test("describes third-party plans generically, never with a provider's numbers", () => {
    const text = JSON.stringify(resetPresets([]))
    expect(text).toContain(
      "like the rolling 5-hour plan windows some providers use",
    )
    for (const name of [
      "Anthropic",
      "Claude",
      "OpenAI",
      "ChatGPT",
      "Copilot",
    ]) {
      expect(text).not.toContain(name)
    }
  })

  test("adds a Follow preset for each window a provider reported", () => {
    const presets = resetPresets([
      {
        provider: "copilot",
        id: "premium_interactions",
        label: "Copilot premium allowance",
      },
      { provider: "acme", id: "five_hour", label: "Acme 5-hour window" },
    ])
    expect(presets.slice(7)).toEqual([
      {
        id: "follow:copilot:premium_interactions",
        label: "Follow Copilot premium allowance",
        description:
          "Starts over when the provider resets: Copilot premium allowance.",
        limit_reset: { follow: "copilot:premium_interactions" },
        window: "copilot:premium_interactions",
      },
      {
        id: "follow:acme:five_hour",
        label: "Follow Acme 5-hour window",
        description:
          "Starts over when the provider resets: Acme 5-hour window.",
        limit_reset: { follow: "acme:five_hour" },
        window: "acme:five_hour",
      },
    ])
  })
})

describe("persona presets", () => {
  const personas = personaPresets({ display: USD, windows: [], keyLabels: [] })
  const byId = new Map(personas.map((persona) => [persona.id, persona]))

  test("the four personas, worded with their amounts", () => {
    expect(personas.map((persona) => persona.label)).toEqual([
      "Trying things out: $5.00/day",
      "Daily driver: $20.00/day plus $100.00/week",
      "Heavy agent use: $50.00 per rolling 5 hours, warn at 80%",
      "Team: per-key caps of $20.00/day",
    ])
  })

  test("trying things out is one daily global cap", () => {
    expect(byId.get("trying-things-out")?.limits).toEqual([
      {
        id: "daily-cap",
        label: "Daily cap",
        scope: { kind: "global" },
        limit: 500_000_000_000,
        amount: 5,
        limit_reset: "daily",
        warn_at: 0.8,
        action: "block",
      },
    ])
    // $5 at $0.01 per credit is 500 credits.
    expect(500 * AIU).toBe(500_000_000_000)
  })

  test("daily driver adds a weekly cap", () => {
    const limits = byId.get("daily-driver")?.limits ?? []
    expect(limits.map((l) => [l.id, l.limit_reset, l.amount, l.limit])).toEqual(
      [
        ["daily-cap", "daily", 20, 2000 * AIU],
        ["weekly-cap", "weekly", 100, 10_000 * AIU],
      ],
    )
  })

  test("heavy agent use is a rolling five hours, warning at 80%", () => {
    expect(byId.get("heavy-agent-use")?.limits).toEqual([
      {
        id: "rolling-5h-cap",
        label: "Rolling 5-hour cap",
        scope: { kind: "global" },
        limit: 5000 * AIU,
        amount: 50,
        limit_reset: { every: { hours: 5 } },
        warn_at: 0.8,
        action: "block",
      },
    ])
  })

  test("team with no keys is one template that asks which key", () => {
    const team = byId.get("team")
    expect(team?.description).toBe(
      "One daily cap per client key. Pick the key each cap applies to.",
    )
    expect(team?.limits).toEqual([
      {
        id: "team-key-daily",
        label: "Daily cap for each key",
        scope: { kind: "key", id: null },
        limit: 2000 * AIU,
        amount: 20,
        limit_reset: "daily",
        warn_at: 0.8,
        action: "block",
      },
    ])
  })

  test("team with keys is one cap per distinct key", () => {
    const team = personaPresets({
      display: USD,
      windows: [],
      keyLabels: ["My laptop", "ci", "ci"],
    }).find((persona) => persona.id === "team")
    expect(team?.description).toBe(
      "One daily cap for each of your client keys.",
    )
    expect(team?.limits.map((l) => [l.id, l.label, l.scope])).toEqual([
      [
        "my-laptop-daily",
        "Daily cap for My laptop",
        { kind: "key", id: "My laptop" },
      ],
      ["ci-daily", "Daily cap for ci", { kind: "key", id: "ci" }],
    ])
  })

  test("amounts follow the display unit and the credit rate", () => {
    const credits = personaPresets({
      display: { unit: "credits", creditUsd: 0.02 },
      windows: [],
      keyLabels: [],
    })
    expect(credits[0].label).toBe("Trying things out: 250.00 AI credits/day")
    // $5 at $0.02 per credit is 250 credits, whatever the unit shown.
    expect(credits[0].limits[0]).toMatchObject({
      limit: 250 * AIU,
      amount: 250,
    })

    const dollars = personaPresets({
      display: { unit: "usd", creditUsd: 0.02 },
      windows: [],
      keyLabels: [],
    })
    expect(dollars[0].limits[0]).toMatchObject({ limit: 250 * AIU, amount: 5 })
  })

  test("every concrete suggestion is a valid rule", () => {
    const all = personaPresets({
      display: USD,
      windows: [],
      keyLabels: ["My laptop"],
    })
    for (const persona of all) {
      for (const suggestion of persona.limits) {
        expect(BudgetLimitId.safeParse(suggestion.id).success).toBe(true)
        const { id: _id, amount: _amount, ...fields } = suggestion
        const body = BudgetLimitPutRequest.safeParse(fields)
        expect(body.success).toBe(true)
      }
    }
  })
})

describe("slugOf", () => {
  test("makes a valid rule id from a label", () => {
    expect(slugOf("My Laptop!")).toBe("my-laptop")
    expect(slugOf("  --a__b--  ")).toBe("a-b")
    expect(slugOf("***")).toBe("key")
    expect(slugOf("")).toBe("key")
    expect(slugOf("x".repeat(100))).toBe("x".repeat(40))
    // Cutting at 40 must not leave a trailing dash.
    expect(slugOf(`${"x".repeat(39)} y`)).toBe("x".repeat(39))
    expect(BudgetLimitId.safeParse(`${slugOf("é ü")}-daily`).success).toBe(true)
  })
})

describe("buildBudgetPresets", () => {
  test("carries the display unit with both lists", () => {
    const built = buildBudgetPresets({
      display: { unit: "credits", creditUsd: 0.02 },
      windows: [],
      keyLabels: [],
    })
    expect(built.display).toEqual({ unit: "credits", credit_usd: 0.02 })
    expect(built.resets).toHaveLength(7)
    expect(built.personas).toHaveLength(4)
  })
})

describe("GET /settings/api/budget/presets", () => {
  beforeEach(async () => {
    process.env[DB_PATH_ENV] = ":memory:"
    await closeUsageStore()
    __resetProviderWindowsForTests()
    __resetBudgetServiceForTests()
    writeConfig({})
  })

  afterEach(async () => {
    __resetBudgetServiceForTests()
    await closeUsageStore()
    __resetProviderWindowsForTests()
    Reflect.deleteProperty(process.env, DB_PATH_ENV)
  })

  afterAll(() => {
    writeConfig({})
  })

  test("serves the presets in the contract, and applies none of them", async () => {
    const response = await buildApp().request("/budget/presets")
    expect(response.status).toBe(200)
    const body = BudgetPresetsResponse.parse(await response.json())
    expect(body.display).toEqual({ unit: "usd", credit_usd: 0.01 })
    expect(body.resets.map((preset) => preset.id)).toContain("every-5h")
    expect(body.personas).toHaveLength(4)
    expect(getConfig().budget?.limits ?? []).toEqual([])
  })

  test("uses the configured display unit and the enabled keys' labels", async () => {
    writeConfig({
      budget: { display: { unit: "credits" } },
      auth: {
        apiKeyEntries: [
          {
            id: "1",
            label: "laptop",
            key: "sk-maximal-aaaaaaaaaaaaaaaaaaaaaaaa",
            enabled: true,
            created_at: "2026-11-01T00:00:00Z",
          },
          {
            id: "2",
            label: "paused",
            key: "sk-maximal-bbbbbbbbbbbbbbbbbbbbbbbb",
            enabled: false,
            created_at: "2026-11-01T00:00:00Z",
          },
        ],
      },
    })
    const response = await buildApp().request("/budget/presets")
    const body = BudgetPresetsResponse.parse(await response.json())
    expect(body.display.unit).toBe("credits")
    const team = body.personas.find((persona) => persona.id === "team")
    expect(team?.limits.map((l) => l.scope)).toEqual([
      { kind: "key", id: "laptop" },
    ])
  })
})
