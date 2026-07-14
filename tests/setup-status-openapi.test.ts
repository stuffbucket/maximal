import { describe, expect, test } from "bun:test"

import { server } from "~/server"

/**
 * Proof-of-shape tests for the maximal product OpenAPI surface.
 *
 * Two guarantees:
 *  (a) `/setup-status` still returns its original runtime shape after the
 *      migration to @hono/zod-openapi (no behaviour regression), and
 *  (b) `/openapi.json` is a valid document scoped to the product surface,
 *      exposes the `/setup-status` path, and references a `SetupStatus`
 *      component schema. Because the operation is generated from the same
 *      `createRoute` definition the handler answers, (b) is the
 *      DRIFT-BINDING check: the spec cannot describe a shape the route
 *      doesn't serve.
 */

interface SetupCheck {
  ok: boolean
  reason?: string
  path?: string
}

interface SetupStatusBody {
  ready: boolean
  checks: {
    appDir: SetupCheck
    config: SetupCheck
    db: SetupCheck
    githubAuth: SetupCheck
  }
  nextStep: string | null
}

describe("GET /setup-status (post-OpenAPI-migration)", () => {
  test("returns 200 with the original response shape", async () => {
    const res = await server.request("/setup-status")
    expect(res.status).toBe(200)
    expect(res.headers.get("content-type")).toContain("application/json")

    const body = (await res.json()) as SetupStatusBody

    // Top-level contract: exactly ready / checks / nextStep.
    expect(Object.keys(body).sort()).toEqual(["checks", "nextStep", "ready"])
    expect(typeof body.ready).toBe("boolean")
    expect(body.nextStep === null || typeof body.nextStep === "string").toBe(
      true,
    )

    // All four ordered checks are present, each an { ok: boolean } record.
    expect(Object.keys(body.checks).sort()).toEqual([
      "appDir",
      "config",
      "db",
      "githubAuth",
    ])
    for (const check of Object.values(body.checks)) {
      expect(typeof check.ok).toBe("boolean")
    }
  })
})

describe("GET /openapi.json (drift-binding)", () => {
  test("serves a valid product OpenAPI document", async () => {
    const res = await server.request("/openapi.json")
    expect(res.status).toBe(200)
    expect(res.headers.get("content-type")).toContain("application/json")

    const doc = (await res.json()) as {
      openapi: string
      info: { title: string; version: string }
      paths: Record<string, unknown>
      components?: { schemas?: Record<string, unknown> }
    }

    expect(doc.openapi).toMatch(/^3\./)
    expect(doc.info.title).toBe("maximal product API")
    expect(doc.info.version.length).toBeGreaterThan(0)
  })

  test("exposes the /setup-status path bound to the SetupStatus schema", async () => {
    const res = await server.request("/openapi.json")
    const doc = (await res.json()) as {
      paths: Record<
        string,
        {
          get?: {
            responses?: Record<
              string,
              {
                content?: Record<string, { schema?: { $ref?: string } }>
              }
            >
          }
        }
      >
      components?: { schemas?: Record<string, unknown> }
    }

    // The product path exists...
    expect(doc.paths).toHaveProperty("/setup-status")
    const ok = doc.paths["/setup-status"].get?.responses?.["200"]
    const schema = ok?.content?.["application/json"]?.schema
    // ...and its 200 response is bound (by $ref) to the SetupStatus schema,
    // not an inline duplicate that could drift.
    expect(schema?.$ref).toBe("#/components/schemas/SetupStatus")

    // The component schema for the response actually exists.
    expect(doc.components?.schemas).toHaveProperty("SetupStatus")
  })

  test("is scoped to the product surface only — no mirrored/completion endpoints", async () => {
    const res = await server.request("/openapi.json")
    const doc = (await res.json()) as { paths: Record<string, unknown> }

    // Exactly the one product endpoint for this proof.
    expect(Object.keys(doc.paths)).toEqual(["/setup-status"])

    // Belt-and-braces: none of the proxy/mirror surfaces leaked in.
    const forbidden =
      /chat\/completions|\/messages|\/responses|\/embeddings|\/models|\/usage|\/token-usage/
    for (const path of Object.keys(doc.paths)) {
      expect(path).not.toMatch(forbidden)
    }
  })
})
