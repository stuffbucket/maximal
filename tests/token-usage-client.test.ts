import { describe, expect, test } from "bun:test"
import { Hono } from "hono"

import { HELPER_LABEL } from "../src/apps/claude-code/config"
import { DESKTOP_KEY_LABEL } from "../src/apps/claude-desktop/config"
import { CODEX_KEY_LABEL } from "../src/apps/codex/config"
import { createAuthMiddleware } from "../src/lib/auth/request-auth"
import { requestContext } from "../src/lib/http/request-context"
import { traceIdMiddleware } from "../src/lib/http/trace"
import { deriveUsageClient } from "../src/lib/token-usage/client"

describe("deriveUsageClient", () => {
  test("matches the exact labels the integrations provision", () => {
    expect(deriveUsageClient(HELPER_LABEL, "")).toBe("claude-code")
    expect(deriveUsageClient(DESKTOP_KEY_LABEL, "")).toBe("claude-desktop")
    expect(deriveUsageClient(CODEX_KEY_LABEL, "")).toBe("codex")
  })

  test("falls back to the Claude user agent when the label is not ours", () => {
    expect(
      deriveUsageClient("My renamed key", "claude-cli/2.1.0 (external, cli)"),
    ).toBe("claude-code")
  })

  test("reports other for anything unrecognised", () => {
    expect(deriveUsageClient(null, "curl/8")).toBe("other")
    expect(deriveUsageClient("Maximal Settings", "")).toBe("other")
  })
})

describe("request context usage", () => {
  test("starts empty and gains the api key label once auth allows", async () => {
    let before: unknown
    let after: unknown
    const app = new Hono()
    app.use(traceIdMiddleware)
    app.use((_c, next) => {
      before = { ...requestContext.getStore()?.usage }
      return next()
    })
    app.use(
      createAuthMiddleware({
        getApiKeys: () => [],
        isEnforcing: () => false,
      }),
    )
    app.get("/x", (c) => {
      after = { ...requestContext.getStore()?.usage }
      return c.text("ok")
    })

    const response = await app.request("/x")
    expect(response.status).toBe(200)
    expect(before).toEqual({})
    expect(after).toEqual({ apiKeyLabel: null })
  })
})
