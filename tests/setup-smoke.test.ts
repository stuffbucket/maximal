/**
 * Regression for #225/#227: the first-run smoke test hits GET /models (a catalog
 * check), not a hardcoded /v1/messages completion. `smokeTest` must:
 *   - return `{ ok: true, models }` only on 200 with a non-empty `data[]`,
 *   - return `{ ok: false }` (never throw) on 401, other non-2xx, an empty
 *     catalog, and an unreachable proxy.
 * `deepSmokeTest` (opt-in `--deep-smoke`) sends ONE real completion, picking the
 * model from the catalog via resolveSmallToolModel (never a hardcoded id) with a
 * body typed as AnthropicMessagesPayload.
 *
 * We stand up a throwaway HTTP server per case and point the checks at its port,
 * so we exercise the real fetch/response handling without any mock.
 */

import { afterEach, describe, expect, test } from "bun:test"

import type { Model } from "~/services/copilot/get-models"

import { deepSmokeTest, smokeTest } from "~/setup"

let server: ReturnType<typeof Bun.serve> | null = null

afterEach(() => {
  void server?.stop(true)
  server = null
})

function serve(
  handler: (req: Request) => Response | Promise<Response>,
): number {
  server = Bun.serve({ port: 0, fetch: handler })
  return server.port ?? 0
}

/** A minimal tool-capable Claude haiku-class model, as the catalog would list. */
function haikuModel(id: string): Model {
  return {
    id,
    capabilities: {
      family: "claude-haiku",
      supports: { tool_calls: true },
    },
  } as unknown as Model
}

describe("setup smokeTest — GET /models (#225)", () => {
  test("passes on 200 with a non-empty model catalog", async () => {
    const port = serve(() =>
      Response.json({ object: "list", data: [{ id: "gpt-x" }] }),
    )
    const result = await smokeTest(port)
    expect(result.ok).toBe(true)
    expect(result.models).toHaveLength(1)
  })

  test("fails (no throw) on 401 — proxy up but unauthenticated", async () => {
    const port = serve(() => new Response("nope", { status: 401 }))
    expect((await smokeTest(port)).ok).toBe(false)
  })

  test("fails on a 200 with an empty catalog", async () => {
    const port = serve(() => Response.json({ object: "list", data: [] }))
    expect((await smokeTest(port)).ok).toBe(false)
  })

  test("fails on a non-2xx upstream error", async () => {
    const port = serve(() => new Response("boom", { status: 502 }))
    expect((await smokeTest(port)).ok).toBe(false)
  })

  test("fails (no throw) when the proxy is unreachable", async () => {
    // Nothing is listening on this port; fetch rejects and smokeTest catches.
    expect((await smokeTest(1)).ok).toBe(false)
  })

  test("sends no x-api-key (a real 401 is surfaced, not masked)", async () => {
    let sawApiKey = true
    const port = serve((req) => {
      sawApiKey = req.headers.has("x-api-key")
      return Response.json({ object: "list", data: [{ id: "gpt-x" }] })
    })
    await smokeTest(port)
    expect(sawApiKey).toBe(false)
  })
})

describe("setup deepSmokeTest — opt-in completion (#227)", () => {
  test("POSTs a completion whose model comes from the catalog, not a literal", async () => {
    let seenMethod = ""
    let seenPath = ""
    let seenModel: unknown
    const port = serve(async (req) => {
      const body = (await req.json().catch(() => ({}))) as { model?: unknown }
      seenMethod = req.method
      seenPath = new URL(req.url).pathname
      seenModel = body.model
      return Response.json({ ok: true })
    })
    const ok = await deepSmokeTest(port, [haikuModel("claude-haiku-4.9")])
    expect(ok).toBe(true)
    expect(seenMethod).toBe("POST")
    expect(seenPath).toBe("/v1/messages")
    // The model is taken from the catalog, never a hardcoded string.
    expect(seenModel).toBe("claude-haiku-4.9")
  })

  test("fails (no completion sent) when the catalog has no usable model", async () => {
    let posted = false
    const port = serve(() => {
      posted = true
      return Response.json({ ok: true })
    })
    const ok = await deepSmokeTest(port, [])
    expect(ok).toBe(false)
    expect(posted).toBe(false)
  })

  test("fails on a non-2xx completion", async () => {
    const port = serve(() => new Response("bad", { status: 500 }))
    expect(await deepSmokeTest(port, [haikuModel("claude-haiku-4.9")])).toBe(
      false,
    )
  })
})
