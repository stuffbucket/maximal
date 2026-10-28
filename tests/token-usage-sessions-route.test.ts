import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { Hono } from "hono"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import {
  requestContext,
  type RequestUsageMeta,
} from "~/lib/http/request-context"
import { traceIdMiddleware } from "~/lib/http/trace"
import { closeUsageStore, recordTokenUsageEvent } from "~/lib/token-usage"
import { __resetInFlightForTests } from "~/lib/token-usage/in-flight"
import { SessionsResponse } from "~/lib/token-usage/sessions-schema"
import { tokenUsageRoute } from "~/routes/token-usage/route"

const DB_PATH_ENV = "COPILOT_API_SQLITE_DB_PATH"

let home: string

beforeEach(async () => {
  await closeUsageStore()
  // A fresh store file per test, so rows from other files never leak in.
  home = fs.mkdtempSync(path.join(os.tmpdir(), "maximal-sessions-route-"))
  process.env[DB_PATH_ENV] = path.join(home, "copilot-api.sqlite")
  __resetInFlightForTests()
})

afterEach(async () => {
  await closeUsageStore()
  Reflect.deleteProperty(process.env, DB_PATH_ENV)
  fs.rmSync(home, { recursive: true, force: true })
})

function record(sessionId: string, usage: RequestUsageMeta): void {
  requestContext.run(
    {
      parentSessionId: undefined,
      sessionAffinity: undefined,
      startTime: Date.now(),
      traceId: `trace-${sessionId}-${Math.random().toString(36).slice(2)}`,
      usage,
      userAgent: "test",
    },
    () => {
      recordTokenUsageEvent({
        endpoint: "messages",
        input_tokens: 10,
        output_tokens: 5,
        model: "claude-sonnet-4",
        sessionId,
        source: "copilot",
      })
    },
  )
}

async function fetchSessions(): Promise<SessionsResponse> {
  const app = new Hono()
  app.use(traceIdMiddleware)
  app.route("/token-usage", tokenUsageRoute)
  const response = await app.request("/token-usage/sessions")
  expect(response.status).toBe(200)
  return SessionsResponse.parse(await response.json())
}

describe("GET /token-usage/sessions", () => {
  test("serves one row per session with its cache state", async () => {
    record("warm-session", { cacheTtlS: 300, cacheTtlRequested: true })
    record("warm-session", { cacheTtlS: 300, cacheTtlRequested: true })
    record("cold-session", { cacheTtlS: 0, cacheTtlRequested: false })

    const body = await fetchSessions()

    expect(body.sessions).toHaveLength(2)
    const byId = new Map(body.sessions.map((s) => [s.id, s]))
    const warm = byId.get("warm-session")
    expect(warm?.state).toBe("warm")
    expect(warm?.request_count).toBe(2)
    expect(warm?.total_tokens).toBe(30)
    expect(warm?.cache.confidence).toBe("requested")
    expect(warm?.cache.downgraded).toBe(false)
    expect(byId.get("cold-session")?.state).toBe("cold")
    expect(body.flow_per_min).toBe(45)
  })

  test("serves an empty list when nothing was recorded", async () => {
    const body = await fetchSessions()
    expect(body).toEqual({ flow_per_min: 0, sessions: [] })
  })
})
