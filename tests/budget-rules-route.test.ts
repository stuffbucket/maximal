/**
 * /settings/api/budget filters and rules export/import over the real config
 * module and the real usage store (nothing is module-mocked).
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

import { __resetProviderWindowsForTests } from "~/lib/budget/provider-windows"
import { __resetBudgetServiceForTests } from "~/lib/budget/runtime"
import { getConfig, writeConfig } from "~/lib/config/config"
import { settingsEventBus } from "~/lib/config/settings-events"
import {
  BudgetFiltersResponse,
  BudgetRulesDocument,
  BudgetRulesImportResponse,
  type BudgetRuleFilter,
  type BudgetRuleLimit,
  BudgetStatusResponse,
} from "~/lib/config/settings-types"
import { closeUsageStore } from "~/lib/token-usage"
import { budgetRoutes } from "~/routes/settings/budget"

const DB_PATH_ENV = "COPILOT_API_SQLITE_DB_PATH"
const AIU = 1_000_000_000

const app = new Hono().route("/budget", budgetRoutes)

function send(method: string, path: string, body?: unknown): Promise<Response> {
  return Promise.resolve(
    app.request(`/budget${path}`, {
      method,
      headers: { "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
  )
}

interface ErrorBody {
  error: {
    type: string
    message: string
    details?: Array<{ path: string; message: string }>
  }
}

async function errorOf(response: Response): Promise<ErrorBody["error"]> {
  return ((await response.json()) as ErrorBody).error
}

const claude: Omit<BudgetRuleFilter, "id"> = {
  name: "Claude models",
  kind: "models",
  members: ["claude-*"],
}
const rule: Omit<BudgetRuleLimit, "id"> = {
  label: "Claude",
  scope: { kind: "filter", id: "claude" },
  limit: 5 * AIU,
  limit_reset: "daily",
  warn_at: 0.8,
  action: "block",
}

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

describe("filters", () => {
  test("PUT creates, then replaces, a filter and replies with the status", async () => {
    const created = await send("PUT", "/filters/claude", {
      ...claude,
      members: ["claude-*", "claude-*", "o1"],
    })
    expect(created.status).toBe(200)
    const body = BudgetStatusResponse.parse(await created.json())
    expect(body.filters).toEqual([
      {
        id: "claude",
        name: "Claude models",
        kind: "models",
        // Repeats are dropped.
        members: ["claude-*", "o1"],
        used_by: [],
      },
    ])
    expect(getConfig().budget?.filters).toEqual([
      {
        id: "claude",
        name: "Claude models",
        kind: "models",
        members: ["claude-*", "o1"],
      },
    ])

    const replaced = await send("PUT", "/filters/claude", {
      name: "Agents",
      kind: "clients",
      members: ["codex"],
    })
    const next = BudgetStatusResponse.parse(await replaced.json())
    expect(next.filters).toHaveLength(1)
    expect(next.filters[0]).toMatchObject({ name: "Agents", kind: "clients" })
  })

  test("GET lists them with the rules that use each", async () => {
    await send("PUT", "/filters/claude", claude)
    await send("PUT", "/filters/agents", {
      name: "Agents",
      kind: "clients",
      members: ["codex"],
    })
    await send("PUT", "/limits/claude-daily", rule)
    await send("PUT", "/limits/claude-weekly", {
      ...rule,
      limit_reset: "weekly",
    })

    const response = await send("GET", "/filters")
    expect(response.status).toBe(200)
    const body = BudgetFiltersResponse.parse(await response.json())
    expect(body.filters.map((filter) => [filter.id, filter.used_by])).toEqual([
      ["claude", ["claude-daily", "claude-weekly"]],
      ["agents", []],
    ])
  })

  test("a bad id or body is a 400", async () => {
    expect((await send("PUT", "/filters/Bad Id", claude)).status).toBe(400)
    for (const body of [
      { ...claude, members: [] },
      { ...claude, kind: "tools" },
      { ...claude, name: "" },
      { ...claude, extra: 1 },
      { name: "x" },
    ]) {
      expect((await send("PUT", "/filters/f", body)).status).toBe(400)
    }
    expect(
      (await app.request("/budget/filters/f", { method: "PUT", body: "nope" }))
        .status,
    ).toBe(400)
    expect(getConfig().budget?.filters ?? []).toEqual([])
  })

  test("DELETE removes an unused filter, and 404s an unknown one", async () => {
    await send("PUT", "/filters/claude", claude)
    const gone = await send("DELETE", "/filters/claude")
    expect(gone.status).toBe(200)
    expect(BudgetStatusResponse.parse(await gone.json()).filters).toEqual([])
    expect(getConfig().budget?.filters).toEqual([])

    const missing = await send("DELETE", "/filters/claude")
    expect(missing.status).toBe(404)
    expect((await errorOf(missing)).type).toBe("not_found")
  })

  test("DELETE is refused while a rule uses the filter, naming the rules", async () => {
    await send("PUT", "/filters/claude", claude)
    await send("PUT", "/limits/claude-daily", rule)

    const refused = await send("DELETE", "/filters/claude")
    expect(refused.status).toBe(409)
    expect(await refused.json()).toEqual({
      error: {
        message:
          "Filter 'claude' is used by rule claude-daily. Change or delete it first.",
        type: "filter_in_use",
        details: { used_by: ["claude-daily"] },
      },
    })
    expect(getConfig().budget?.filters).toHaveLength(1)

    await send("PUT", "/limits/claude-weekly", {
      ...rule,
      limit_reset: "weekly",
    })
    const two = await send("DELETE", "/filters/claude")
    expect((await errorOf(two)).message).toBe(
      "Filter 'claude' is used by rules claude-daily, claude-weekly. Change or delete them first.",
    )

    // Once the rules go, so can the filter.
    await send("DELETE", "/limits/claude-daily")
    await send("DELETE", "/limits/claude-weekly")
    expect((await send("DELETE", "/filters/claude")).status).toBe(200)
  })

  test("a rule can't be scoped to a filter that doesn't exist", async () => {
    const response = await send("PUT", "/limits/claude-daily", rule)
    expect(response.status).toBe(400)
    expect(await errorOf(response)).toMatchObject({
      type: "validation_error",
      message: "Unknown filter 'claude'; create it first",
    })
    expect(getConfig().budget?.limits ?? []).toEqual([])

    await send("PUT", "/filters/claude", claude)
    expect((await send("PUT", "/limits/claude-daily", rule)).status).toBe(200)
  })

  test("a rule scoped to a filter reports it, and sorts before a key rule", async () => {
    await send("PUT", "/filters/claude", claude)
    await send("PUT", "/limits/a-key", {
      ...rule,
      scope: { kind: "key", id: "codex" },
    })
    const response = await send("PUT", "/limits/z-filter", rule)
    const body = BudgetStatusResponse.parse(await response.json())
    expect(body.budgets.map((budget) => [budget.id, budget.scope])).toEqual([
      ["z-filter", { kind: "filter", id: "claude" }],
      ["a-key", { kind: "key", id: "codex" }],
    ])
  })

  test("changes are pushed as budget.changed", async () => {
    const seen: Array<unknown> = []
    const stop = settingsEventBus.subscribe("budget.changed", (status) => {
      seen.push(status)
    })
    try {
      await send("PUT", "/filters/claude", claude)
      await Bun.sleep(20)
    } finally {
      stop()
    }
    expect(seen).toHaveLength(1)
  })
})

describe("GET /rules/export", () => {
  test("serves the document in the contract", async () => {
    await send("PUT", "/filters/claude", claude)
    await send("PUT", "/limits/claude-daily", rule)
    const response = await send("GET", "/rules/export")
    expect(response.status).toBe(200)
    const body = BudgetRulesDocument.parse(await response.json())
    expect(body).toEqual({
      version: 1,
      filters: [{ id: "claude", ...claude }],
      limits: [
        {
          id: "claude-daily",
          ...rule,
          notify: { warn: "notification", limit: "both" },
        },
      ],
      display: { unit: "usd", credit_usd: 0.01 },
    })
  })
})

const importable: BudgetRulesDocument = {
  version: 1,
  filters: [{ id: "claude", ...claude }],
  limits: [{ id: "claude-daily", ...rule }],
  display: { unit: "credits", credit_usd: 0.02 },
}

describe("POST /rules/import", () => {
  test("a dry run reports the diff and changes nothing", async () => {
    const response = await send("POST", "/rules/import", {
      rules: importable,
      mode: "replace",
      dryRun: true,
    })
    expect(response.status).toBe(200)
    const body = BudgetRulesImportResponse.parse(await response.json())
    expect(body).toMatchObject({
      mode: "replace",
      dry_run: true,
      applied: false,
    })
    expect(body.filters.added).toHaveLength(1)
    expect(body.limits.added).toHaveLength(1)
    expect(body.display).toEqual({
      changed: true,
      before: { unit: "usd", credit_usd: 0.01 },
      after: { unit: "credits", credit_usd: 0.02 },
    })
    expect(getConfig().budget?.limits ?? []).toEqual([])
    expect(getConfig().budget?.filters ?? []).toEqual([])
    expect(getConfig().budget?.display).toBeUndefined()
  })

  test("applying writes the config, and a second import changes nothing", async () => {
    const response = await send("POST", "/rules/import", {
      rules: importable,
      mode: "replace",
      dryRun: false,
    })
    expect(response.status).toBe(200)
    expect(
      BudgetRulesImportResponse.parse(await response.json()),
    ).toMatchObject({
      dry_run: false,
      applied: true,
    })
    expect(getConfig().budget).toMatchObject({
      display: { unit: "credits", creditUsd: 0.02 },
      filters: [{ id: "claude", ...claude }],
      limits: [
        {
          id: "claude-daily",
          label: "Claude",
          scope: { kind: "filter", id: "claude" },
          limit: 5 * AIU,
          limitReset: "daily",
          warnAt: 0.8,
          action: "block",
        },
      ],
    })

    const again = BudgetRulesImportResponse.parse(
      await (
        await send("POST", "/rules/import", {
          rules: importable,
          mode: "replace",
          dryRun: false,
        })
      ).json(),
    )
    expect(again.limits).toEqual({
      added: [],
      changed: [],
      removed: [],
      unchanged: ["claude-daily"],
    })
    expect(again.display.changed).toBe(false)
  })

  test("what is exported imports back, merge or replace", async () => {
    await send("PUT", "/filters/claude", claude)
    await send("PUT", "/limits/claude-daily", rule)
    const exported = await (await send("GET", "/rules/export")).json()
    const before = structuredClone(getConfig().budget)
    for (const mode of ["merge", "replace"]) {
      const response = await send("POST", "/rules/import", {
        rules: exported,
        mode,
        dryRun: false,
      })
      expect(response.status).toBe(200)
      expect(getConfig().budget).toEqual(before)
    }
  })

  test("a merge keeps what is there; a replace removes it", async () => {
    await send("PUT", "/filters/claude", claude)
    await send("PUT", "/limits/mine", { ...rule, label: "Mine" })
    const rules = {
      version: 1,
      filters: [],
      limits: [
        {
          id: "theirs",
          scope: { kind: "global" },
          limit: AIU,
          limit_reset: { every: { hours: 5 } },
          warn_at: 0.8,
          action: "warn",
        },
      ],
    }
    await send("POST", "/rules/import", {
      rules,
      mode: "merge",
      dryRun: false,
    })
    expect(getConfig().budget?.limits?.map((limit) => limit.id)).toEqual([
      "mine",
      "theirs",
    ])
    expect(getConfig().budget?.filters).toHaveLength(1)

    await send("POST", "/rules/import", {
      rules,
      mode: "replace",
      dryRun: false,
    })
    expect(getConfig().budget?.limits?.map((limit) => limit.id)).toEqual([
      "theirs",
    ])
    expect(getConfig().budget?.filters).toEqual([])
  })

  test("collisions: rename adds a copy under a free id and reports it", async () => {
    await send("PUT", "/filters/claude", claude)
    await send("PUT", "/limits/claude-daily", rule)
    const rules = {
      ...importable,
      limits: [{ id: "claude-daily", ...rule, limit: 9 * AIU }],
    }
    const response = await send("POST", "/rules/import", {
      rules,
      mode: "merge",
      collisions: "rename",
      dryRun: false,
    })
    const body = BudgetRulesImportResponse.parse(await response.json())
    expect(body.renamed).toEqual([
      { kind: "limit", from: "claude-daily", to: "claude-daily-2" },
    ])
    expect(
      getConfig().budget?.limits?.map((limit) => [limit.id, limit.limit]),
    ).toEqual([
      ["claude-daily", 5 * AIU],
      ["claude-daily-2", 9 * AIU],
    ])
  })
})

describe("POST /rules/import validation", () => {
  test("a document that doesn't validate is a 400 listing every problem, and writes nothing", async () => {
    const cases: Array<[unknown, string, string]> = [
      [{ ...importable, version: 2 }, "version", "Unsupported rules version 2"],
      [
        {
          ...importable,
          limits: [
            { ...importable.limits[0], scope: { kind: "nope", id: "x" } },
          ],
        },
        "limits.0.scope",
        "",
      ],
      [
        { ...importable, filters: [] },
        "limits.0.scope.id",
        "uses filter 'claude', which isn't defined",
      ],
    ]
    for (const [rules, path, text] of cases) {
      const response = await send("POST", "/rules/import", {
        rules,
        mode: "replace",
        dryRun: false,
      })
      expect(response.status).toBe(400)
      const error = await errorOf(response)
      expect(error.type).toBe("validation_error")
      expect(error.message).toBe("The rules can't be imported: 1 problem")
      expect(error.details?.[0].path.startsWith(path)).toBe(true)
      expect(error.details?.[0].message).toContain(text)
    }
    expect(getConfig().budget?.limits ?? []).toEqual([])
  })

  test("several problems are counted", async () => {
    const response = await send("POST", "/rules/import", {
      rules: {
        version: 1,
        filters: [],
        limits: [
          { ...importable.limits[0], id: "a" },
          { ...importable.limits[0], id: "b" },
        ],
      },
      mode: "merge",
      dryRun: true,
    })
    const error = await errorOf(response)
    expect(error.message).toBe("The rules can't be imported: 2 problems")
    expect(error.details).toHaveLength(2)
  })

  test("the request itself must say rules, mode and dryRun", async () => {
    const message =
      "Give rules, mode (merge or replace) and dryRun (true or false)"
    for (const body of [
      { mode: "merge", dryRun: true, rules: importable, extra: 1 },
      { rules: importable, dryRun: true },
      { rules: importable, mode: "merge" },
      { rules: importable, mode: "append", dryRun: true },
      { rules: importable, mode: "merge", dryRun: "yes" },
      { rules: importable, mode: "merge", dryRun: true, collisions: "x" },
      "not an object",
    ]) {
      const response = await send("POST", "/rules/import", body)
      expect(response.status).toBe(400)
      expect((await errorOf(response)).message).toBe(message)
    }
    const unparsable = await app.request("/budget/rules/import", {
      method: "POST",
      body: "{",
    })
    expect(unparsable.status).toBe(400)
    // A missing document fails the envelope too.
    const missing = await send("POST", "/rules/import", {
      mode: "merge",
      dryRun: true,
    })
    expect(missing.status).toBe(400)
    expect((await errorOf(missing)).message).toBe(message)
  })

  test("applying pushes budget.changed; a dry run doesn't", async () => {
    const seen: Array<unknown> = []
    const stop = settingsEventBus.subscribe("budget.changed", (status) => {
      seen.push(status)
    })
    try {
      await send("POST", "/rules/import", {
        rules: importable,
        mode: "merge",
        dryRun: true,
      })
      await Bun.sleep(20)
      expect(seen).toHaveLength(0)
      await send("POST", "/rules/import", {
        rules: importable,
        mode: "merge",
        dryRun: false,
      })
      await Bun.sleep(20)
    } finally {
      stop()
    }
    expect(seen).toHaveLength(1)
  })

  test("a merge leaves the display alone", async () => {
    await send("POST", "/rules/import", {
      rules: importable,
      mode: "merge",
      dryRun: false,
    })
    expect(getConfig().budget?.display).toBeUndefined()
  })
})
