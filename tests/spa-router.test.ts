import { describe, expect, test } from "bun:test"

import {
  createRouter,
  type HistoryLike,
  type LocationLike,
  type RouterHandlers,
} from "../shell/src/router"

/**
 * Single-history routing invariant (spec §1.4, ADR-0020, §10 behavioral gate).
 *
 * Drives the DOM-free router core against a FAKE `History` and asserts
 * `history.length === 1` and that it NEVER pushes (there is no jsdom harness — the
 * router core is injectable precisely so it is testable here; the DOM glue in
 * `router-bootstrap.ts` is covered by the grep gate). Skipped until `createRouter`
 * lands.
 */

/** A fake history that counts pushes and tracks replace-driven length. */
function fakeHistory(): HistoryLike & { pushes: number; replaces: number } {
  const state = { pushes: 0, replaces: 0, length: 1 }
  return {
    get length() {
      return state.length
    },
    replaceState() {
      state.replaces += 1
      // replaceState must NOT grow history — length stays 1.
      state.length = 1
    },
    get pushes() {
      return state.pushes
    },
    get replaces() {
      return state.replaces
    },
  }
}

function fakeLocation(
  hash = "",
  search = "",
  pathname = "/ui/settings/",
): LocationLike {
  return { hash, search, pathname }
}

function noopHandlers(): RouterHandlers {
  return { showSection: () => {}, onEnter: () => {}, onLeave: () => {} }
}

describe("router single-history invariant — unskip when implemented", () => {
  test("navigate uses replaceState and never grows history", () => {
    const history = fakeHistory()
    const router = createRouter({
      history,
      location: fakeLocation("#usage"),
      handlers: noopHandlers(),
    })
    router.start()
    router.navigate("account")
    router.navigate("models")
    router.navigate("projects", { project: "acme" })
    expect(history.length).toBe(1)
    expect(history.pushes).toBe(0)
    expect(history.replaces).toBeGreaterThan(0)
  })

  test("start resolves the boot section from the hash", () => {
    const router = createRouter({
      history: fakeHistory(),
      location: fakeLocation("#models"),
      handlers: noopHandlers(),
    })
    router.start()
    expect(router.current()).toBe("models")
  })

  test("navigating fires onLeave(previous) then showSection/onEnter(target)", () => {
    const order: Array<string> = []
    const handlers: RouterHandlers = {
      onLeave: (prev) => order.push(`leave:${prev}`),
      showSection: (id) => order.push(`show:${id}`),
      onEnter: (id) => order.push(`enter:${id}`),
    }
    const router = createRouter({
      history: fakeHistory(),
      location: fakeLocation("#account"),
      handlers,
    })
    router.start()
    order.length = 0
    router.navigate("usage")
    expect(order).toEqual(["leave:account", "show:usage", "enter:usage"])
  })
})
