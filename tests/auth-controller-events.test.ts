/**
 * Producer-side contract for the settings event bus (ADR-0007): the auth
 * controller must publish `auth.changed` whenever the auth status changes,
 * so the SSE route can push it to the shell with no poll latency.
 *
 * Scoped to the two transitions that need no upstream/fs mocking —
 * `markSignedIn` (→ authenticated) and `markSignedOut` (→ unauthenticated).
 * The fuller transition coverage (device flow, signOut, fatal) lives in
 * auth-controller.test.ts; the SSE delivery side lives in events-route.test.ts.
 * Together they prove the bus is wired end to end.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test"

import type { AuthStatus } from "~/lib/settings-types"

import {
  __resetAuthControllerForTests,
  markSignedIn,
  markSignedOut,
} from "~/lib/auth-controller"
import { settingsEventBus } from "~/lib/settings-events"

function capture(): { events: Array<AuthStatus>; stop: () => void } {
  const events: Array<AuthStatus> = []
  const stop = settingsEventBus.subscribe("auth.changed", (status) => {
    events.push(status)
  })
  return { events, stop }
}

beforeEach(() => {
  __resetAuthControllerForTests()
})

afterEach(() => {
  __resetAuthControllerForTests()
})

describe("auth.changed emission (ADR-0007 producer side)", () => {
  test("markSignedIn publishes the authenticated status", () => {
    const { events, stop } = capture()
    try {
      markSignedIn("octocat")
    } finally {
      stop()
    }
    expect(events.at(-1)).toEqual({
      state: "authenticated",
      account_login: "octocat",
    })
  })

  test("markSignedOut publishes the unauthenticated status", () => {
    markSignedIn("octocat")
    const { events, stop } = capture()
    try {
      markSignedOut()
    } finally {
      stop()
    }
    expect(events.at(-1)).toEqual({ state: "unauthenticated" })
  })

  test("a transition emits exactly once per state change", () => {
    const { events, stop } = capture()
    try {
      markSignedIn("octocat")
      markSignedOut()
    } finally {
      stop()
    }
    expect(events).toHaveLength(2)
    expect(events.map((e) => e.state)).toEqual([
      "authenticated",
      "unauthenticated",
    ])
  })
})
