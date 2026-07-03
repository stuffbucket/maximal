import { afterEach, describe, expect, it } from "bun:test"

import {
  chooseExecutor,
  InProcessFetchExecutor,
} from "~/routes/messages/web-tools/executor"

const realFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = realFetch
})

function mockFetch(response: Response): void {
  globalThis.fetch = (() =>
    Promise.resolve(response)) as unknown as typeof fetch
}

// Compact synthetic fixture matching html.duckduckgo.com's server-rendered
// results markup (captured shape: rel="nofollow" class="result__a"
// href="//duckduckgo.com/l/?uddg=<url-encoded target>&rut=..."). Real pages
// carry far more markup around each result; the parser only needs the anchor.
const DDG_FIXTURE = `
<div class="results">
  <div class="result results_links results_links_deep web-result">
    <a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fweather.com%2Ftoday&amp;rut=abc">Weather Forecast Today</a>
  </div>
  <div class="result results_links results_links_deep web-result">
    <a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fforecast.weather.gov%2F&amp;rut=def">National Weather Service &amp; Forecast</a>
  </div>
  <div class="result results_links results_links_deep web-result">
    <a rel="nofollow" class="result__a" href="https://example.com/direct">Direct link (no redirect wrapper)</a>
  </div>
</div>
`

describe("InProcessFetchExecutor.search — DuckDuckGo HTML scrape", () => {
  it("parses titles and decodes the uddg-wrapped redirect target", async () => {
    mockFetch(new Response(DDG_FIXTURE, { status: 200 }))
    const result = await new InProcessFetchExecutor().search("weather today")

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.items).toEqual([
      {
        url: "https://weather.com/today",
        title: "Weather Forecast Today",
        page_age: null,
      },
      {
        url: "https://forecast.weather.gov/",
        title: "National Weather Service & Forecast",
        page_age: null,
      },
      {
        url: "https://example.com/direct",
        title: "Direct link (no redirect wrapper)",
        page_age: null,
      },
    ])
  })

  it("caps results at maxResults", async () => {
    mockFetch(new Response(DDG_FIXTURE, { status: 200 }))
    const result = await new InProcessFetchExecutor().search("weather", {
      maxResults: 1,
    })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.items).toHaveLength(1)
  })

  it("returns unavailable on a non-2xx response", async () => {
    mockFetch(new Response("", { status: 500 }))
    const result = await new InProcessFetchExecutor().search("weather")
    expect(result).toEqual({ ok: false, code: "unavailable" })
  })

  it("returns too_many_requests on a 429", async () => {
    mockFetch(new Response("", { status: 429 }))
    const result = await new InProcessFetchExecutor().search("weather")
    expect(result).toEqual({ ok: false, code: "too_many_requests" })
  })

  it("returns unavailable when fetch itself throws (network error)", async () => {
    globalThis.fetch = (() =>
      Promise.reject(new Error("network down"))) as unknown as typeof fetch
    const result = await new InProcessFetchExecutor().search("weather")
    expect(result).toEqual({ ok: false, code: "unavailable" })
  })

  it("returns an empty list (not an error) when the page has no result anchors", async () => {
    mockFetch(new Response("<div>no results</div>", { status: 200 }))
    const result = await new InProcessFetchExecutor().search("gibberish query")
    expect(result).toEqual({ ok: true, items: [] })
  })
})

describe("chooseExecutor — diagnostic notes reflect the no-key fallback", () => {
  it("mentions DuckDuckGo (no key) when OLLAMA_API_KEY is unset", () => {
    const choice = chooseExecutor({})
    expect(choice.kind).toBe("InProcessFetchExecutor")
    if (choice.kind !== "InProcessFetchExecutor") return
    expect(choice.notes).toContain("DuckDuckGo")
    expect(choice.notes).toContain("OLLAMA_API_KEY")
  })
})
