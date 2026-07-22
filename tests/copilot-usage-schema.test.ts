import { afterEach, describe, expect, test } from "bun:test"

import { getCopilotUsage } from "~/services/github/get-copilot-usage"

/**
 * Regression guard for the Copilot-usage boundary. `/copilot_internal/user` is an
 * undocumented internal endpoint whose payload varies by account type, and GitHub
 * has already retired a quota key (#311). The validated boundary MUST stay lenient
 * — a valid-but-lean response (missing `quota_snapshots`, a null snapshots map, a
 * snapshot missing `chat`/`completions`, or absent metadata fields) must parse,
 * not throw, or it breaks the very usage view the validation protects.
 */
const realFetch = globalThis.fetch
afterEach(() => {
  globalThis.fetch = realFetch
})

function respondWith(body: unknown): void {
  globalThis.fetch = (() =>
    Promise.resolve(
      new Response(JSON.stringify(body), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    )) as unknown as typeof fetch
}

const QUOTA = {
  entitlement: 300,
  overage_count: 0,
  overage_permitted: false,
  percent_remaining: 62,
  quota_id: "premium",
  quota_remaining: 186,
  remaining: 186,
  unlimited: false,
}

describe("getCopilotUsage boundary tolerates valid-but-lean responses", () => {
  test("a response with no quota_snapshots does not throw", async () => {
    respondWith({ login: "octocat", copilot_plan: "individual" })
    const usage = await getCopilotUsage("tok")
    expect(usage.quota_snapshots).toBeUndefined()
  })

  test("quota_snapshots: null does not throw", async () => {
    respondWith({ quota_snapshots: null })
    const usage = await getCopilotUsage("tok")
    expect(usage.quota_snapshots).toBeNull()
  })

  test("a snapshot missing chat/completions parses; unknown keys pass through", async () => {
    respondWith({
      quota_snapshots: {
        premium_interactions: QUOTA,
        some_future_quota: { unlimited: true },
      },
    })
    const usage = await getCopilotUsage("tok")
    expect(usage.quota_snapshots?.completions).toBeUndefined()
    expect(usage.quota_snapshots?.premium_interactions?.remaining).toBe(186)
  })

  test("omitting the previously-required metadata fields does not throw", async () => {
    respondWith({ login: "u", quota_snapshots: {} })
    const usage = await getCopilotUsage("tok")
    expect(usage).toBeDefined()
  })
})
