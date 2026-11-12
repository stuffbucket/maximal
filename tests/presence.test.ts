/**
 * Presence: staleness, the unknown default, change events and the route
 * contract. Real modules, no mocks; the clock is passed in.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { Hono } from "hono"

import type { PresenceStatus } from "~/lib/config/settings-types"

import { settingsEventBus } from "~/lib/config/settings-events"
import {
  __resetPresenceForTests,
  currentPresence,
  PRESENCE_STALE_MS,
  recordPresence,
} from "~/lib/presence"
import { presenceRoutes } from "~/routes/settings/presence"

const AT = "2026-11-11T10:00:00Z"
const unknown = { locked: null, idleSeconds: null, stale: true }

let events: Array<PresenceStatus> = []
let unsubscribe: () => void = () => {}

beforeEach(() => {
  __resetPresenceForTests()
  events = []
  unsubscribe = settingsEventBus.subscribe("presence.changed", (event) => {
    events.push(event)
  })
})

afterEach(() => {
  unsubscribe()
  __resetPresenceForTests()
})

describe("currentPresence", () => {
  test("is unknown before any report", () => {
    expect(currentPresence(1_000)).toEqual(unknown)
  })

  test("returns the latest report while fresh", () => {
    recordPresence({ locked: true, idleSeconds: 12, at: AT }, 1_000)
    expect(currentPresence(1_000 + PRESENCE_STALE_MS)).toEqual({
      locked: true,
      idleSeconds: 12,
      stale: false,
    })
  })

  test("is stale, and unknown, after 30 s without an update", () => {
    recordPresence({ locked: true, idleSeconds: 12, at: AT }, 1_000)
    expect(currentPresence(1_000 + PRESENCE_STALE_MS + 1)).toEqual(unknown)
  })

  test("a new report revives it", () => {
    recordPresence({ locked: true, idleSeconds: 12, at: AT }, 1_000)
    recordPresence({ locked: false, idleSeconds: 0, at: AT }, 100_000)
    expect(currentPresence(100_001)).toEqual({
      locked: false,
      idleSeconds: 0,
      stale: false,
    })
  })

  test("keeps null fields for a platform that can't tell", () => {
    recordPresence({ locked: null, idleSeconds: null, at: AT }, 1_000)
    expect(currentPresence(1_001)).toEqual({
      locked: null,
      idleSeconds: null,
      stale: false,
    })
  })

  test("staleness ignores the report's own timestamp", () => {
    recordPresence(
      { locked: true, idleSeconds: 1, at: "2001-01-01T00:00:00Z" },
      1_000,
    )
    expect(currentPresence(1_001).stale).toBe(false)
  })
})

describe("presence.changed", () => {
  test("fires on lock state changes only", () => {
    recordPresence({ locked: false, idleSeconds: 1, at: AT }, 1_000)
    recordPresence({ locked: false, idleSeconds: 2, at: AT }, 2_000)
    recordPresence({ locked: false, idleSeconds: 3, at: AT }, 3_000)
    expect(events).toHaveLength(1)
    recordPresence({ locked: true, idleSeconds: 4, at: AT }, 4_000)
    recordPresence({ locked: true, idleSeconds: 5, at: AT }, 5_000)
    recordPresence({ locked: false, idleSeconds: 0, at: AT }, 6_000)
    expect(events.map((e) => e.locked)).toEqual([false, true, false])
  })

  test("does not fire for an unknown lock state", () => {
    recordPresence({ locked: null, idleSeconds: 5, at: AT }, 1_000)
    expect(events).toEqual([])
  })

  test("fires when a known state returns after a stale gap", () => {
    recordPresence({ locked: true, idleSeconds: 5, at: AT }, 1_000)
    recordPresence({ locked: true, idleSeconds: 6, at: AT }, 100_000)
    expect(events.map((e) => e.locked)).toEqual([true, true])
  })
})

describe("/settings/api/presence", () => {
  const app = new Hono().route("/presence", presenceRoutes)
  const post = (body: unknown) =>
    app.request("/presence", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: typeof body === "string" ? body : JSON.stringify(body),
    })

  test("GET is unknown before any report", async () => {
    const response = await app.request("/presence")
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual(unknown)
  })

  test("POST stores a report that GET then shows", async () => {
    const response = await post({ locked: true, idleSeconds: 42, at: AT })
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      locked: true,
      idleSeconds: 42,
      stale: false,
    })
    const got = await app.request("/presence")
    expect(await got.json()).toEqual({
      locked: true,
      idleSeconds: 42,
      stale: false,
    })
  })

  test("POST accepts nulls", async () => {
    const response = await post({ locked: null, idleSeconds: null, at: AT })
    expect(response.status).toBe(200)
  })

  test.each([
    ["a missing field", { locked: true, at: AT }],
    ["a non-boolean lock", { locked: "yes", idleSeconds: 1, at: AT }],
    ["negative idle", { locked: true, idleSeconds: -1, at: AT }],
    ["a bad timestamp", { locked: true, idleSeconds: 1, at: "yesterday" }],
    ["an extra field", { locked: true, idleSeconds: 1, at: AT, app: "Safari" }],
    ["not JSON", "{nope"],
    ["null", "null"],
  ])("POST refuses %s with 400 and stores nothing", async (_label, body) => {
    const response = await post(body)
    expect(response.status).toBe(400)
    const parsed = (await response.json()) as { error: { type: string } }
    expect(parsed.error.type).toBe("validation_error")
    expect(currentPresence()).toEqual(unknown)
  })
})
