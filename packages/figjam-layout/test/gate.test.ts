import { afterEach, describe, expect, test } from "bun:test"

import type { Layout } from "../src/model"

import { gate } from "../src/build"
import { HARD_CHECKS } from "../src/lanes"

const withChecks = (checks: Record<string, number>): Layout => ({
  name: "t",
  sections: [],
  nodes: [],
  edges: [],
  routes: [],
  checks,
})

describe("gate", () => {
  afterEach(() => {
    delete process.env.LAYOUT_FORCE
  })

  test("lets a plan through when every hard check is zero", () => {
    const zero = Object.fromEntries(HARD_CHECKS.map((k) => [k, 0]))
    expect(() => gate(withChecks({ ...zero, crossings: 12 }))).not.toThrow()
  })

  test("refuses to build a plan with a failing hard check, and names it", () => {
    expect(() => gate(withChecks({ clearance: 2, arrowHits: 1 }))).toThrow(
      "self-checks failed: clearance=2, arrowHits=1",
    )
  })

  test("LAYOUT_FORCE overrides the refusal", () => {
    process.env.LAYOUT_FORCE = "1"
    expect(() => gate(withChecks({ clearance: 2 }))).not.toThrow()
  })
})
