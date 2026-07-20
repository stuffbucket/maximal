import { afterEach, beforeEach, describe, expect, test } from "bun:test"

import type { AuthStatus } from "~/lib/config/settings-types"
import type {
  LiveFeedServerMessage,
  LiveFeedSnapshot,
} from "~/lib/ws/feed-types"

import { settingsEventBus } from "~/lib/config/settings-events"
import { state } from "~/lib/runtime-state/state"
import { closeUsageStore, recordTokenUsageEvent } from "~/lib/token-usage"
import { LiveFeedHub } from "~/lib/ws/live-feed"
import { PresenceRegistry } from "~/lib/ws/presence-registry"

/**
 * LiveFeedHub producer bridge (spec §1.3). The hub translates producer events
 * (the settings bus `auth.changed` and every recorded token-usage event) into
 * unified feed events and broadcasts to every connected tab. start() is
 * idempotent and stop() detaches, so a sidecar restart doesn't double-subscribe
 * or leak.
 *
 * start() now also seeds today's usage tally from the store, so every test here
 * pins an in-memory DB to avoid touching the real app-dir SQLite file.
 */

const DB_PATH_ENV = "COPILOT_API_SQLITE_DB_PATH"

/** A signed-out AuthStatus is enough — the hub forwards the payload verbatim. */
const AUTH_PAYLOAD = { state: "unauthenticated" } as unknown as AuthStatus

/** A registry with one fake tab whose sends we capture. */
function captureRegistry() {
  const registry = new PresenceRegistry()
  const sent: Array<string> = []
  registry.register(
    "tab",
    {
      send: (data: string) => sent.push(data),
      close: () => {},
    },
    "visible",
  )
  return { registry, sent }
}

function makeHub(registry: PresenceRegistry) {
  return new LiveFeedHub({
    registry,
    buildSnapshot: () => Promise.resolve({} as LiveFeedSnapshot),
  })
}

let started: LiveFeedHub | null = null

beforeEach(async () => {
  process.env[DB_PATH_ENV] = ":memory:"
  state.userName = "copilot-login"
  await closeUsageStore()
})

afterEach(async () => {
  // Always detach — the settings + token-usage buses are shared singletons; a
  // leaked subscription would fire into a dead registry in later tests.
  started?.stop()
  started = null
  await closeUsageStore()
  state.userName = undefined
  Reflect.deleteProperty(process.env, DB_PATH_ENV)
})

describe("LiveFeedHub producer bridge", () => {
  test("forwards a bus auth.changed as a wrapped feed event to all tabs", () => {
    const { registry, sent } = captureRegistry()
    started = makeHub(registry)
    started.start()
    settingsEventBus.publish("auth.changed", AUTH_PAYLOAD)
    expect(sent).toHaveLength(1)
    expect(JSON.parse(sent[0]) as LiveFeedServerMessage).toEqual({
      type: "event",
      event: { type: "auth.changed", payload: AUTH_PAYLOAD },
    })
  })

  test("start() is idempotent — a double start does not double-broadcast", () => {
    const { registry, sent } = captureRegistry()
    started = makeHub(registry)
    started.start()
    started.start()
    settingsEventBus.publish("auth.changed", AUTH_PAYLOAD)
    expect(sent).toHaveLength(1)
  })

  test("stop() detaches — later bus events are not broadcast", () => {
    const { registry, sent } = captureRegistry()
    started = makeHub(registry)
    started.start()
    started.stop()
    settingsEventBus.publish("auth.changed", AUTH_PAYLOAD)
    expect(sent).toHaveLength(0)
  })

  test("publish() wraps and broadcasts a feed event directly", () => {
    const { registry, sent } = captureRegistry()
    started = makeHub(registry)
    started.publish({ type: "sidecar-health", payload: "degraded" })
    expect(JSON.parse(sent[0]) as LiveFeedServerMessage).toEqual({
      type: "event",
      event: { type: "sidecar-health", payload: "degraded" },
    })
  })

  test("bridges a recorded token-usage event into a `usage` feed frame", () => {
    const { registry, sent } = captureRegistry()
    started = makeHub(registry)
    started.start()

    recordTokenUsageEvent({
      endpoint: "chat_completions",
      input_tokens: 10,
      model: "gpt-a",
      output_tokens: 5,
      source: "copilot",
    })

    // Exactly one broadcast — the recorded event (auth seeding does not emit).
    expect(sent).toHaveLength(1)
    const message = JSON.parse(sent[0]) as LiveFeedServerMessage
    expect(message.type).toBe("event")
    if (message.type !== "event" || message.event.type !== "usage") {
      throw new Error("expected a usage event")
    }
    const payload = message.event.payload
    expect(payload.requestCount).toBe(1)
    expect(payload.totalTokens).toBe(15)
    expect(payload.lastEvent).toEqual({
      model: "gpt-a",
      source: "copilot",
      providerName: null,
      endpoint: "chat_completions",
      inputTokens: 10,
      outputTokens: 5,
      totalTokens: 15,
      createdAtMs: expect.any(Number) as unknown as number,
    })
  })
})
