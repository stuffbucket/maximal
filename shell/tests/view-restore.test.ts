import { describe, expect, test } from "bun:test"

import { pickInitialView } from "../src/view-restore"

/**
 * Restore-on-reopen decision (spec §1.4). Pure precedence logic: an explicit valid
 * hash wins (deep-link) with no scroll restore; else a valid inlined restoreView is
 * honored; else the fallback section at the top.
 */
describe("pickInitialView", () => {
  test("an explicit valid hash wins and does NOT restore scroll (fresh intent)", () => {
    expect(
      pickInitialView("#usage", { section: "apps", scrollY: 200 }, "account"),
    ).toEqual({ section: "usage", scrollY: 0 })
  })

  test("no hash + restoreView → restore that section and its scroll", () => {
    expect(
      pickInitialView("", { section: "apps", scrollY: 200 }, "account"),
    ).toEqual({ section: "apps", scrollY: 200 })
  })

  test("no hash + no restoreView → fallback section at the top", () => {
    expect(pickInitialView("", null, "account")).toEqual({
      section: "account",
      scrollY: 0,
    })
  })

  test("invalid hash + invalid restoreView section → fallback", () => {
    expect(
      pickInitialView("#bogus", { section: "nope", scrollY: 50 }, "account"),
    ).toEqual({ section: "account", scrollY: 0 })
  })

  test("a negative scrollY clamps to 0", () => {
    expect(
      pickInitialView("", { section: "usage", scrollY: -10 }, "account"),
    ).toEqual({ section: "usage", scrollY: 0 })
  })

  test("undefined restoreView (older sidecar) is tolerated", () => {
    expect(pickInitialView("", undefined, "usage")).toEqual({
      section: "usage",
      scrollY: 0,
    })
  })
})
