import { cleanup, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, test } from "bun:test"

import { Usage } from "../src/ui/features/usage/Usage"

/**
 * Render tests for the reworked Usage island
 * (shell/src/ui/features/usage/Usage.tsx). These exercise the three top-level
 * branches (loading / no-data+error / content) by stubbing the only boundary the
 * hook touches: `fetch` to /token-usage, /token-usage/series,
 * /token-usage/events, and /usage. No pixels are asserted — this catches render
 * crashes and wrong-state output, not visual drift.
 */

const realFetch = globalThis.fetch

type Route = { ok?: boolean; status?: number; body?: unknown }

/** Install a fetch stub that matches by URL prefix. More specific paths (e.g.
 *  /token-usage/events) must be listed before their parents (/token-usage). */
function stubFetch(routes: Array<[string, Route]>): void {
  globalThis.fetch = ((input: string | URL) => {
    const url = String(input)
    for (const [prefix, r] of routes) {
      if (url.includes(prefix)) {
        return Promise.resolve({
          ok: r.ok ?? true,
          status: r.status ?? 200,
          json: () => Promise.resolve(r.body),
        } as Response)
      }
    }
    return Promise.reject(new Error(`unmocked fetch: ${url}`))
  }) as typeof fetch
}

/** A complete, well-shaped set of endpoint bodies for the content branch. */
function contentRoutes(): Array<[string, Route]> {
  return [
    [
      "/token-usage/series",
      {
        body: {
          buckets: [
            {
              bucket_start_ms: 0,
              input_tokens: 1000,
              output_tokens: 234,
              cache_read_input_tokens: 0,
              cache_creation_input_tokens: 0,
              total_tokens: 1234,
              total_nano_aiu: 0,
              request_count: 5,
            },
          ],
          bucket_ms: 3_600_000,
          period: "day",
          range: { start_ms: 0, start_utc: "", end_ms: 1, end_utc: "" },
        },
      },
    ],
    ["/token-usage/events", { body: { items: [], page: 1, total_pages: 1 } }],
    [
      "/token-usage",
      {
        body: {
          totals: {
            cache_creation_input_tokens: 0,
            cache_read_input_tokens: 0,
            input_tokens: 1000,
            output_tokens: 234,
            request_count: 5,
            total_tokens: 1234,
            total_nano_aiu: 0,
          },
          byModel: [
            {
              model: "gpt-4o",
              cache_creation_input_tokens: 0,
              cache_read_input_tokens: 0,
              input_tokens: 1000,
              output_tokens: 234,
              request_count: 5,
              total_tokens: 1234,
              total_nano_aiu: 0,
              is_premium: null,
            },
          ],
          byProvider: [
            {
              source: "copilot",
              provider_name: null,
              provider: "copilot",
              cache_creation_input_tokens: 0,
              cache_read_input_tokens: 0,
              input_tokens: 1000,
              output_tokens: 234,
              request_count: 5,
              total_tokens: 1234,
              total_nano_aiu: 0,
            },
          ],
          period: "day",
          range: { start_ms: 0, start_utc: "", end_ms: 1, end_utc: "" },
        },
      },
    ],
    ["/usage", { body: { quota_snapshots: null } }],
  ]
}

afterEach(() => {
  cleanup()
  globalThis.fetch = realFetch
})

describe("Usage island", () => {
  test("shows the loading state before data arrives", () => {
    // A fetch that never settles keeps the hook in its initial loading state.
    globalThis.fetch = (() =>
      new Promise<Response>(() => {})) as unknown as typeof fetch

    render(<Usage />)

    expect(screen.getByText("Loading usage…")).toBeDefined()
  })

  test("renders the summary, live hero, and breakdown once data loads", async () => {
    stubFetch(contentRoutes())

    render(<Usage />)

    // The person-first summary line renders the totals; the model shows in the
    // breakdown. findBy* retries until the effect-driven load resolves.
    expect(await screen.findByLabelText("Live traffic")).toBeDefined()
    // The model appears in both the ranked breakdown and the detail table.
    expect(screen.getAllByText("gpt-4o").length).toBeGreaterThan(0)
    // GitHub Copilot provider card is present (provider-forward).
    expect(screen.getByText("GitHub Copilot")).toBeDefined()
    // The four period tabs are always present.
    expect(screen.getAllByRole("tab")).toHaveLength(4)
  })

  test("surfaces an error and the no-data state when the summary fetch fails", async () => {
    stubFetch([
      ["/token-usage/series", { ok: false, status: 500 }],
      ["/token-usage/events", { ok: false, status: 500 }],
      ["/token-usage", { ok: false, status: 500 }],
      ["/usage", { ok: false, status: 500 }],
    ])

    render(<Usage />)

    const alert = await screen.findByRole("alert")
    expect(alert.textContent).toContain("load usage")
    expect(screen.getByText("No usage data.")).toBeDefined()
  })
})
