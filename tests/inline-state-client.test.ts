import { describe, expect, test } from "bun:test"

import type { InlineUiState } from "../src/lib/ws/feed-types"

import { readInlineState } from "../shell/src/proxy/inline-state-client"

/**
 * Instant-paint reader (spec §1.4). Reads the `window.__STATE__` the sidecar
 * inlines; never throws so a missing/garbled value simply means "no instant paint,
 * hydrate normally". DOM-free — the window is injected.
 */

function validState(): InlineUiState {
  return {
    snapshot: {
      auth: { state: "unauthenticated" },
    } as unknown as InlineUiState["snapshot"],
    sessionToken: "tok",
    locale: "en",
    boundPort: 4242,
    dismissedUpdateVersion: null,
    restoreView: null,
  }
}

describe("readInlineState", () => {
  test("returns the inlined state when present and well-formed", () => {
    const state = validState()
    expect(readInlineState({ __STATE__: state })).toEqual(state)
  })

  test("returns null when __STATE__ is absent", () => {
    expect(readInlineState({})).toBeNull()
  })

  test("returns null for a non-object / null __STATE__ (never throws)", () => {
    expect(readInlineState({ __STATE__: "nope" })).toBeNull()
    expect(readInlineState({ __STATE__: null })).toBeNull()
    expect(readInlineState({ __STATE__: 42 })).toBeNull()
  })

  test("returns null when the load-bearing fields are wrong-typed", () => {
    // truthy but structurally wrong — must not crash first paint.
    expect(
      readInlineState({ __STATE__: { snapshot: null, boundPort: 1 } }),
    ).toBeNull()
    expect(
      readInlineState({ __STATE__: { snapshot: {}, boundPort: "4242" } }),
    ).toBeNull()
    expect(
      readInlineState({ __STATE__: { snapshot: {}, boundPort: 4242 } }),
    ).toBeNull() // missing sessionToken
  })
})
