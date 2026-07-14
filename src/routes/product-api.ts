import { OpenAPIHono } from "@hono/zod-openapi"

import { BUILD_VERSION } from "~/lib/update/build-info"
import { setupStatusRoute } from "~/routes/setup-status"

/**
 * The maximal-specific *product* API surface and its OpenAPI document.
 *
 * Scope is deliberately narrow: this document describes only the
 * endpoints that are maximal's own product contract (right now just
 * `/setup-status`). It intentionally EXCLUDES the OpenAI-/Anthropic-
 * mirrored completion, model, embedding, responses, and SSE endpoints —
 * those mirror upstream provider specs and are out of scope for a
 * maximal-authored spec. See ADR-0018 (OpenAPI client-facing scope).
 *
 * Because each operation is registered from its `createRoute` definition
 * (which shares the same Zod schema the handler returns), the generated
 * document is route-bound and cannot drift from the runtime behaviour.
 */
export const productApiRoutes = new OpenAPIHono()

/**
 * The complete set of paths the product OpenAPI doc may expose. Any new
 * product endpoint MUST be added here AND mounted below; the test in
 * tests/setup-status-openapi.test.ts asserts `doc.paths` === this set, so
 * mounting an endpoint without listing it here (or vice versa) reds the
 * build. This keeps the scope closed-world per ADR-0018.
 */
export const PRODUCT_ENDPOINTS = ["/setup-status"] as const

// Mount the product endpoints. The operation `setupStatusRoute` defines
// at path "/" becomes "/setup-status" here, and its OpenAPI registry is
// merged into this app so `/openapi.json` picks it up.
productApiRoutes.route("/setup-status", setupStatusRoute)

// The generated document, scoped to the product surface above.
productApiRoutes.doc("/openapi.json", {
  openapi: "3.1.0",
  info: {
    title: "maximal product API",
    version: BUILD_VERSION,
    description:
      "maximal-specific product endpoints. Does not cover the "
      + "OpenAI-/Anthropic-compatible proxy endpoints, which mirror "
      + "upstream provider specs.",
  },
})
