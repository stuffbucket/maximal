/**
 * GET /settings/api/events — the SSE live-update channel (ADR-0007).
 *
 * Covers the two things that make the channel trustworthy:
 *  1. Delivery: a fresh connection gets an initial auth snapshot, and every
 *     subsequent `settingsEventBus.publish("auth.changed", …)` is written to
 *     the stream as a named `auth.changed` event with the status as JSON.
 *  2. Auth: the endpoint accepts an API key via `?key=` (EventSource can't
 *     send headers) — but ONLY for this path. `extractRequestApiKey` must
 *     never honour `?key=` for any other endpoint, or keys would leak into
 *     arbitrary request URLs.
 */

import { describe, expect, test } from "bun:test"
import { Hono } from "hono"

import type { AuthStatus } from "~/lib/config/settings-types"

import { extractRequestApiKey, SSE_EVENTS_PATH } from "~/lib/auth/request-auth"
import { settingsEventBus } from "~/lib/config/settings-events"
import { eventsRoutes } from "~/routes/settings/events"

function mount(): Hono {
  const app = new Hono()
  app.route(SSE_EVENTS_PATH, eventsRoutes)
  return app
}

/** Read from the stream until the accumulated text contains `target`, or
 *  throw on timeout. SSE frames can split across chunks, so we accumulate.
 *  A single sequential read loop (never concurrent reads) avoids dropping
 *  chunks; the timeout cancels the reader to unblock a pending read(). */
/** Minimal structural reader — decouples the helper from lib differences
 *  (Bun's reader has `readMany`; the DOM BYOB overload differs). */
type StreamReader = {
  read: () => Promise<{ done: boolean; value?: Uint8Array }>
  cancel: () => Promise<void>
}

async function readUntil(
  reader: StreamReader,
  target: string,
  timeoutMs = 2000,
): Promise<string> {
  const decoder = new TextDecoder()
  let buffer = ""
  const timer = setTimeout(() => {
    void reader.cancel().catch(() => undefined)
  }, timeoutMs)
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (value) buffer += decoder.decode(value, { stream: true })
      if (buffer.includes(target)) return buffer
      if (done) break
    }
  } finally {
    clearTimeout(timer)
  }
  throw new Error(
    `gave up waiting for ${JSON.stringify(target)} `
      + `(timeout ${timeoutMs}ms or stream end); got: ${JSON.stringify(buffer)}`,
  )
}

function bodyReader(res: Response): StreamReader {
  const body = res.body
  if (!body) throw new Error("expected a streaming response body")
  return body.getReader()
}

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms))

describe("GET /settings/api/events (SSE)", () => {
  test("responds with an event-stream content type", async () => {
    const app = mount()
    const controller = new AbortController()
    const res = await app.request(SSE_EVENTS_PATH, {
      signal: controller.signal,
    })
    expect(res.status).toBe(200)
    expect(res.headers.get("content-type")).toContain("text/event-stream")
    controller.abort()
    await res.body?.cancel().catch(() => undefined)
  })

  test("sends an initial auth.changed snapshot on connect", async () => {
    const app = mount()
    const controller = new AbortController()
    const res = await app.request(SSE_EVENTS_PATH, {
      signal: controller.signal,
    })
    const reader = bodyReader(res)
    const frame = await readUntil(reader, "event: auth.changed")
    // The snapshot carries a real AuthStatus with a discriminant `state`.
    expect(frame).toContain("event: auth.changed")
    expect(frame).toContain('"state"')
    controller.abort()
    await reader.cancel().catch(() => undefined)
  })

  test("pushes published auth.changed events to the stream", async () => {
    const app = mount()
    const controller = new AbortController()
    const res = await app.request(SSE_EVENTS_PATH, {
      signal: controller.signal,
    })
    const reader = bodyReader(res)
    // Drain the initial snapshot first.
    await readUntil(reader, "event: auth.changed")
    // Let the handler's post-snapshot bus subscription register before we
    // publish, so the event can't race ahead of the subscriber.
    await sleep(25)

    const status: AuthStatus = {
      state: "authenticated",
      account_login: "octocat-sse-probe",
      account_type: null,
    }
    settingsEventBus.publish("auth.changed", status)

    const frame = await readUntil(reader, "octocat-sse-probe")
    expect(frame).toContain("octocat-sse-probe")
    expect(frame).toContain('"state":"authenticated"')
    controller.abort()
    await reader.cancel().catch(() => undefined)
  })
})

describe("SSE query-string key is path-scoped (extractRequestApiKey)", () => {
  const probe = new Hono().all("*", (c) =>
    c.json({ key: extractRequestApiKey(c) }),
  )

  async function keyFor(
    path: string,
    init?: RequestInit,
  ): Promise<string | null> {
    const res = await probe.request(path, init)
    return ((await res.json()) as { key: string | null }).key
  }

  test("honours ?key= on the events path", async () => {
    expect(await keyFor(`${SSE_EVENTS_PATH}?key=abc123`)).toBe("abc123")
  })

  test("ignores ?key= on any other path", async () => {
    expect(await keyFor("/settings/api/auth/github/status?key=abc123")).toBe(
      null,
    )
    expect(await keyFor("/settings/api/diagnostics?key=abc123")).toBe(null)
  })

  test("header key still wins over a query key on the events path", async () => {
    expect(
      await keyFor(`${SSE_EVENTS_PATH}?key=fromquery`, {
        headers: { "x-api-key": "fromheader" },
      }),
    ).toBe("fromheader")
  })

  test("trims and rejects an empty query key", async () => {
    expect(await keyFor(`${SSE_EVENTS_PATH}?key=`)).toBe(null)
  })
})
