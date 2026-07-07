/**
 * Forces the schema-validation failure branch in
 * `/settings/api/diagnostics` by monkey-patching `safeParse` on the
 * real `DiagnosticsResponse` zod schema object. The route module
 * captures the schema by reference (named import of an object), so
 * swapping a method on that object affects every subsequent call —
 * no module re-import or `mock.module` indirection needed.
 *
 * Each test installs and restores the patch in its own `try`/finally`,
 * so the surrounding test suite never sees a poisoned schema.
 *
 * Kills the following surviving mutants in src/routes/settings/api.ts:
 *   - L72  `if (!parsed.success)` → `if (false)`           (ConditionalExpression)
 *   - L72  whole `if`-block → `{}`                          (BlockStatement)
 *   - L74  outer error response object → `{}`               (ObjectLiteral)
 *   - L75  inner `error: { ... }` → `error: {}`             (ObjectLiteral)
 *   - L76  message string literal → `""`                    (StringLiteral)
 *   - L77  type string literal → `""`                       (StringLiteral)
 */

import { describe, expect, test } from "bun:test"
import { Hono } from "hono"

import { createAuthMiddleware } from "~/lib/auth/request-auth"
import { DiagnosticsResponse } from "~/lib/config/settings-types"
import { settingsApiRoutes } from "~/routes/settings/api"

const fakeIssues = [
  { code: "invalid_type", path: ["version"], message: "synthetic failure" },
]

function buildApp() {
  const app = new Hono()
  app.use(
    "*",
    createAuthMiddleware({
      getApiKeys: () => [],
      allowUnauthenticatedPaths: ["/", "/usage-viewer"],
    }),
  )
  app.route("/settings/api", settingsApiRoutes)
  return app
}

async function withForcedSchemaFailure<T>(fn: () => Promise<T>): Promise<T> {
  const originalSafeParse =
    DiagnosticsResponse.safeParse.bind(DiagnosticsResponse)
  ;(DiagnosticsResponse as unknown as { safeParse: () => unknown }).safeParse =
    () => ({
      success: false,
      error: { issues: fakeIssues },
    })
  try {
    return await fn()
  } finally {
    ;(
      DiagnosticsResponse as unknown as { safeParse: typeof originalSafeParse }
    ).safeParse = originalSafeParse
  }
}

describe("GET /settings/api/diagnostics — schema-failure branch", () => {
  test("returns HTTP 500 when DiagnosticsResponse.safeParse fails", async () => {
    await withForcedSchemaFailure(async () => {
      const app = buildApp()
      const res = await app.request("/settings/api/diagnostics")
      expect(res.status).toBe(500)
    })
  })

  test("error envelope has exact message, type, and details fields", async () => {
    await withForcedSchemaFailure(async () => {
      const app = buildApp()
      const res = await app.request("/settings/api/diagnostics")
      const body = (await res.json()) as {
        error?: { message?: string; type?: string; details?: unknown }
      }
      // Outer envelope shape: { error: { ... } } — kills the
      // outer-object → {} mutant (would yield body.error === undefined).
      expect(body.error).toBeDefined()
      // Inner shape: kills the inner `error: {}` mutant (which would
      // strip message/type/details).
      expect(body.error?.message).toBe(
        "Diagnostics payload failed schema validation",
      )
      expect(body.error?.type).toBe("internal_error")
      expect(body.error?.details).toEqual(fakeIssues)
    })
  })

  test("restoration: real schema parses a real diagnostics response after the patch is undone", async () => {
    // Guard: if `withForcedSchemaFailure` ever forgets to restore,
    // this test (running after the two above) will start failing in
    // weird ways. Belt-and-braces.
    const app = buildApp()
    const res = await app.request("/settings/api/diagnostics")
    expect(res.status).toBe(200)
  })
})
