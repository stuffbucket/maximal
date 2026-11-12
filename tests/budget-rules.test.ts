/**
 * Rules export and import: the document, strict validation, merge against
 * replace, id collisions and the diff a dry run reports. Pure; the route
 * tests are in `budget-rules-route.test.ts`.
 */

import { describe, expect, test } from "bun:test"

import type { BudgetRulesDocument } from "~/lib/config/settings-types"

import {
  exportRules,
  filterToWire,
  limitToWire,
  planImport,
  type ImportPlan,
} from "~/lib/budget/rules"
import {
  BudgetConfigSchema,
  type BudgetConfig,
  type BudgetFilterConfig,
  type BudgetLimitConfig,
} from "~/lib/budget/schema"

const AIU = 1_000_000_000
const NOTIFY = { warn: "notification", limit: "both" } as const

const claudeFilter: BudgetFilterConfig = {
  id: "claude",
  name: "Claude models",
  kind: "models",
  members: ["claude-*"],
}

const limits: Array<BudgetLimitConfig> = [
  {
    id: "claude-daily",
    label: "Claude",
    scope: { kind: "filter", id: "claude" },
    limit: 5 * AIU,
    limitReset: "daily",
    warnAt: 0.5,
    action: "block",
    extra: "kept",
  },
  {
    id: "all-weekly",
    scope: { kind: "global" },
    limit: 50 * AIU,
    limitReset: { every: { hours: 5 } },
    action: "warn",
  },
]

const current: BudgetConfig = {
  enabled: true,
  display: { unit: "credits", creditUsd: 0.02 },
  filters: [claudeFilter],
  limits,
}

function doc(
  overrides: Partial<BudgetRulesDocument> = {},
): BudgetRulesDocument {
  return { version: 1, filters: [], limits: [], ...overrides }
}

function plan(
  rules: unknown,
  mode: "merge" | "replace" = "merge",
  options: {
    collisions?: "replace" | "rename"
    budget?: BudgetConfig
  } = {},
): ImportPlan {
  return planImport(options.budget ?? current, {
    rules,
    mode,
    ...(options.collisions === undefined ?
      {}
    : { collisions: options.collisions }),
  })
}

function ok(result: ImportPlan) {
  if (!result.ok) throw new Error(JSON.stringify(result.problems))
  return result
}

function problems(result: ImportPlan) {
  if (result.ok) throw new Error("expected problems")
  return result.problems
}

describe("export", () => {
  test("is version 1 with filters, limits and the display, in API field names", () => {
    expect(exportRules(current)).toEqual({
      version: 1,
      filters: [claudeFilter],
      limits: [
        {
          id: "claude-daily",
          label: "Claude",
          scope: { kind: "filter", id: "claude" },
          limit: 5 * AIU,
          limit_reset: "daily",
          warn_at: 0.5,
          action: "block",
          notify: NOTIFY,
        },
        {
          id: "all-weekly",
          scope: { kind: "global" },
          limit: 50 * AIU,
          limit_reset: { every: { hours: 5 } },
          warn_at: 0.8,
          action: "warn",
          notify: NOTIFY,
        },
      ],
      display: { unit: "credits", credit_usd: 0.02 },
    })
  })

  test("with nothing configured: empty lists and the default display", () => {
    expect(exportRules(undefined)).toEqual({
      version: 1,
      filters: [],
      limits: [],
      display: { unit: "usd", credit_usd: 0.01 },
    })
  })

  test("an exported document imports to no change", () => {
    const result = ok(plan(exportRules(current), "replace"))
    expect(result.diff.limits).toEqual({
      added: [],
      changed: [],
      removed: [],
      unchanged: ["claude-daily", "all-weekly"],
    })
    expect(result.diff.filters.unchanged).toEqual(["claude"])
    expect(result.diff.display.changed).toBe(false)
    // The stored entries, extra fields included, are kept as they were.
    expect(result.next.limits).toEqual(limits)
    expect(result.next.filters).toEqual([claudeFilter])
    expect(result.next.display).toBeUndefined()
  })

  test("wire conversions normalise the default warning threshold", () => {
    expect(
      limitToWire({
        id: "a",
        scope: { kind: "global" },
        limit: 1,
        limitReset: "never",
        action: "block",
      }).warn_at,
    ).toBe(0.8)
    expect(filterToWire({ ...claudeFilter, extra: 1 })).toEqual(claudeFilter)
  })
})

describe("validation", () => {
  test("only a JSON object is a document", () => {
    for (const rules of [null, undefined, "x", 3, [], true]) {
      expect(problems(plan(rules))).toEqual([
        { path: "", message: "The rules must be a JSON object" },
      ])
    }
  })

  test("an unknown or missing version says which this Maximal reads", () => {
    expect(problems(plan({ ...doc(), version: 2 }))).toEqual([
      {
        path: "version",
        message: "Unsupported rules version 2; this Maximal reads version 1",
      },
    ])
    expect(problems(plan({ filters: [], limits: [] }))[0].message).toBe(
      "Unsupported rules version (missing); this Maximal reads version 1",
    )
    expect(problems(plan({ ...doc(), version: "1" }))[0].message).toContain(
      'version "1"',
    )
  })

  test("an unknown scope kind is refused with its path", () => {
    const result = problems(
      plan(
        doc({
          limits: [
            {
              id: "a",
              scope: { kind: "everything" } as never,
              limit: 1,
              limit_reset: "daily",
              warn_at: 0.8,
              action: "block",
            },
          ],
        }),
      ),
    )
    expect(result).toHaveLength(1)
    expect(result[0].path).toBe("limits.0.scope.kind")
  })

  test("is strict: unknown fields, bad amounts, bad ids and bad resets", () => {
    const base = {
      id: "a",
      scope: { kind: "global" },
      limit: 1,
      limit_reset: "daily",
      warn_at: 0.8,
      action: "block",
    }
    const bad: Array<[string, Record<string, unknown>]> = [
      ["limits.0", { ...base, surprise: 1 }],
      ["limits.0.limit", { ...base, limit: 1.5 }],
      ["limits.0.limit", { ...base, limit: -1 }],
      ["limits.0.id", { ...base, id: "Bad Id" }],
      ["limits.0.action", { ...base, action: "pause" }],
      ["limits.0.warn_at", { ...base, warn_at: 2 }],
      [
        "limits.0.limit_reset",
        { ...base, limit_reset: { every: { hours: 0 } } },
      ],
      ["limits.0.warn_at", { ...base, warn_at: undefined }],
    ]
    for (const [path, limit] of bad) {
      const result = problems(
        plan({ version: 1, filters: [], limits: [limit] }),
      )
      expect(result.some((problem) => problem.path.startsWith(path))).toBe(true)
    }
    expect(
      problems(plan({ version: 1, filters: [], limits: [], extra: 1 }))[0]
        .message,
    ).toContain("Unrecognized key")
    expect(
      problems(
        plan({
          version: 1,
          filters: [],
          limits: [],
          display: { unit: "eur", credit_usd: 1 },
        }),
      )[0].path,
    ).toBe("display.unit")
  })

  test("filters: a kind, at least one member, an id", () => {
    const filter = { id: "f", name: "F", kind: "models", members: ["a"] }
    const cases: Array<[string, Record<string, unknown>]> = [
      ["filters.0.kind", { ...filter, kind: "tools" }],
      ["filters.0.members", { ...filter, members: [] }],
      ["filters.0.id", { ...filter, id: "Not Valid" }],
      ["filters.0.name", { ...filter, name: " " }],
      ["filters.0.members.0", { ...filter, members: [""] }],
    ]
    for (const [path, bad] of cases) {
      const result = problems(plan({ version: 1, filters: [bad], limits: [] }))
      expect(result.map((problem) => problem.path)).toContain(path)
    }
  })

  test("the same id twice in the document", () => {
    const filter = {
      id: "f",
      name: "F",
      kind: "models" as const,
      members: ["a"],
    }
    const limit = {
      id: "l",
      scope: { kind: "global" as const },
      limit: 1,
      limit_reset: "daily" as const,
      warn_at: 0.8,
      action: "block" as const,
    }
    expect(
      problems(
        plan(doc({ filters: [filter, filter], limits: [limit, limit] })),
      ),
    ).toEqual([
      { path: "filters.1.id", message: "Duplicate filter id 'f'" },
      { path: "limits.1.id", message: "Duplicate rule id 'l'" },
    ])
  })

  test("a rule on a filter that isn't defined", () => {
    const dangling = {
      id: "orphan",
      scope: { kind: "filter" as const, id: "missing" },
      limit: 1,
      limit_reset: "daily" as const,
      warn_at: 0.8,
      action: "block" as const,
    }
    const expected = [
      {
        path: "limits.2.scope.id",
        message: "Rule 'orphan' uses filter 'missing', which isn't defined",
      },
    ]
    expect(problems(plan(doc({ limits: [dangling] })))).toEqual(expected)
    expect(problems(plan(doc({ limits: [dangling] }), "replace"))).toEqual([
      { ...expected[0], path: "limits.0.scope.id" },
    ])
  })

  test("a replace that drops a filter a kept rule needs is refused", () => {
    // `claude-daily` isn't in the document, so it goes; but one that stays
    // and points at a filter the document drops is dangling.
    const stays = limitToWire(limits[0])
    const result = problems(plan(doc({ limits: [stays] }), "replace"))
    expect(result[0].message).toBe(
      "Rule 'claude-daily' uses filter 'claude', which isn't defined",
    )
  })

  test("a merge may use a filter that is already there", () => {
    const rule = {
      id: "new",
      scope: { kind: "filter" as const, id: "claude" },
      limit: 1,
      limit_reset: "weekly" as const,
      warn_at: 0.8,
      action: "block" as const,
    }
    expect(ok(plan(doc({ limits: [rule] }))).diff.limits.added).toEqual([
      { ...rule, notify: NOTIFY },
    ])
  })

  test("more rules or filters than the config holds", () => {
    const limits = Array.from({ length: 257 }, (_, index) => ({
      id: `l-${index}`,
      scope: { kind: "global" as const },
      limit: 1,
      limit_reset: "daily" as const,
      warn_at: 0.8,
      action: "block" as const,
    }))
    // The schema itself caps a document at 256.
    expect(problems(plan(doc({ limits })))[0].path).toBe("limits")

    const filters = Array.from({ length: 128 }, (_, index) => ({
      id: `f-${index}`,
      name: "F",
      kind: "models" as const,
      members: ["a"],
    }))
    expect(ok(plan(doc({ filters }), "replace")).next.filters).toHaveLength(128)
    // 128 imported plus the one already there.
    expect(problems(plan(doc({ filters }), "merge"))).toEqual([
      { path: "filters", message: "That would be more than 128 filters" },
    ])
    const full = Array.from({ length: 256 }, (_, index) => ({
      id: `m-${index}`,
      scope: { kind: "global" as const },
      limit: 1,
      limit_reset: "daily" as const,
      warn_at: 0.8,
      action: "block" as const,
    }))
    expect(problems(plan(doc({ limits: full }), "merge"))).toEqual([
      { path: "limits", message: "That would be more than 256 rules" },
    ])
    expect(ok(plan(doc({ limits: full }), "replace")).next.limits).toHaveLength(
      256,
    )
  })
})

describe("merge", () => {
  const added = {
    id: "images-daily",
    scope: { kind: "plugin" as const, id: "images" },
    limit: AIU,
    limit_reset: { monthly: { day: 1 } } as const,
    warn_at: 0.9,
    action: "warn" as const,
  }

  test("adds what is new after what is there, and removes nothing", () => {
    const result = ok(plan(doc({ limits: [added] })))
    expect(result.diff.limits).toEqual({
      added: [{ ...added, notify: NOTIFY }],
      changed: [],
      removed: [],
      unchanged: [],
    })
    expect(result.next.limits.map((limit) => limit.id)).toEqual([
      "claude-daily",
      "all-weekly",
      "images-daily",
    ])
    expect(result.next.limits[2]).toEqual({
      id: "images-daily",
      scope: { kind: "plugin", id: "images" },
      limit: AIU,
      limitReset: { monthly: { day: 1 } },
      warnAt: 0.9,
      action: "warn",
    })
    expect(result.next.filters).toEqual([claudeFilter])
  })

  test("an identical item is unchanged; a different one with the same id is replaced in place", () => {
    const same = limitToWire(limits[1])
    const different = {
      ...limitToWire(limits[0]),
      limit: 9 * AIU,
    }
    const result = ok(plan(doc({ limits: [same, different] })))
    expect(result.diff.limits.unchanged).toEqual(["all-weekly"])
    expect(result.diff.limits.changed).toEqual([
      { before: limitToWire(limits[0]), after: different },
    ])
    expect(result.diff.limits.added).toEqual([])
    expect(result.next.limits.map((limit) => [limit.id, limit.limit])).toEqual([
      ["claude-daily", 9 * AIU],
      ["all-weekly", 50 * AIU],
    ])
    // The replaced entry is the import's, so a field it lacks is gone.
    expect(result.next.limits[0]).not.toHaveProperty("extra")
    // The one that didn't change is the stored entry itself.
    expect(result.next.limits[1]).toBe(limits[1])
  })

  test("with collisions: rename, a different item is added under a free id", () => {
    const different = {
      ...limitToWire(limits[0]),
      limit: 9 * AIU,
    }
    const result = ok(
      plan(doc({ limits: [different] }), "merge", { collisions: "rename" }),
    )
    expect(result.diff.limits.changed).toEqual([])
    expect(result.diff.limits.added).toEqual([
      { ...different, id: "claude-daily-2" },
    ])
    expect(result.diff.renamed).toEqual([
      { kind: "limit", from: "claude-daily", to: "claude-daily-2" },
    ])
    expect(result.next.limits.map((limit) => limit.id)).toEqual([
      "claude-daily",
      "all-weekly",
      "claude-daily-2",
    ])
    expect(result.next.limits[0]).toBe(limits[0])
  })

  test("rename skips ids that are taken, here or in the document", () => {
    const base = limitToWire(limits[0])
    const budget: BudgetConfig = {
      ...current,
      limits: [
        ...(current.limits ?? []),
        { ...limits[1], id: "claude-daily-2" },
      ],
    }
    const result = ok(
      plan(
        doc({
          limits: [
            { ...base, limit: 1 },
            { ...base, id: "claude-daily-3", limit: 3 },
          ],
        }),
        "merge",
        { collisions: "rename", budget },
      ),
    )
    expect(result.diff.renamed).toEqual([
      { kind: "limit", from: "claude-daily", to: "claude-daily-4" },
    ])
  })

  test("a renamed filter takes the imported rules scoped to it", () => {
    const filter = { ...claudeFilter, members: ["claude-opus-*"] }
    const rule = {
      id: "opus-cap",
      scope: { kind: "filter" as const, id: "claude" },
      limit: AIU,
      limit_reset: "daily" as const,
      warn_at: 0.8,
      action: "block" as const,
    }
    const result = ok(
      plan(doc({ filters: [filter], limits: [rule] }), "merge", {
        collisions: "rename",
      }),
    )
    expect(result.diff.renamed).toEqual([
      { kind: "filter", from: "claude", to: "claude-2" },
    ])
    expect(result.diff.filters.added).toEqual([{ ...filter, id: "claude-2" }])
    expect(result.diff.limits.added[0].scope).toEqual({
      kind: "filter",
      id: "claude-2",
    })
    // The rule already there still uses the original filter.
    expect(result.next.limits[0].scope).toEqual({
      kind: "filter",
      id: "claude",
    })
    expect(result.next.filters.map((entry) => entry.id)).toEqual([
      "claude",
      "claude-2",
    ])
  })

  test("with collisions: replace (the default) a different filter is changed", () => {
    const filter = {
      ...claudeFilter,
      name: "Renamed",
      members: ["claude-*", "o1"],
    }
    const result = ok(plan(doc({ filters: [filter] })))
    expect(result.diff.filters.changed).toEqual([
      { before: claudeFilter, after: filter },
    ])
    expect(result.next.filters).toEqual([filter])
    expect(result.diff.renamed).toEqual([])
  })

  test("never takes the document's display", () => {
    const result = ok(
      plan(doc({ display: { unit: "usd", credit_usd: 0.5 } }), "merge"),
    )
    expect(result.diff.display).toEqual({
      changed: false,
      before: { unit: "credits", credit_usd: 0.02 },
      after: { unit: "credits", credit_usd: 0.02 },
    })
    expect(result.next.display).toBeUndefined()
  })

  test("into an empty config", () => {
    const result = ok(
      planImport(undefined, {
        rules: doc({ filters: [claudeFilter], limits: [added] }),
        mode: "merge",
      }),
    )
    expect(result.next.filters).toEqual([claudeFilter])
    expect(result.next.limits).toHaveLength(1)
    expect(result.diff.display.before).toEqual({
      unit: "usd",
      credit_usd: 0.01,
    })
  })
})

describe("replace", () => {
  const kept = limitToWire(limits[1])
  const fresh = {
    id: "fresh",
    scope: { kind: "global" as const },
    limit: 2 * AIU,
    limit_reset: "weekly" as const,
    warn_at: 0.8,
    action: "block" as const,
  }

  test("makes the config the document: removes what it lacks", () => {
    const result = ok(plan(doc({ limits: [fresh, kept] }), "replace"))
    expect(result.diff.limits).toEqual({
      added: [{ ...fresh, notify: NOTIFY }],
      changed: [],
      removed: [limitToWire(limits[0])],
      unchanged: ["all-weekly"],
    })
    expect(result.diff.filters.removed).toEqual([claudeFilter])
    expect(result.next.limits.map((limit) => limit.id)).toEqual([
      "fresh",
      "all-weekly",
    ])
    expect(result.next.filters).toEqual([])
  })

  test("a changed item is reported before and after", () => {
    const changed = { ...kept, limit: 7 * AIU }
    const result = ok(plan(doc({ limits: [changed] }), "replace"))
    expect(result.diff.limits.changed).toEqual([
      { before: kept, after: changed },
    ])
    expect(result.diff.limits.removed).toHaveLength(1)
  })

  test("takes the document's display, and says when it differs", () => {
    const result = ok(
      plan(doc({ display: { unit: "usd", credit_usd: 0.05 } }), "replace"),
    )
    expect(result.diff.display).toEqual({
      changed: true,
      before: { unit: "credits", credit_usd: 0.02 },
      after: { unit: "usd", credit_usd: 0.05 },
    })
    expect(result.next.display).toEqual({ unit: "usd", creditUsd: 0.05 })
  })

  test("a document with no display leaves it alone", () => {
    const result = ok(plan(doc(), "replace"))
    expect(result.diff.display.changed).toBe(false)
    expect(result.next.display).toBeUndefined()
  })

  test("the same display is no change", () => {
    const result = ok(
      plan(doc({ display: { unit: "credits", credit_usd: 0.02 } }), "replace"),
    )
    expect(result.diff.display.changed).toBe(false)
  })

  test("collisions don't rename in a replace", () => {
    const changed = { ...kept, limit: 7 * AIU }
    const result = ok(
      plan(doc({ limits: [changed] }), "replace", { collisions: "rename" }),
    )
    expect(result.diff.renamed).toEqual([])
    expect(result.next.limits[0].id).toBe("all-weekly")
  })
})

describe("the config schema", () => {
  const filter = { id: "f", name: "F", kind: "models", members: ["a"] }

  test("accepts filters and a limit scoped to one", () => {
    const parsed = BudgetConfigSchema.safeParse({
      filters: [filter],
      limits: [
        {
          id: "l",
          scope: { kind: "filter", id: "f" },
          limit: 1,
          limitReset: "daily",
          action: "block",
        },
      ],
    })
    expect(parsed.success).toBe(true)
    expect(BudgetConfigSchema.safeParse({}).success).toBe(true)
  })

  test("refuses a repeated filter id, and filters without members", () => {
    const repeated = BudgetConfigSchema.safeParse({
      filters: [filter, filter],
    })
    expect(repeated.success).toBe(false)
    if (!repeated.success) {
      expect(repeated.error.issues[0]).toMatchObject({
        message: "duplicate budget filter id 'f'",
        path: ["filters", 1, "id"],
      })
    }
    expect(
      BudgetConfigSchema.safeParse({ filters: [{ ...filter, members: [] }] })
        .success,
    ).toBe(false)
    expect(
      BudgetConfigSchema.safeParse({ filters: [{ ...filter, kind: "tools" }] })
        .success,
    ).toBe(false)
  })
})

const askRule = (overrides: Record<string, unknown> = {}) => ({
  id: "asking",
  scope: { kind: "global" as const },
  limit: AIU,
  limit_reset: "daily" as const,
  warn_at: 0.8,
  action: "ask" as const,
  ...overrides,
})

describe("ask rules and notify routing in rules documents", () => {
  test("an ask rule and its routing export and import back unchanged", () => {
    const limits: Array<BudgetLimitConfig> = [
      {
        id: "asking",
        scope: { kind: "global" },
        limit: AIU,
        limitReset: "daily",
        action: "ask",
        notify: { warn: "tray", limit: "none" },
      },
    ]
    const budget: BudgetConfig = { limits }
    const exported = exportRules(budget)
    expect(exported.limits[0]).toMatchObject({
      action: "ask",
      notify: { warn: "tray", limit: "none" },
    })
    const result = ok(planImport(budget, { rules: exported, mode: "replace" }))
    expect(result.diff.limits.unchanged).toEqual(["asking"])
    expect(result.next.limits[0]).toBe(limits[0])
  })

  test("a rule that leaves notify out takes the defaults, and equals a stored rule without it", () => {
    const stored: BudgetConfig = {
      limits: [
        {
          id: "asking",
          scope: { kind: "global" },
          limit: AIU,
          limitReset: "daily",
          warnAt: 0.8,
          action: "ask",
        },
      ],
    }
    const result = ok(
      planImport(stored, {
        rules: doc({ limits: [askRule()] }),
        mode: "merge",
      }),
    )
    expect(result.diff.limits.unchanged).toEqual(["asking"])
    expect(result.diff.limits.changed).toEqual([])
  })

  test("only a routing that differs from the default is stored", () => {
    const fresh = ok(
      planImport(undefined, {
        rules: doc({
          limits: [
            askRule({
              id: "plain",
              notify: { warn: "notification", limit: "both" },
            }),
            askRule({ id: "custom", notify: { warn: "none", limit: "tray" } }),
          ],
        }),
        mode: "merge",
      }),
    )
    expect(fresh.next.limits[0]).not.toHaveProperty("notify")
    expect(fresh.next.limits[1].notify).toEqual({ warn: "none", limit: "tray" })
  })

  test("a different routing is a change", () => {
    const stored: BudgetConfig = {
      limits: [
        {
          id: "asking",
          scope: { kind: "global" },
          limit: AIU,
          limitReset: "daily",
          warnAt: 0.8,
          action: "ask",
        },
      ],
    }
    const result = ok(
      planImport(stored, {
        rules: doc({
          limits: [askRule({ notify: { warn: "tray", limit: "tray" } })],
        }),
        mode: "merge",
      }),
    )
    expect(result.diff.limits.changed).toHaveLength(1)
    expect(result.next.limits[0].notify).toEqual({
      warn: "tray",
      limit: "tray",
    })
  })

  test("a channel that isn't one is refused, and notify takes both keys", () => {
    for (const notify of [
      { warn: "loud", limit: "both" },
      { warn: "tray" },
      { warn: "tray", limit: "both", extra: 1 },
    ]) {
      expect(
        problems(
          planImport(undefined, {
            rules: doc({ limits: [askRule({ notify })] }),
            mode: "merge",
          }),
        ).length,
      ).toBeGreaterThan(0)
    }
  })
})

describe("the schema's ask action and routing", () => {
  const base = {
    id: "l",
    scope: { kind: "global" },
    limit: 1,
    limitReset: "daily",
  }

  test("accepts ask, and each channel for each notice", () => {
    for (const action of ["block", "warn", "ask"]) {
      expect(
        BudgetConfigSchema.safeParse({ limits: [{ ...base, action }] }).success,
      ).toBe(true)
    }
    for (const channel of ["none", "notification", "tray", "both"]) {
      expect(
        BudgetConfigSchema.safeParse({
          limits: [
            {
              ...base,
              action: "ask",
              notify: { warn: channel, limit: channel },
            },
          ],
        }).success,
      ).toBe(true)
    }
    expect(
      BudgetConfigSchema.safeParse({
        limits: [{ ...base, action: "ask", notify: {} }],
      }).success,
    ).toBe(true)
  })

  test("refuses another action or channel", () => {
    expect(
      BudgetConfigSchema.safeParse({ limits: [{ ...base, action: "pause" }] })
        .success,
    ).toBe(false)
    expect(
      BudgetConfigSchema.safeParse({
        limits: [{ ...base, action: "ask", notify: { limit: "email" } }],
      }).success,
    ).toBe(false)
  })
})
