import { act, cleanup, render, screen, within } from "@testing-library/react"
import { afterEach, describe, expect, test } from "bun:test"

import { Usage } from "../src/ui/features/usage/Usage"

/**
 * Render tests for the reworked Usage island
 * (shell/src/ui/features/usage/Usage.tsx). These exercise the three top-level
 * branches (loading / no-data+error / content) by stubbing the only boundary the
 * hook touches: `fetch` to /token-usage, /token-usage/series,
 * /token-usage/events, and /usage. The content branch also asserts the five live
 * trackers render and that a `maximal:usage-refresh` WS frame ticks them. No
 * pixels are asserted — this catches render crashes and wrong-state output.
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

/** Dispatch a `maximal:usage-refresh` WS frame carrying one just-recorded
 *  request, mirroring what main.ts forwards on each live `usage` event. */
function dispatchUsageFrame(last: {
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheCreationTokens: number
  totalTokens: number
}): void {
  act(() => {
    globalThis.dispatchEvent(
      new CustomEvent("maximal:usage-refresh", {
        detail: {
          periodStart: "",
          periodEnd: "",
          requestCount: 1,
          totalTokens: last.totalTokens,
          inputTokens: last.inputTokens,
          outputTokens: last.outputTokens,
          cacheReadTokens: last.cacheReadTokens,
          cacheCreationTokens: last.cacheCreationTokens,
          lastEvent: {
            model: "gpt-4o",
            source: "copilot",
            providerName: null,
            endpoint: "chat_completions",
            createdAtMs: Date.now(),
            ...last,
          },
        },
      }),
    )
  })
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

  test("renders the five live trackers, graph, and breakdown once data loads", async () => {
    stubFetch(contentRoutes())

    render(<Usage />)

    // The near-term live hero section (its numbers live in the tracker strip).
    expect(
      await screen.findByLabelText("Token traffic — last hour"),
    ).toBeDefined()
    // The five trackers render as one labeled stat row, in fixed order.
    const trackers = screen.getByRole("group", { name: "Live token counters" })
    for (const label of [
      "Input",
      "Output",
      "Cached input",
      "Cached output",
      "Total",
    ]) {
      expect(within(trackers).getByText(label)).toBeDefined()
    }
    // The model appears in both the ranked breakdown and the detail table.
    expect(screen.getAllByText("gpt-4o").length).toBeGreaterThan(0)
    // GitHub Copilot provider card is present (provider-forward).
    expect(screen.getByText("GitHub Copilot")).toBeDefined()
    // The four period tabs are always present.
    expect(screen.getAllByRole("tab")).toHaveLength(4)
  })

  test("a live usage-refresh frame ticks the Total and Input counters", async () => {
    stubFetch(contentRoutes())

    render(<Usage />)
    await screen.findByLabelText("Token traffic — last hour")

    // Baseline: summary input 1000, total 1234. A live frame adds its delta on
    // top of the summary (input +300 → 1,300; total +500 → 1,734). These
    // strings are unique to the trackers — the summary line stays at 1,234.
    dispatchUsageFrame({
      inputTokens: 300,
      outputTokens: 150,
      cacheReadTokens: 20,
      cacheCreationTokens: 10,
      totalTokens: 500,
    })

    expect(await screen.findByText("1,734")).toBeDefined()
    expect(await screen.findByText("1,300")).toBeDefined()
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
