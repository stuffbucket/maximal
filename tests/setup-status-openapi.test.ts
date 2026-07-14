import { OpenAPIHono } from "@hono/zod-openapi"
import { describe, expect, test } from "bun:test"

import { SetupStatusSchema } from "~/lib/config/setup-status"
import { forwardError } from "~/lib/errors/error"
import { PRODUCT_ENDPOINTS } from "~/routes/product-api"
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

    // Exactly the product endpoints declared in the closed-world allowlist
    // (single source of truth in routes/product-api.ts).
    expect(Object.keys(doc.paths).sort()).toEqual([...PRODUCT_ENDPOINTS].sort())

    // Belt-and-braces: none of the proxy/mirror surfaces leaked in.
    const forbidden =
      /chat\/completions|\/messages|\/responses|\/embeddings|\/models|\/usage|\/token-usage/
    for (const path of Object.keys(doc.paths)) {
      expect(path).not.toMatch(forbidden)
    }
  })

  test("is served without authentication (public spec)", async () => {
    // No Authorization header, no API key: a fresh install must reach the
    // doc. `/openapi.json` is in server.ts's allowUnauthenticatedPaths.
    const res = await server.request("/openapi.json")
    expect(res.status).toBe(200)
    expect(res.headers.get("content-type")).toContain("application/json")
  })
})

describe("product-API mount does not shadow sibling routes", () => {
  test("sibling routes remain reachable (mount at '/' is not a catch-all)", async () => {
    // `/status` is unauthenticated and served alongside the productApiRoutes
    // mount. If `server.route("/", productApiRoutes)` behaved as a catch-all
    // it would swallow this path; a 200 proves the mount is fall-through.
    const res = await server.request("/status")
    expect(res.status).toBe(200)
  })

  test("an unknown path still 404s (mount is not a catch-all)", async () => {
    const res = await server.request("/definitely-not-a-route")
    expect(res.status).toBe(404)
  })
})

describe("onError → forwardError wiring", () => {
  test("yields a 500 JSON error shape", async () => {
    // Mirror setup-status.ts's error wiring on a throwaway app so we exercise
    // the exact `.onError((e, c) => forwardError(c, e))` contract without
    // mocking the shared evaluateSetup module (see architecture.md → Testing
    // gotchas: no unrestored mock.module on shared modules).
    const probe = new OpenAPIHono()
    probe.get("/boom", () => {
      throw new Error("evaluateSetup failed")
    })
    probe.onError((error, c) => forwardError(c, error))

    const res = await probe.request("/boom")
    expect(res.status).toBe(500)
    const body = (await res.json()) as {
      error?: { message: string; type: string }
    }
    expect(body.error?.type).toBe("error")
    expect(body.error?.message).toContain("evaluateSetup failed")
  })
})

describe("SetupStatusSchema fidelity (interface → Zod migration)", () => {
  test("locks the pre-migration response shape", () => {
    const parsed = SetupStatusSchema.parse({
      ready: false,
      checks: {
        appDir: { ok: true, path: "/x" },
        config: { ok: false, reason: "invalid JSON", path: "/y" },
        db: { ok: true },
        githubAuth: { ok: true },
      },
      nextStep: "config",
    })

    // Exact top-level keys.
    expect(Object.keys(parsed).sort()).toEqual(["checks", "nextStep", "ready"])
    // Exact check keys, in the canonical set.
    expect(Object.keys(parsed.checks).sort()).toEqual(
      ["appDir", "config", "db", "githubAuth"].sort(),
    )
    // Optional detail fields (reason/path) survive the schema.
    expect(parsed.checks.config).toEqual({
      ok: false,
      reason: "invalid JSON",
      path: "/y",
    })
    // nextStep is a nullable enum member, not free-form.
    expect(() =>
      SetupStatusSchema.parse({ ...parsed, nextStep: "not-a-check" }),
    ).toThrow()
  })
})
