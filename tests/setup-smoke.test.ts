/**
 * Regression for #225: the first-run smoke test hits GET /models (a catalog
 * check), not a hardcoded /v1/messages completion. It must:
 *   - PASS only on 200 with a non-empty `data[]`,
 *   - FAIL (return false, never throw) on 401, other non-2xx, an empty
 *     catalog, and an unreachable proxy.
 *
 * We stand up a throwaway HTTP server per case and point smokeTest at its
 * port, so we exercise the real fetch/response handling without any mock.
 */

import { afterEach, describe, expect, test } from "bun:test"

import { smokeTest } from "~/setup"

let server: ReturnType<typeof Bun.serve> | null = null

afterEach(() => {
  void server?.stop(true)
  server = null
})

function serve(handler: (req: Request) => Response): number {
  server = Bun.serve({ port: 0, fetch: handler })
  return server.port ?? 0
}

describe("setup smokeTest — GET /models (#225)", () => {
  test("passes on 200 with a non-empty model catalog", async () => {
    const port = serve(() =>
      Response.json({ object: "list", data: [{ id: "gpt-x" }] }),
    )
    expect(await smokeTest(port)).toBe(true)
  })

  test("fails (no throw) on 401 — proxy up but unauthenticated", async () => {
    const port = serve(() => new Response("nope", { status: 401 }))
    expect(await smokeTest(port)).toBe(false)
  })

  test("fails on a 200 with an empty catalog", async () => {
    const port = serve(() => Response.json({ object: "list", data: [] }))
    expect(await smokeTest(port)).toBe(false)
  })

  test("fails on a non-2xx upstream error", async () => {
    const port = serve(() => new Response("boom", { status: 502 }))
    expect(await smokeTest(port)).toBe(false)
  })

  test("fails (no throw) when the proxy is unreachable", async () => {
    // Nothing is listening on this port; fetch rejects and smokeTest catches.
    expect(await smokeTest(1)).toBe(false)
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
