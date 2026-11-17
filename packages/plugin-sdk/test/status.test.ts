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
