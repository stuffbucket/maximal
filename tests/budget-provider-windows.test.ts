import { afterEach, beforeEach, describe, expect, test } from "bun:test"

import {
  copilotWindowsFromHeaders,
  copilotWindowsFromUsage,
  normalizeResetAt,
} from "~/lib/budget/copilot-windows"
import {
  __resetProviderWindowsForTests,
  listProviderWindows,
  observeProviderWindows,
  type ProviderQuotaWindow,
} from "~/lib/budget/provider-windows"
import { HTTPError } from "~/lib/errors/http-errors"
import { closeUsageStore } from "~/lib/token-usage"
import { finishUpstreamResponse } from "~/services/copilot/upstream-request"

const DB_PATH_ENV = "COPILOT_API_SQLITE_DB_PATH"
const OBSERVED = "2026-11-10T12:00:00.000Z"

beforeEach(async () => {
  process.env[DB_PATH_ENV] = ":memory:"
  await closeUsageStore()
  __resetProviderWindowsForTests()
})

afterEach(async () => {
  await closeUsageStore()
  __resetProviderWindowsForTests()
  Reflect.deleteProperty(process.env, DB_PATH_ENV)
})

describe("Copilot quota headers", () => {
  test("each x-quota-snapshot header becomes a window", () => {
    const headers = new Headers({
      "x-quota-snapshot-premium_interactions":
        "ent=300&ov=0.0&ovPerm=false&rem=82.9&rst=2026-12-01T00%3A00%3A00Z&crUsed=50&totRem=250",
      "x-quota-snapshot-chat": "ent=-1&rem=100&rst=1798761600",
      "x-usage-ratelimit-session": "rem=10&rst=1",
      "content-type": "application/json",
    })
    const windows = copilotWindowsFromHeaders(headers, OBSERVED)
    const byId = new Map(windows.map((window) => [window.id, window]))
    expect([...byId.keys()].sort()).toEqual(["chat", "premium_interactions"])
    expect(byId.get("premium_interactions")).toEqual({
      provider: "copilot",
      id: "premium_interactions",
      label: "Copilot premium allowance",
      unit: "credits",
      used: 50,
      limit: 300,
      percentRemaining: 82.9,
      resetsAt: "2026-12-01T00:00:00.000Z",
      kind: "fixed",
      overage: { used: 0, permitted: false },
      observedAt: OBSERVED,
      source: "header",
    })
    const chat = byId.get("chat")
    expect(chat?.limit).toBeUndefined()
    expect(chat?.unit).toBe("requests")
    expect(chat?.resetsAt).toBe("2027-01-01T00:00:00.000Z")
    expect(chat?.overage).toBeUndefined()
  })

  test("resets parse from ISO, dates and epochs", () => {
    expect(normalizeResetAt("2026-12-01")).toBe("2026-12-01T00:00:00.000Z")
    expect(normalizeResetAt("1798761600")).toBe("2027-01-01T00:00:00.000Z")
    expect(normalizeResetAt("1798761600000")).toBe("2027-01-01T00:00:00.000Z")
    expect(normalizeResetAt("soon")).toBeUndefined()
    expect(normalizeResetAt("")).toBeUndefined()
    expect(normalizeResetAt(null)).toBeUndefined()
  })

  test("finishUpstreamResponse records them on success and on errors", async () => {
    const quota = {
      "x-quota-snapshot-premium_interactions":
        "ent=300&rem=80&rst=2026-12-01T00:00:00Z",
    }
    const ok = new Response(JSON.stringify({ ok: true }), {
      headers: { "content-type": "application/json", ...quota },
    })
    await finishUpstreamResponse(ok, {
      stream: false,
      errorMessage: "test",
      call: { endpoint: "/chat/completions", model: "gpt-test" },
    })
    const windows = await listProviderWindows()
    expect(windows.map((window) => window.id)).toEqual(["premium_interactions"])
    expect(windows[0].percentRemaining).toBe(80)

    const failed = new Response("{}", {
      status: 400,
      headers: {
        "x-quota-snapshot-premium_interactions":
          "ent=300&rem=79&rst=2026-12-01T00:00:00Z",
      },
    })
    const error: unknown = await finishUpstreamResponse(failed, {
      stream: false,
      errorMessage: "test",
      call: { endpoint: "/chat/completions", model: "gpt-test" },
    }).catch((rejection: unknown) => rejection)
    expect(error).toBeInstanceOf(HTTPError)
    expect((await listProviderWindows())[0].percentRemaining).toBe(79)
  })
})

describe("Copilot usage snapshots", () => {
  test("quota_snapshots become windows sharing quota_reset_date", () => {
    const windows = copilotWindowsFromUsage(
      {
        login: "octo",
        quota_reset_date: "2026-12-01",
        quota_snapshots: {
          premium_interactions: {
            entitlement: 300,
            remaining: 250,
            percent_remaining: 83.3,
            overage_count: 0,
            overage_permitted: true,
            unlimited: false,
          },
          chat: { entitlement: 0, remaining: 0, unlimited: true },
          broken: "not an object",
        },
      },
      OBSERVED,
    )
    expect(windows).toHaveLength(2)
    const premium = windows.find(
      (window) => window.id === "premium_interactions",
    )
    expect(premium).toMatchObject({
      used: 50,
      limit: 300,
      percentRemaining: 83.3,
      resetsAt: "2026-12-01T00:00:00.000Z",
      overage: { used: 0, permitted: true },
      source: "endpoint",
    })
    const chat = windows.find((window) => window.id === "chat")
    expect(chat?.limit).toBeUndefined()
    expect(chat?.used).toBeUndefined()
  })

  test("anything unrecognisable yields no windows", () => {
    expect(copilotWindowsFromUsage(null)).toEqual([])
    expect(copilotWindowsFromUsage({ quota_snapshots: 3 })).toEqual([])
  })
})

function window(resetsAt: string, observedAt: string): ProviderQuotaWindow {
  return {
    provider: "copilot",
    id: "premium_interactions",
    label: "Copilot premium allowance",
    unit: "credits",
    resetsAt,
    kind: "fixed",
    observedAt,
    source: "header",
  }
}

describe("provider window registry", () => {
  test("keeps the latest window and the reset before it across a restart", async () => {
    observeProviderWindows([
      window("2026-12-01T00:00:00.000Z", "2026-11-30T00:00:00.000Z"),
    ])
    observeProviderWindows([
      window("2027-01-01T00:00:00.000Z", "2026-12-01T00:01:00.000Z"),
    ])
    const live = await listProviderWindows()
    expect(live).toHaveLength(1)
    expect(live[0].resetsAt).toBe("2027-01-01T00:00:00.000Z")
    expect(live[0].previousResetsAt).toBe("2026-12-01T00:00:00.000Z")

    // A restart forgets memory; the database still has both resets.
    __resetProviderWindowsForTests()
    // A report that arrives before the reload must not erase the history.
    observeProviderWindows([
      window("2027-01-01T00:00:00.000Z", "2026-12-02T00:00:00.000Z"),
    ])
    const reloaded = await listProviderWindows()
    expect(reloaded).toHaveLength(1)
    expect(reloaded[0]).toMatchObject({
      resetsAt: "2027-01-01T00:00:00.000Z",
      previousResetsAt: "2026-12-01T00:00:00.000Z",
      observedAt: "2026-12-02T00:00:00.000Z",
    })
  })

  test("windows of several providers sort by reference", async () => {
    observeProviderWindows([
      { ...window("2026-12-01T00:00:00.000Z", OBSERVED), id: "weekly" },
      {
        ...window("2026-11-10T15:00:00.000Z", OBSERVED),
        provider: "acme",
        id: "session",
        kind: "rolling",
        durationMs: 18_000_000,
      },
    ])
    const refs = (await listProviderWindows()).map(
      (entry) => `${entry.provider}:${entry.id}`,
    )
    expect(refs).toEqual(["acme:session", "copilot:weekly"])
  })
})
