/**
 * Reusable filters: glob matching, scope resolution and matching on
 * subjects, the database's matching on real usage rows (it must agree with
 * the ledger's), and filter scopes in the service. Pinned by mutation
 * testing (`bun run mutate`).
 */

import {
  afterEach,
  beforeEach,
  describe,
  expect,
  setSystemTime,
  test,
} from "bun:test"

import type { BudgetFilterConfig } from "~/lib/budget/schema"

import { globMatches, globToSqlite } from "~/lib/budget/glob"
import { buildLimitTimeline } from "~/lib/budget/reports/timeline"
import { resolveScope, scopeMatches } from "~/lib/budget/scope"
import { createUsageDbBudgetStore } from "~/lib/budget/store"
import { requestContext } from "~/lib/http/request-context"
import { closeUsageStore, recordTokenUsageEvent } from "~/lib/token-usage"
import { getNanoAiuSpend, getNanoAiuSpendRows } from "~/lib/token-usage/spend"

import {
  AIU,
  NOON,
  event,
  harness,
  intent,
  limit,
} from "./helpers/budget-service-harness"

const modelsOf = (...members: Array<string>) =>
  ({ kind: "members", field: "model", members }) as const
const clientsOf = (...members: Array<string>) =>
  ({ kind: "members", field: "key", members }) as const
const pluginsOf = (...members: Array<string>) =>
  ({ kind: "members", field: "plugin", members }) as const

describe("glob matching", () => {
  test("a plain name matches only itself, whole", () => {
    expect(globMatches("gpt-5", "gpt-5")).toBe(true)
    expect(globMatches("gpt-5", "gpt-5.1")).toBe(false)
    expect(globMatches("gpt-5", "xgpt-5")).toBe(false)
    expect(globMatches("gpt-5", "GPT-5")).toBe(false)
    expect(globMatches("", "")).toBe(true)
    expect(globMatches("", "x")).toBe(false)
  })

  test("* matches any run, empty included, anywhere in the pattern", () => {
    expect(globMatches("claude-*", "claude-sonnet-4")).toBe(true)
    expect(globMatches("claude-*", "claude-")).toBe(true)
    expect(globMatches("claude-*", "claude")).toBe(false)
    expect(globMatches("claude-*", "my-claude-x")).toBe(false)
    expect(globMatches("*-mini", "gpt-5-mini")).toBe(true)
    expect(globMatches("*-mini", "gpt-5-mini-high")).toBe(false)
    expect(globMatches("*", "anything")).toBe(true)
    expect(globMatches("*", "")).toBe(true)
    expect(globMatches("a*b*c", "a-x-b-y-c")).toBe(true)
    expect(globMatches("a*b*c", "a-x-c")).toBe(false)
  })

  test("? matches exactly one character", () => {
    expect(globMatches("gpt-?", "gpt-5")).toBe(true)
    expect(globMatches("gpt-?", "gpt-")).toBe(false)
    expect(globMatches("gpt-?", "gpt-55")).toBe(false)
    expect(globMatches("a?c", "aéc")).toBe(true)
    expect(globMatches("a?c", "a\u{1F600}c")).toBe(true)
  })

  test("everything else is literal", () => {
    expect(globMatches("gpt-4.1", "gpt-4.1")).toBe(true)
    expect(globMatches("gpt-4.1", "gpt-4x1")).toBe(false)
    for (const special of [
      "a+b",
      "a(b)",
      "a[b]",
      "a{1}",
      "a|b",
      "a^b",
      "a$b",
      String.raw`a\b`,
    ]) {
      expect(globMatches(special, special)).toBe(true)
    }
    expect(globMatches("a+", "aa")).toBe(false)
    expect(globMatches("a[bc]", "ab")).toBe(false)
    expect(globMatches("(a|b)", "a")).toBe(false)
  })

  test("a newline is just a character", () => {
    expect(globMatches("a*", "a\nb")).toBe(true)
    expect(globMatches("a?b", "a\nb")).toBe(true)
  })

  test("the SQLite form escapes only [", () => {
    expect(globToSqlite("a[b]*?")).toBe("a[[]b]*?")
    expect(globToSqlite("claude-*")).toBe("claude-*")
  })
})

describe("resolving a filter scope", () => {
  const filters: Array<BudgetFilterConfig> = [
    { id: "claude", name: "Claude", kind: "models", members: ["claude-*"] },
    { id: "agents", name: "Agents", kind: "clients", members: ["codex", "ci"] },
    { id: "media", name: "Media", kind: "plugins", members: ["images"] },
  ]

  test("looks the filter up and selects its field by kind", () => {
    expect(resolveScope({ kind: "filter", id: "claude" }, filters)).toEqual({
      kind: "members",
      field: "model",
      members: ["claude-*"],
    })
    expect(resolveScope({ kind: "filter", id: "agents" }, filters)).toEqual({
      kind: "members",
      field: "key",
      members: ["codex", "ci"],
    })
    expect(resolveScope({ kind: "filter", id: "media" }, filters)).toEqual({
      kind: "members",
      field: "plugin",
      members: ["images"],
    })
  })

  test("other scopes pass through", () => {
    for (const scope of [
      { kind: "global" },
      { kind: "key", id: "a" },
      { kind: "plugin", id: "b" },
      { kind: "provider", id: "c" },
    ] as const) {
      expect(resolveScope(scope, filters)).toBe(scope)
    }
  })

  test("a filter that no longer exists selects nothing", () => {
    for (const list of [filters, undefined, []]) {
      const scope = resolveScope({ kind: "filter", id: "gone" }, list)
      expect(scope).toEqual({ kind: "members", field: "model", members: [] })
      expect(scopeMatches(scope, { key: "x", model: "anything" })).toBe(false)
    }
  })
})

describe("matching a subject", () => {
  test("a model filter matches the subject's model by any member", () => {
    const scope = modelsOf("claude-*", "gpt-5")
    expect(scopeMatches(scope, { key: "k", model: "claude-opus-4" })).toBe(true)
    expect(scopeMatches(scope, { key: "k", model: "gpt-5" })).toBe(true)
    expect(scopeMatches(scope, { key: "k", model: "gpt-5-mini" })).toBe(false)
    expect(scopeMatches(scope, { key: "k" })).toBe(false)
  })

  test("a client filter matches the key, a plugin filter the plugin", () => {
    const clients = {
      kind: "members",
      field: "key",
      members: ["codex", "ci-*"],
    } as const
    expect(scopeMatches(clients, { key: "codex", model: "claude-x" })).toBe(
      true,
    )
    expect(scopeMatches(clients, { key: "ci-7" })).toBe(true)
    expect(scopeMatches(clients, { key: "laptop", plugin: "codex" })).toBe(
      false,
    )

    const plugins = {
      kind: "members",
      field: "plugin",
      members: ["images"],
    } as const
    expect(scopeMatches(plugins, { key: "k", plugin: "images" })).toBe(true)
    expect(scopeMatches(plugins, { key: "images" })).toBe(false)
  })

  test("a subject without the attribute matches no pattern, not even *", () => {
    expect(scopeMatches(modelsOf("*"), { key: "k" })).toBe(false)
    expect(scopeMatches(modelsOf("undef*", "undefined"), { key: "k" })).toBe(
      false,
    )
    expect(
      scopeMatches(
        { kind: "members", field: "plugin", members: ["*"] },
        { key: "k", model: "m" },
      ),
    ).toBe(false)
    expect(scopeMatches(modelsOf("*"), { key: "k", model: "" })).toBe(true)
  })

  test("no members select nothing", () => {
    expect(scopeMatches(modelsOf(), { key: "k", model: "x" })).toBe(false)
  })

  test("the existing scopes still match as before", () => {
    const subject = { key: "k", plugin: "p", provider: "v", model: "m" }
    expect(scopeMatches({ kind: "global" }, subject)).toBe(true)
    expect(scopeMatches({ kind: "key", id: "k" }, subject)).toBe(true)
    expect(scopeMatches({ kind: "key", id: "p" }, subject)).toBe(false)
    expect(scopeMatches({ kind: "plugin", id: "p" }, subject)).toBe(true)
    expect(scopeMatches({ kind: "plugin", id: "v" }, subject)).toBe(false)
    expect(scopeMatches({ kind: "provider", id: "v" }, subject)).toBe(true)
    expect(scopeMatches({ kind: "provider", id: "m" }, subject)).toBe(false)
  })
})

const DB_PATH_ENV = "COPILOT_API_SQLITE_DB_PATH"

interface Row {
  model: string
  nanoAiu: number
  label?: string
  endpoint?: "images" | "messages"
  at?: number
}

function record(row: Row): void {
  const at = row.at ?? NOON - 1_000
  setSystemTime(new Date(at))
  requestContext.run(
    {
      parentSessionId: undefined,
      sessionAffinity: undefined,
      startTime: at,
      traceId: `trace-${at}-${row.model}`,
      usage: { apiKeyLabel: row.label },
      userAgent: "test",
    },
    () => {
      recordTokenUsageEvent({
        endpoint: row.endpoint ?? "messages",
        model: row.model,
        source: "copilot",
        input_tokens: 1,
        total_nano_aiu: row.nanoAiu,
      })
    },
  )
  setSystemTime()
}

const everything = { startMs: 0, endMs: null }

async function sum(
  scope: Parameters<typeof getNanoAiuSpend>[0],
): Promise<number> {
  const [total] = await getNanoAiuSpend(scope, [everything])
  return total
}

function seed(): void {
  record({ model: "claude-sonnet-4", nanoAiu: 1, label: "codex" })
  record({ model: "claude-opus-4", nanoAiu: 2, label: "ci-1" })
  record({ model: "gpt-5", nanoAiu: 4, label: "codex" })
  record({ model: "gpt-5-mini", nanoAiu: 8 })
  record({ model: "gpt-image-2", nanoAiu: 16, endpoint: "images" })
  record({ model: "Claude-Upper", nanoAiu: 32 })
  record({ model: "a[b]", nanoAiu: 64 })
}

describe("filters over the usage database", () => {
  beforeEach(async () => {
    process.env[DB_PATH_ENV] = ":memory:"
    await closeUsageStore()
  })

  afterEach(async () => {
    setSystemTime()
    await closeUsageStore()
    Reflect.deleteProperty(process.env, DB_PATH_ENV)
  })

  test("model members match as globs, case-sensitively", async () => {
    seed()
    expect(await sum(modelsOf("claude-*"))).toBe(3)
    expect(await sum(modelsOf("gpt-5"))).toBe(4)
    expect(await sum(modelsOf("gpt-5", "claude-opus-4"))).toBe(6)
    expect(await sum(modelsOf("gpt-?"))).toBe(4)
    expect(await sum(modelsOf("*"))).toBe(127)
    expect(await sum(modelsOf("nope-*"))).toBe(0)
    // A bracket is a literal character, here and in the ledger.
    expect(await sum(modelsOf("a[b]"))).toBe(64)
    expect(await sum(modelsOf("a[b]*"))).toBe(64)
    expect(await sum(modelsOf("[ab]"))).toBe(0)
  })

  test("client members match the key, a label or the recognised client", async () => {
    seed()
    expect(await sum(clientsOf("codex"))).toBe(5)
    expect(await sum(clientsOf("ci-*"))).toBe(2)
    expect(await sum(clientsOf("codex", "ci-*"))).toBe(7)
    expect(await sum(clientsOf("unidentified"))).toBe(8 + 16 + 32 + 64)
  })

  test("plugin members match the plugin id", async () => {
    seed()
    expect(await sum(pluginsOf("images"))).toBe(16)
    expect(await sum(pluginsOf("images", "decisions"))).toBe(16)
    expect(await sum(pluginsOf("*"))).toBe(16)
  })

  test("a filter with no members selects nothing", async () => {
    seed()
    expect(await sum({ kind: "members", field: "model", members: [] })).toBe(0)
    expect(
      await getNanoAiuSpendRows(
        { kind: "members", field: "model", members: [] },
        everything,
      ),
    ).toEqual([])
  })

  test("the database and the ledger agree on every pattern", async () => {
    seed()
    const models = [
      "claude-sonnet-4",
      "claude-opus-4",
      "gpt-5",
      "gpt-5-mini",
      "gpt-image-2",
      "Claude-Upper",
      "a[b]",
    ]
    const patterns = [
      "claude-*",
      "*-4",
      "gpt-?",
      "gpt-*-?",
      "*",
      "a[b]",
      "?[b]",
      "*[*",
      "[ab]",
      "G*",
      "gpt-5*",
      "*i*",
    ]
    for (const pattern of patterns) {
      const expected = models
        .filter((model) => globMatches(pattern, model))
        .reduce(
          (total, model) =>
            total + [1, 2, 4, 8, 16, 32, 64][models.indexOf(model)],
          0,
        )
      expect(
        await sum({ kind: "members", field: "model", members: [pattern] }),
      ).toBe(expected)
    }
  })

  test("spend rows and orphaned holds follow the filter", async () => {
    seed()
    const store = createUsageDbBudgetStore()
    store.openHold({
      id: "crashed",
      createdAtMs: NOON - 500,
      operation: "messages",
      key: "codex",
      provider: "copilot",
      model: "claude-haiku-4",
      estimateNanoAiu: 100,
      estimateInputTokens: 0,
      estimateOutputTokens: 0,
    })
    store.openHold({
      id: "other",
      createdAtMs: NOON - 400,
      operation: "messages",
      key: "laptop",
      provider: "copilot",
      model: "gpt-5",
      estimateNanoAiu: 200,
      estimateInputTokens: 0,
      estimateOutputTokens: 0,
    })
    await store.recover(NOON)

    const claude = {
      kind: "members",
      field: "model",
      members: ["claude-*"],
    } as const
    expect(await sum(claude)).toBe(103)
    expect(
      (await store.spendRows(claude, everything, "nano_aiu")).map(
        (row) => row.nanoAiu,
      ),
    ).toEqual([1, 2, 100])
    const codex = { kind: "members", field: "key", members: ["codex"] } as const
    expect(await sum(codex)).toBe(105)
    expect(
      await sum({ kind: "members", field: "model", members: ["gpt-5"] }),
    ).toBe(204)
  })
})

describe("a filter rule's timeline", () => {
  beforeEach(async () => {
    process.env[DB_PATH_ENV] = ":memory:"
    await closeUsageStore()
  })

  afterEach(async () => {
    setSystemTime()
    await closeUsageStore()
    Reflect.deleteProperty(process.env, DB_PATH_ENV)
  })

  test("counts only the rows its filter selects", async () => {
    seed()
    const config = {
      filters: [
        {
          id: "claude",
          name: "Claude",
          kind: "models" as const,
          members: ["claude-*"],
        },
      ],
      limits: [
        limit({
          id: "claude-cap",
          scope: { kind: "filter", id: "claude" },
          limitReset: "never",
        }),
      ],
    }
    const timeline = await buildLimitTimeline({
      limit: config.limits[0],
      config,
      range: { fromMs: NOON - 3_600_000, toMs: NOON + 1, label: "custom" },
      bucket: "hour",
      nowMs: NOON,
      findWindow: () => undefined,
    })
    // claude-sonnet-4 (1) and claude-opus-4 (2), not the gpt rows.
    expect(timeline.totals.nano_aiu).toBe(3)
    expect(timeline.totals.requests).toBe(2)
  })
})

describe("a filter scope in the service", () => {
  const filters: Array<BudgetFilterConfig> = [
    { id: "claude", name: "Claude", kind: "models", members: ["claude-*"] },
    {
      id: "agents",
      name: "Agents",
      kind: "clients",
      members: ["codex", "ci-*"],
    },
  ]
  const claude = limit({
    id: "claude-cap",
    scope: { kind: "filter", id: "claude" },
  })

  test("counts and refuses only what the filter selects", async () => {
    const h = harness([claude], { filters })
    h.emit(event({ model: "claude-opus-4", nanoAiu: AIU }))
    h.emit(event({ model: "gpt-5", nanoAiu: 5 * AIU }))

    const refused = await h.service.check(intent({ model: "claude-sonnet-4" }))
    expect(refused.ok).toBe(false)
    if (!refused.ok) {
      expect(refused.refusal.limitId).toBe("claude-cap")
      expect(refused.refusal.scope).toEqual({ kind: "filter", id: "claude" })
    }
    expect((await h.service.check(intent({ model: "gpt-5" }))).ok).toBe(true)
    // A call that names no model isn't one a model filter selects.
    expect((await h.service.check(intent())).ok).toBe(true)
  })

  test("a live row of an unselected model adds nothing", async () => {
    const h = harness([claude], { filters })
    await h.service.check(intent({ model: "claude-x" }))
    h.emit(event({ model: "gpt-5", nanoAiu: 2 * AIU }))
    expect((await h.service.check(intent({ model: "claude-x" }))).ok).toBe(true)
    h.emit(event({ model: "claude-haiku", nanoAiu: AIU }))
    expect((await h.service.check(intent({ model: "claude-x" }))).ok).toBe(
      false,
    )
  })

  test("a client filter selects by key", async () => {
    const h = harness(
      [limit({ id: "agents", scope: { kind: "filter", id: "agents" } })],
      { filters },
    )
    h.emit(event({ key: "ci-9", nanoAiu: AIU }))
    expect((await h.service.check(intent({ key: "ci-9" }))).ok).toBe(false)
    expect((await h.service.check(intent({ key: "codex" }))).ok).toBe(false)
    expect((await h.service.check(intent({ key: "laptop" }))).ok).toBe(true)
  })

  test("holds count against the filter by the model they name", async () => {
    const h = harness([claude], { filters })
    const held = await h.service.reserve(
      intent({ model: "claude-opus-4", estimateNanoAiu: AIU }),
    )
    expect(held.ok).toBe(true)
    expect(h.service.heldNanoAiu({ kind: "filter", id: "claude" })).toBe(AIU)
    expect(h.service.heldNanoAiu({ kind: "filter", id: "agents" })).toBe(0)
    expect(h.service.heldNanoAiu({ kind: "filter", id: "gone" })).toBe(0)

    const other = await h.service.reserve(
      intent({ model: "gpt-5", estimateNanoAiu: AIU }),
    )
    expect(other.ok).toBe(true)
    const second = await h.service.reserve(
      intent({ model: "claude-sonnet-4", estimateNanoAiu: 1 }),
    )
    expect(second.ok).toBe(false)
    expect(h.calls.opened[0]).toMatchObject({ model: "claude-opus-4" })
  })

  test("editing the filter's members reloads the ledger", async () => {
    const h = harness([claude], { filters })
    await h.service.check(intent({ model: "claude-x" }))
    expect(h.calls.spend).toHaveLength(1)
    await h.service.check(intent({ model: "claude-x" }))
    expect(h.calls.spend).toHaveLength(1)

    h.setConfig({
      limits: [claude],
      filters: [{ ...filters[0], members: ["claude-*", "gpt-5"] }],
    })
    await h.service.check(intent({ model: "gpt-5" }))
    expect(h.calls.spend).toHaveLength(2)
  })

  test("a limit on a filter that was deleted is inert, not global", async () => {
    const h = harness([claude], { filters: [] })
    h.emit(event({ model: "claude-opus-4", nanoAiu: 100 * AIU }))
    expect((await h.service.check(intent({ model: "claude-opus-4" }))).ok).toBe(
      true,
    )
  })

  test("a filter limit sorts between plugin and key scopes", async () => {
    const h = harness(
      [
        limit({
          id: "by-key",
          scope: { kind: "key", id: "claude-code" },
          limit: 1,
        }),
        limit({
          id: "by-filter",
          scope: { kind: "filter", id: "claude" },
          limit: 1,
        }),
        limit({
          id: "by-plugin",
          scope: { kind: "plugin", id: "images" },
          limit: 1,
        }),
      ],
      { filters },
    )
    h.emit(event({ model: "claude-x", nanoAiu: 5, plugin: "images" }))
    const refused = await h.service.check(
      intent({ model: "claude-x", plugin: "images" }),
    )
    expect(refused.ok).toBe(false)
    if (!refused.ok) expect(refused.refusal.limitId).toBe("by-plugin")
  })
})
