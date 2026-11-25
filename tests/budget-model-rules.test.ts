import { describe, expect, test } from "bun:test"

import type {
  BudgetLimitStatus,
  BudgetStatusResponse,
} from "../src/lib/config/settings-types"

import {
  MODEL_PROVIDER,
  parseRulesHash,
  ruleCoversModel,
  rulesForModel,
  rulesHashForModel,
  rulesNamingModel,
} from "../shell/src/ui/features/budget/modelRules"

function rule(
  id: string,
  scope: BudgetLimitStatus["scope"],
): BudgetLimitStatus {
  return {
    id,
    label: null,
    scope,
    action: "block",
    warn_at: 0.8,
    unit: "cost",
    measure: null,
    max_requests: null,
    requests: null,
    when: null,
    enforced: true,
    limit: 1,
    effective_limit: 1,
    limit_reset: "daily",
    limit_remaining: 1,
    usage: 0,
    held: 0,
    usage_daily: 0,
    usage_weekly: 0,
    period_start: "2026-11-11T00:00:00.000Z",
    resets_at: "2026-11-12T00:00:00.000Z",
    reset_basis: "fixed",
    reset_estimated: false,
    state: "ok",
    display: { limit: 0, usage: 0, limit_remaining: 0 },
  } as BudgetLimitStatus
}

const filters: BudgetStatusResponse["filters"] = [
  {
    id: "claude-models",
    name: "Claude",
    kind: "models",
    members: ["claude-*"],
    used_by: ["claude-cap"],
  },
  {
    id: "one-model",
    name: "One",
    kind: "models",
    members: ["gpt-6.1-sol", "o?"],
    used_by: ["one-cap"],
  },
  {
    id: "my-clients",
    name: "Clients",
    kind: "clients",
    members: ["claude-*"],
    used_by: ["clients-cap"],
  },
]

const budgets = [
  rule("everything", { kind: "global" }),
  rule("copilot-cap", { kind: "provider", id: MODEL_PROVIDER }),
  rule("claude-cap", { kind: "filter", id: "claude-models" }),
  rule("one-cap", { kind: "filter", id: "one-model" }),
  rule("clients-cap", { kind: "filter", id: "my-clients" }),
  rule("codex-cap", { kind: "key", id: "codex" }),
  rule("images-cap", { kind: "plugin", id: "images" }),
  rule("other-provider", { kind: "provider", id: "openrouter" }),
  rule("gone-filter", { kind: "filter", id: "deleted" }),
]
const source = { budgets, filters }

const ids = (rules: Array<BudgetLimitStatus>): Array<string> =>
  rules.map((r) => r.id)

describe("which rules apply to a model", () => {
  test("a rule that covers everything, one that names the provider, and a filter whose glob matches", () => {
    expect(ids(rulesForModel("claude-sonnet-5-5", source))).toEqual([
      "everything",
      "copilot-cap",
      "claude-cap",
    ])
  })

  test("an exact member and a one-character glob match, and nothing else does", () => {
    expect(ids(rulesForModel("gpt-6.1-sol", source))).toEqual([
      "everything",
      "copilot-cap",
      "one-cap",
    ])
    expect(ids(rulesForModel("o3", source))).toEqual([
      "everything",
      "copilot-cap",
      "one-cap",
    ])
    expect(ids(rulesForModel("o33", source))).toEqual([
      "everything",
      "copilot-cap",
    ])
    expect(ids(rulesForModel("gpt-6.1-sol-mini", source))).toEqual([
      "everything",
      "copilot-cap",
    ])
  })

  test("a client key, a plugin, another provider and a filter of clients say nothing about a model", () => {
    for (const id of [
      "codex-cap",
      "images-cap",
      "other-provider",
      "clients-cap",
    ]) {
      const found = budgets.find((r) => r.id === id)
      expect(
        found && ruleCoversModel(found, "claude-sonnet-5-5", filters),
      ).toBe(false)
    }
  })

  test("a filter that no longer exists selects nothing: its rule is inert, never everything", () => {
    expect(ids(rulesForModel("claude-sonnet-5-5", source))).not.toContain(
      "gone-filter",
    )
  })

  test("matching is case-sensitive, as the server's is", () => {
    expect(ids(rulesForModel("Claude-Sonnet-5-5", source))).not.toContain(
      "claude-cap",
    )
  })

  test("the marked rules leave out the ones that cover everything", () => {
    expect(ids(rulesNamingModel("claude-sonnet-5-5", source))).toEqual([
      "copilot-cap",
      "claude-cap",
    ])
    expect(
      ids(
        rulesNamingModel("claude-sonnet-5-5", {
          budgets: [budgets[0]],
          filters,
        }),
      ),
    ).toEqual([])
  })

  test("with no rules there is nothing to apply", () => {
    expect(
      rulesForModel("claude-sonnet-5-5", { budgets: [], filters: [] }),
    ).toEqual([])
  })
})

describe("the link between the Models list and the Rules window", () => {
  test("the hash carries the model, escaped, and reads back the same", () => {
    for (const id of [
      "gpt-6.1-sol",
      "claude sonnet",
      "vendor/model:1",
      "ünï-1",
    ]) {
      const hash = rulesHashForModel(id)
      expect(hash.startsWith("#rules/model/")).toBe(true)
      // One slash after the section, so the router still sees the section.
      expect(hash.slice("#rules/model/".length)).not.toContain("/")
      expect(parseRulesHash(hash)).toEqual({ model: id })
    }
  })

  test("any other hash asks for nothing", () => {
    for (const hash of [
      "",
      "#rules",
      "#rules/",
      "#rules/model",
      "#rules/model/",
      "#models",
      "#rules/other/x",
      "#rules/model/%E0%A4%A",
    ]) {
      expect(parseRulesHash(hash)).toEqual({ model: null })
    }
  })
})
