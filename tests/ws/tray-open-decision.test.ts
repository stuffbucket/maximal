import { describe, expect, test } from "bun:test"

import { decideTrayOpen, type RegisteredTab } from "~/lib/ws/tray-open"

/**
 * Tray-open dedup decision (spec §1.2, §10 "tray-open dedup (visible/buried/none)").
 *
 * `decideTrayOpen` is the pure heart of the single-tab guarantee and the intended
 * `bun run mutate` target (point stryker.conf.json's `mutate` at
 * `src/lib/ws/tray-open.ts` for this suite). Behavioral cases are authored below
 * but skipped until the body lands — remove `.skip` then.
 */

function tab(
  tabId: string,
  visibility: RegisteredTab["visibility"],
  focused = false,
): RegisteredTab {
  return { tabId, visibility, focused }
}

describe("decideTrayOpen — unskip when implemented", () => {
  test("no tabs → open one", () => {
    expect(decideTrayOpen([])).toEqual({ kind: "open" })
  })

  test("a visible AND focused tab exists → noop (it's in front of the user)", () => {
    expect(
      decideTrayOpen([tab("a", "hidden"), tab("b", "visible", true)]),
    ).toEqual({ kind: "noop" })
  })

  test("a visible but UNFOCUSED tab → close-then-open (can't raise a foreign tab)", () => {
    // The dead-click case: backgrounded browser / non-key window still reports
    // "visible". Reopening is the only way to actually surface it.
    const action = decideTrayOpen([tab("a", "visible", false)])
    expect(action).toEqual({ kind: "close-then-open", closeTabIds: ["a"] })
  })

  test("only buried tabs → close every buried tab, then open one fresh", () => {
    const action = decideTrayOpen([tab("a", "hidden"), tab("b", "prerender")])
    expect(action.kind).toBe("close-then-open")
    if (action.kind === "close-then-open") {
      expect([...action.closeTabIds].sort()).toEqual(["a", "b"])
    }
  })

  test("focused but hidden (not visible) → still close-then-open", () => {
    // `focused` without `visible` shouldn't count as in-front (defensive: a hidden
    // tab reporting focus is nonsensical, but the guard requires BOTH).
    expect(decideTrayOpen([tab("a", "hidden", true)])).toEqual({
      kind: "close-then-open",
      closeTabIds: ["a"],
    })
  })

  test("prerender is not 'visible' → treated as buried", () => {
    expect(decideTrayOpen([tab("a", "prerender")])).toEqual({
      kind: "close-then-open",
      closeTabIds: ["a"],
    })
  })
})
