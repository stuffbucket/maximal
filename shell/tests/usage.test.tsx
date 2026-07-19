import { cleanup, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, test } from "bun:test"

import { Usage } from "../src/ui/features/usage/Usage"

/**
 * Render tests for the Usage island (shell/src/ui/features/usage/Usage.tsx) —
 * the first island brought under the behavioral render harness. These exercise
 * the three top-level branches (loading / no-data+error / content) by stubbing
 * the only boundary the hook touches: `fetch` to /token-usage, /usage, and
 * /token-usage/events. No pixels are asserted — this catches render crashes and
 * wrong-state output, not visual drift (see the visual-regression follow-up).
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

  test("renders totals and the per-model breakdown once data loads", async () => {
    stubFetch([
      ["/token-usage/events", { body: { items: [], page: 1, total_pages: 1 } }],
      [
        "/token-usage",
        {
          body: {
            totals: {
              total_tokens: 1234,
              request_count: 5,
              total_nano_aiu: 0,
            },
            byModel: [
              {
                model: "gpt-4o",
                total_tokens: 1234,
                input_tokens: 1000,
                output_tokens: 234,
                request_count: 5,
                total_nano_aiu: 0,
              },
            ],
          },
        },
      ],
      ["/usage", { body: { quota_snapshots: null } }],
    ])

    render(<Usage />)

    // Async: the hook loads in an effect; findBy* retries until it appears.
    expect(await screen.findByText("Total tokens")).toBeDefined()
    // 1,234 shows in both the totals tile and the model row — assert it renders.
    expect(screen.getAllByText("1,234").length).toBeGreaterThan(0)
    expect(screen.getByText("gpt-4o")).toBeDefined()
    // The four period tabs are always present.
    expect(screen.getAllByRole("tab")).toHaveLength(4)
  })

  test("surfaces an error and the no-data state when the summary fetch fails", async () => {
    stubFetch([
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
