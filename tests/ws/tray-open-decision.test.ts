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
): RegisteredTab {
  return { tabId, visibility }
}

describe("decideTrayOpen — unskip when implemented", () => {
  test("no tabs → open one", () => {
    expect(decideTrayOpen([])).toEqual({ kind: "open" })
  })

  test("a visible tab exists → noop (a background page can't be raised anyway)", () => {
    expect(decideTrayOpen([tab("a", "hidden"), tab("b", "visible")])).toEqual({
      kind: "noop",
    })
  })

  test("only buried tabs → close every buried tab, then open one fresh", () => {
    const action = decideTrayOpen([tab("a", "hidden"), tab("b", "prerender")])
    expect(action.kind).toBe("close-then-open")
    if (action.kind === "close-then-open") {
      expect([...action.closeTabIds].sort()).toEqual(["a", "b"])
    }
  })

  test("prerender is not 'visible' → treated as buried", () => {
    expect(decideTrayOpen([tab("a", "prerender")])).toEqual({
      kind: "close-then-open",
      closeTabIds: ["a"],
    })
  })
})
