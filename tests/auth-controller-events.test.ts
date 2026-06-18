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
import {
  clearLastUpstreamRejection,
  setLastUpstreamRejection,
} from "~/lib/state"

function capture(): { events: Array<AuthStatus>; stop: () => void } {
  const events: Array<AuthStatus> = []
  const stop = settingsEventBus.subscribe("auth.changed", (status) => {
    events.push(status)
  })
  return { events, stop }
}

beforeEach(() => {
  __resetAuthControllerForTests()
  clearLastUpstreamRejection()
})

afterEach(() => {
  __resetAuthControllerForTests()
  clearLastUpstreamRejection()
})

describe("auth.changed emission (ADR-0007 producer side)", () => {
  test("markSignedIn publishes the authenticated status", () => {
    const { events, stop } = capture()
    try {
      markSignedIn("octocat")
    } finally {
      stop()
    }
    const last = events.at(-1)
    expect(last?.state).toBe("authenticated")
    if (last?.state === "authenticated") {
      expect(last.account_login).toBe("octocat")
      // markSignedIn stamps the connection time (the "Connected · uptime" line).
      expect(last.connected_since).toMatch(/^\d{4}-\d{2}-\d{2}T/)
    }
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

describe("upstream-rejection changes emit auth.changed (ADR-0007)", () => {
  const rejection = {
    message: "Rate limit exceeded",
    remediationUrl: null,
    status: 429,
  }

  test("setLastUpstreamRejection pushes the rejection on the auth status", () => {
    const { events, stop } = capture()
    try {
      setLastUpstreamRejection(rejection)
    } finally {
      stop()
    }
    const last = events.at(-1)
    expect(last?.state).toBe("unauthenticated")
    expect(
      last && "last_upstream_rejection" in last ?
        last.last_upstream_rejection?.message
      : undefined,
    ).toBe("Rate limit exceeded")
  })

  test("a same-content rejection does not re-emit", () => {
    setLastUpstreamRejection(rejection)
    const { events, stop } = capture()
    try {
      setLastUpstreamRejection(rejection)
    } finally {
      stop()
    }
    expect(events).toHaveLength(0)
  })

  test("clearing an existing rejection emits exactly once", () => {
    setLastUpstreamRejection(rejection)
    const { events, stop } = capture()
    try {
      clearLastUpstreamRejection()
      // Second clear is a no-op — must not fan out another event (the hot
      // request path clears on every success).
      clearLastUpstreamRejection()
    } finally {
      stop()
    }
    expect(events).toHaveLength(1)
    expect(events[0]?.state).toBe("unauthenticated")
  })
})
