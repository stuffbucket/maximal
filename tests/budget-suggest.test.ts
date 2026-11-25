/**
 * Draft rules from usage: sized to the p90 of what the scope spent per
 * period, in the persona's shape, with the rule replayed over the same usage.
 */

import { describe, expect, test } from "bun:test"

import type { UsageEventRow } from "~/lib/budget/reports/simulate"

import { roundUpNice, suggestRules } from "~/lib/budget/reports/suggest"

const AIU = 1_000_000_000
const at = (...parts: [number, number, number, number?, number?]): number =>
  Date.UTC(parts[0], parts[1] - 1, parts[2], parts[3] ?? 0, parts[4] ?? 0)

const usd = { unit: "usd", creditUsd: 0.01 } as const
const credits = { unit: "credits", creditUsd: 0.01 } as const

/** Monday 2026-10-19 to Saturday 2026-11-07: 20 days. Day d spends
 *  (d + 1) AIU in ten requests; three of every ten are the images plugin,
 *  and the `ci` key sends two. */
function twentyDays(): Array<UsageEventRow> {
  const rows: Array<UsageEventRow> = []
  for (let day = 0; day < 20; day++) {
    for (let k = 0; k < 10; k++) {
      rows.push({
        createdAtMs: at(2026, 10, 19 + day, 1 + k),
        nanoAiu: ((day + 1) * AIU) / 10,
        key: k < 2 ? "ci" : "laptop",
        provider: "copilot",
        ...(k >= 7 ? { plugin: "images" } : {}),
      })
    }
  }
  return rows
}

const window = {
  fromMs: at(2026, 10, 19),
  toMs: at(2026, 11, 8),
  nowMs: at(2026, 11, 8),
  findWindow: () => undefined,
}

function suggest(overrides: Partial<Parameters<typeof suggestRules>[0]> = {}) {
  return suggestRules({
    rows: twentyDays(),
    display: usd,
    context: window,
    existingIds: new Set(),
    ...overrides,
  })
}

describe("roundUpNice", () => {
  test.each([
    [3.17, 3.2],
    [47.3, 48],
    [120.4, 130],
    [0.0032, 0.0032],
    [0.00321, 0.0033],
    [9.99, 10],
    [10, 10],
    [100, 100],
    [0.3, 0.3],
    [0.18, 0.18],
    [1.001, 1.1],
  ])("%d rounds up to %d", (value, expected) => {
    expect(roundUpNice(value)).toBe(expected)
  })

  test.each([0, -1, Number.NaN])("%d is 0", (value) => {
    expect(roundUpNice(value)).toBe(0)
  })
})

describe("the default shape", () => {
  const { rules, notes } = suggest()

  test("a daily and a weekly cap on everything, plus a rule for a plugin with a big share", () => {
    expect(rules.map((r) => r.id)).toEqual([
      "daily-cap",
      "weekly-cap",
      "images-daily",
    ])
    expect(rules.map((r) => r.scope)).toEqual([
      { kind: "global" },
      { kind: "global" },
      { kind: "plugin", id: "images" },
    ])
    expect(rules.map((r) => r.limitReset)).toEqual(["daily", "weekly", "daily"])
    expect(notes).toEqual([])
  })

  test("the daily cap is the p90 of the days' spend", () => {
    const daily = rules[0]
    // Spends 1..20 AIU; nearest rank 18 of 20 is 18 AIU.
    expect(daily.basis).toMatchObject({
      percentile: 0.9,
      periodsObserved: 20,
      peakNanoAiu: 20 * AIU,
      sizedToNanoAiu: 18 * AIU,
      share: 1,
    })
    expect(daily.limitNanoAiu).toBe(18 * AIU)
    expect(daily.warnAt).toBe(0.8)
    expect(daily.action).toBe("block")
  })

  test("each rule carries its own replay over the same usage", () => {
    const daily = rules[0]
    // Only the busiest day finds the limit already reached.
    expect(daily.projection).toMatchObject({
      periodsTotal: 20,
      periodsTripped: 1,
    })
    expect(daily.projection.refusedRequests).toBeGreaterThan(0)
    expect(rules[1].projection.periodsTotal).toBeGreaterThanOrEqual(2)
  })

  test("a plugin rule is sized to that plugin's spend alone", () => {
    const images = rules[2]
    expect(images.basis.share).toBeCloseTo(0.3, 12)
    // Three tenths of each day: 0.3 * (1..20) AIU; p90 = 0.3 * 18.
    expect(images.limitNanoAiu).toBeGreaterThanOrEqual(5.4 * AIU)
    expect(images.limitNanoAiu).toBeLessThan(5.5 * AIU)
  })
})

describe("personas", () => {
  test("trying things out: one daily cap", () => {
    expect(
      suggest({ persona: "trying-things-out" }).rules.map((r) => r.id),
    ).toEqual(["daily-cap"])
  })

  test("daily driver: daily and weekly, no per-plugin rule", () => {
    expect(suggest({ persona: "daily-driver" }).rules.map((r) => r.id)).toEqual(
      ["daily-cap", "weekly-cap"],
    )
  })

  test("heavy agent use: a rolling 5 hour cap sized by hourly samples", () => {
    const { rules } = suggest({ persona: "heavy-agent-use" })
    expect(rules).toHaveLength(1)
    expect(rules[0]).toMatchObject({
      id: "rolling-5h-cap",
      limitReset: { every: { hours: 5 } },
      basis: { periodsObserved: null },
      projection: { periodsTotal: null, periodsTripped: null },
    })
    expect(rules[0].limitNanoAiu).toBeGreaterThan(0)
  })

  test("team: one daily cap per key, the biggest spender first", () => {
    const { rules } = suggest({ persona: "team" })
    expect(rules.map((r) => [r.id, r.scope])).toEqual([
      ["laptop-daily", { kind: "key", id: "laptop" }],
      ["ci-daily", { kind: "key", id: "ci" }],
    ])
    expect(rules[1].basis.share).toBeCloseTo(0.2, 12)
  })

  test("team stops at ten keys", () => {
    const rows = Array.from({ length: 14 }, (_, k) => ({
      createdAtMs: at(2026, 10, 20, 1 + k),
      nanoAiu: (k + 1) * AIU,
      key: `key-${k}`,
      provider: "copilot",
    }))
    expect(suggest({ rows, persona: "team" }).rules).toHaveLength(10)
  })
})

describe("what the usage allows", () => {
  test("no spend suggests nothing", () => {
    expect(suggest({ rows: [] })).toEqual({ rules: [], notes: ["no_spend"] })
    expect(
      suggest({
        rows: [
          {
            createdAtMs: at(2026, 10, 20),
            nanoAiu: 0,
            key: "k",
            provider: "p",
          },
        ],
      }),
    ).toEqual({ rules: [], notes: ["no_spend"] })
  })

  test("under two weeks of history there is no weekly cap, and it says so", () => {
    const { rules, notes } = suggest({
      context: { ...window, toMs: at(2026, 10, 30) },
      persona: undefined,
    })
    expect(rules.map((r) => r.id)).not.toContain("weekly-cap")
    expect(notes).toEqual(["short_history"])
  })

  test("a scope that was busy on one day in twenty is sized to that day", () => {
    const rows: Array<UsageEventRow> = [
      {
        createdAtMs: at(2026, 10, 25, 1),
        nanoAiu: 3 * AIU,
        key: "k",
        provider: "p",
      },
    ]
    const [rule] = suggest({ rows, persona: "trying-things-out" }).rules
    expect(rule.basis).toMatchObject({
      percentile: 1,
      peakNanoAiu: 3 * AIU,
      sizedToNanoAiu: 3 * AIU,
    })
    expect(rule.limitNanoAiu).toBe(3 * AIU)
    // Sized to the busy day, the rule would not have refused anything.
    expect(rule.projection.refusedRequests).toBe(0)
  })

  test("a scope that spent nothing gets no rule", () => {
    const rows = twentyDays().map((row) => ({ ...row, plugin: undefined }))
    const clean = rows.map(({ plugin: _plugin, ...rest }) => rest)
    expect(suggest({ rows: clean }).rules.map((r) => r.id)).toEqual([
      "daily-cap",
      "weekly-cap",
    ])
  })

  test("a draft avoids the ids already in use", () => {
    const { rules } = suggest({
      persona: "trying-things-out",
      existingIds: new Set(["daily-cap", "daily-cap-2"]),
    })
    expect(rules[0].id).toBe("daily-cap-3")
  })

  test("amounts are rounded up in the display unit", () => {
    // 1.234 AIU spent in one day: $0.01234 rounds up to $0.013.
    const rows: Array<UsageEventRow> = [
      {
        createdAtMs: at(2026, 10, 20, 1),
        nanoAiu: 1.234 * AIU,
        key: "k",
        provider: "p",
      },
    ]
    const inUsd = suggest({
      rows,
      persona: "trying-things-out",
      context: { ...window, toMs: at(2026, 10, 21) },
    }).rules[0]
    expect(inUsd.limitNanoAiu).toBe(1.3 * AIU)
    const inCredits = suggest({
      rows,
      display: credits,
      persona: "trying-things-out",
      context: { ...window, toMs: at(2026, 10, 21) },
    }).rules[0]
    expect(inCredits.limitNanoAiu).toBe(1.3 * AIU)
    const big = suggest({
      rows: [{ ...rows[0], nanoAiu: 1234.5 * AIU }],
      display: credits,
      persona: "trying-things-out",
      context: { ...window, toMs: at(2026, 10, 21) },
    }).rules[0]
    expect(big.limitNanoAiu).toBe(1300 * AIU)
  })

  test("the suggestion never sits below the figure it was sized to", () => {
    const { rules } = suggest()
    for (const rule of rules) {
      expect(rule.limitNanoAiu).toBeGreaterThanOrEqual(
        rule.basis.sizedToNanoAiu,
      )
    }
  })

  test("is deterministic", () => {
    expect(suggest()).toEqual(suggest())
  })
})
