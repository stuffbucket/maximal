import { describe, expect, test } from "bun:test"
import { Hono } from "hono"

import type { ElicitPayload } from "~/lib/mcp-broker/control-protocol"

import {
  answerProblems,
  PendingRequests,
} from "~/lib/mcp-broker/pending-requests"
import { createRequestsRoutes } from "~/routes/settings/requests"

const NOW = Date.parse("2026-10-20T12:00:00Z")

const payload = (overrides: Partial<ElicitPayload> = {}): ElicitPayload => ({
  endpointId: "workiq",
  label: "Work IQ",
  toolName: "get_debug_link",
  mechanism: "legacy-form",
  mode: "form",
  message: "Allow the debug link?",
  requestedSchema: {
    type: "object",
    properties: {
      confirmed: { type: "boolean", title: "Confirm" },
      note: { type: "string", maxLength: 5 },
      email: { type: "string", format: "email" },
      count: { type: "integer", minimum: 1, maximum: 3 },
      color: { type: "string", enum: ["r", "b"], enumNames: ["Red", "Blue"] },
      size: {
        type: "string",
        oneOf: [
          { const: "s", title: "Small" },
          { const: "l", title: "Large" },
        ],
      },
    },
    required: ["confirmed"],
  },
  expiresAtMs: NOW + 60_000,
  ...overrides,
})

const store = (now = () => NOW) => {
  let changes = 0
  const answers: Array<unknown> = []
  const requests = new PendingRequests({
    now,
    onChange: () => {
      changes += 1
    },
  })
  const add = (requestId: string, value = payload(), generation = "g1") =>
    requests.add({
      generation,
      requestId,
      payload: value,
      answer: (result) => answers.push({ requestId, ...result }),
    })
  return { requests, add, answers, changes: () => changes }
}

describe("PendingRequests", () => {
  test("normalizes a server's form into fields Maximal can show", () => {
    const { requests, add } = store()
    expect(add("r1")).toBe(true)

    const [request] = requests.list().requests
    expect(request).toMatchObject({
      id: "r1",
      label: "Work IQ",
      toolName: "get_debug_link",
      mode: "form",
      receivedAt: new Date(NOW).toISOString(),
      expiresAt: new Date(NOW + 60_000).toISOString(),
    })
    expect(request.fields).toEqual([
      { name: "confirmed", kind: "boolean", title: "Confirm", required: true },
      { name: "note", kind: "string", required: false, maxLength: 5 },
      { name: "email", kind: "string", required: false, format: "email" },
      {
        name: "count",
        kind: "integer",
        required: false,
        minimum: 1,
        maximum: 3,
      },
      {
        name: "color",
        kind: "enum",
        required: false,
        options: [
          { value: "r", label: "Red" },
          { value: "b", label: "Blue" },
        ],
      },
      {
        name: "size",
        kind: "enum",
        required: false,
        options: [
          { value: "s", label: "Small" },
          { value: "l", label: "Large" },
        ],
      },
    ])
  })

  test("refuses a form with a field it can't show", () => {
    const { requests, add } = store()
    expect(
      add(
        "r1",
        payload({
          requestedSchema: {
            type: "object",
            properties: { tags: { type: "array" } },
          },
        }),
      ),
    ).toBe(false)
    expect(requests.list().requests).toHaveLength(0)
  })

  test("keeps a URL request's host for showing where it goes", () => {
    const { requests, add } = store()
    add(
      "r1",
      payload({
        mode: "url",
        mechanism: "legacy-url",
        requestedSchema: undefined,
        url: "https://login.example/consent?x=1",
      }),
    )
    expect(requests.list().requests[0]).toMatchObject({
      mode: "url",
      fields: [],
      url: "https://login.example/consent?x=1",
      urlHost: "login.example",
    })
  })

  test("takes only the first answer", () => {
    const { requests, add, answers } = store()
    add("r1")

    expect(requests.answer("r1", { action: "decline" })).toEqual({ ok: true })
    expect(requests.answer("r1", { action: "accept" })).toEqual({
      ok: false,
      reason: "answered",
    })
    expect(requests.answer("nope", { action: "accept" })).toEqual({
      ok: false,
      reason: "not-found",
    })
    expect(answers).toEqual([{ requestId: "r1", action: "decline" }])
  })

  test("drops withdrawn, expired and dead-generation requests", () => {
    let now = NOW
    const { requests, add, changes } = store(() => now)
    add("r1")
    add("r2", payload(), "g2")
    add("r3", payload({ expiresAtMs: NOW + 1_000 }))
    expect(requests.summary()).toEqual({ pending: 3, newestId: "r3" })

    requests.withdraw("r1")
    now = NOW + 2_000
    expect(requests.list().requests.map((request) => request.id)).toEqual([
      "r2",
    ])
    requests.dropGeneration("g2")
    expect(requests.summary()).toEqual({ pending: 0, newestId: null })
    expect(changes()).toBeGreaterThanOrEqual(6)
  })
})

describe("answerProblems", () => {
  const { requests, add } = store()
  add("r1")
  const [request] = requests.list().requests

  test("accepts valid content", () => {
    expect(
      answerProblems(request, {
        action: "accept",
        content: {
          confirmed: true,
          note: "hi",
          email: "a@b.example",
          count: 2,
          color: "b",
          size: "s",
        },
      }),
    ).toEqual([])
  })

  test("names each problem", () => {
    expect(
      answerProblems(request, {
        action: "accept",
        content: {
          note: "too long",
          email: "nope",
          count: 2.5,
          color: "green",
          extra: "x",
        },
      }),
    ).toEqual([
      "extra: not a field of this form",
      "confirmed: required",
      "note: must be at most 5 characters",
      "email: must be an email address",
      "count: must be a whole number",
      "color: must be one of the choices",
    ])
  })

  test("sends content only when accepting a form", () => {
    expect(
      answerProblems(request, {
        action: "decline",
        content: { confirmed: true },
      }),
    ).toEqual(["content is only sent when accepting a form"])
    expect(answerProblems(request, { action: "cancel" })).toEqual([])
  })
})

const app = () => {
  const harness = store()
  harness.add("r1")
  return {
    ...harness,
    app: new Hono().route("/requests", createRequestsRoutes(harness.requests)),
  }
}
const post = (target: Hono, id: string, body: unknown) =>
  target.request(`/requests/${id}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  })

describe("/settings/api/requests", () => {
  test("lists requests and summarizes them", async () => {
    const { app: target } = app()
    const list = (await (await target.request("/requests")).json()) as {
      requests: Array<{ id: string }>
    }
    expect(list.requests.map((request) => request.id)).toEqual(["r1"])
    expect(await (await target.request("/requests/summary")).json()).toEqual({
      pending: 1,
      newestId: "r1",
    })
  })

  test("answers, and reports a request that's gone or already answered", async () => {
    const { app: target, answers } = app()

    const accepted = await post(target, "r1", {
      action: "accept",
      content: { confirmed: true },
    })
    expect(accepted.status).toBe(200)
    expect(answers).toEqual([
      { requestId: "r1", action: "accept", content: { confirmed: true } },
    ])
    expect((await post(target, "r1", { action: "accept" })).status).toBe(409)
    expect((await post(target, "nope", { action: "accept" })).status).toBe(404)
  })

  test("rejects malformed and invalid answers", async () => {
    const { app: target, answers } = app()
    expect((await post(target, "r1", { action: "maybe" })).status).toBe(400)
    const invalid = await post(target, "r1", { action: "accept", content: {} })
    expect(invalid.status).toBe(422)
    expect(await invalid.text()).toContain("confirmed: required")
    expect(answers).toEqual([])
  })
})
