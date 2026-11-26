import { describe, expect, test } from "bun:test"

import { PluginContractError } from "../src/index"
import { normalizeStatus } from "../src/runtime/index"

const base = { state: "ready", code: "ready", summary: "Ready" } as const
const request = {
  title: "Let it connect?",
  detail: "This panel wants to control the board.",
  facts: [{ label: "Panel", value: "x" }],
  approve: { id: "approve-x", label: "Approve" },
  decline: { id: "deny-x", label: "Deny" },
}

function invalidStatus(attention: unknown): string | undefined {
  try {
    normalizeStatus("alpha", { ...base, attention })
  } catch (error) {
    return error instanceof PluginContractError ? error.code : undefined
  }
  return undefined
}

describe("plugin status activity", () => {
  test("accepts consistent running and idle activity", () => {
    expect(
      normalizeStatus("alpha", {
        ...base,
        activity: {
          activeCalls: 2,
          startedAtMs: 100,
          lastActivityAtMs: 200,
          lastTool: "search",
          expiresAtMs: 500,
        },
      }).activity,
    ).toMatchObject({ activeCalls: 2, expiresAtMs: 500 })
    expect(
      normalizeStatus("alpha", {
        ...base,
        activity: {
          activeCalls: 0,
          startedAtMs: null,
          lastActivityAtMs: 200,
          expiresAtMs: null,
        },
      }).activity,
    ).toMatchObject({ activeCalls: 0, expiresAtMs: null })
  })

  test("refuses contradictory call counts, starts and deadlines", () => {
    const activities = [
      { activeCalls: 1, startedAtMs: null, lastActivityAtMs: 200 },
      { activeCalls: 0, startedAtMs: 100, lastActivityAtMs: 200 },
      {
        activeCalls: 1,
        startedAtMs: 100,
        lastActivityAtMs: 200,
        expiresAtMs: null,
      },
      {
        activeCalls: 0,
        startedAtMs: null,
        lastActivityAtMs: 200,
        expiresAtMs: 500,
      },
    ]

    expect(
      activities.map((activity) => {
        try {
          normalizeStatus("alpha", { ...base, activity })
        } catch (error) {
          return error instanceof PluginContractError ? error.code : undefined
        }
        return undefined
      }),
    ).toEqual(activities.map(() => "invalid-status"))
  })
})

describe("plugin status attention requests", () => {
  test("validates and preserves dialog requests", () => {
    const status = normalizeStatus("alpha", {
      ...base,
      attention: {
        summary: "Needs you",
        actions: [request.approve],
        requests: [request],
      },
    })

    expect(status.attention).toMatchObject({
      summary: "Needs you",
      requests: [{ title: "Let it connect?" }],
    })
  })

  test("refuses malformed request lists, actions and facts", () => {
    const cases = [
      { summary: "x", actions: [], requests: "nope" },
      {
        summary: "x",
        actions: [],
        requests: [
          { ...request, approve: { ...request.approve, id: "bad id!" } },
        ],
      },
      {
        summary: "x",
        actions: [],
        requests: [{ ...request, facts: [{ label: "Panel", value: 1 }] }],
      },
    ]

    expect(cases.map((attention) => invalidStatus(attention))).toEqual([
      "invalid-status",
      "invalid-status",
      "invalid-status",
    ])
  })
})
