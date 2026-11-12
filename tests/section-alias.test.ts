import { describe, expect, test } from "bun:test"

import { canonicalHash, canonicalSection } from "../shell/src/section-alias"

describe("renamed section ids", () => {
  test("#budget is the old name of #rules", () => {
    expect(canonicalSection("budget")).toBe("rules")
    expect(canonicalHash("#budget")).toBe("#rules")
    expect(canonicalHash("budget")).toBe("#rules")
  })

  test("a sub-page after the section survives the rename", () => {
    expect(canonicalHash("#budget/limits")).toBe("#rules/limits")
  })

  test("current ids and unknown ids pass through unchanged", () => {
    expect(canonicalSection("rules")).toBe("rules")
    expect(canonicalHash("#rules")).toBe("#rules")
    expect(canonicalHash("#connectors/workiq")).toBe("#connectors/workiq")
    expect(canonicalSection("constructor")).toBe("constructor")
    expect(canonicalSection("")).toBe("")
  })
})
