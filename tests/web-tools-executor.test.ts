import { afterEach, describe, expect, it } from "bun:test"

import {
  chooseExecutor,
  CopilotResponsesExecutor,
  harvestResponsesHits,
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

describe("chooseExecutor — precedence", () => {
  it("prefers OllamaWebExecutor when OLLAMA_API_KEY is set (over Copilot)", () => {
    const choice = chooseExecutor(
      { OLLAMA_API_KEY: "k" },
      { responsesModel: "gpt-5-mini" },
    )
    expect(choice.kind).toBe("OllamaWebExecutor")
  })

  it("uses CopilotResponsesExecutor when no key but a /responses model exists", () => {
    const choice = chooseExecutor({}, { responsesModel: "gpt-5-mini" })
    expect(choice.kind).toBe("CopilotResponsesExecutor")
    if (choice.kind !== "CopilotResponsesExecutor") return
    expect(choice.model).toBe("gpt-5-mini")
    expect(choice.notes).toContain("Copilot")
    expect(choice.notes).toContain("gpt-5-mini")
  })

  it("falls back to DuckDuckGo when no key and no /responses model", () => {
    const choice = chooseExecutor({}, {})
    expect(choice.kind).toBe("InProcessFetchExecutor")
    if (choice.kind !== "InProcessFetchExecutor") return
    expect(choice.notes).toContain("DuckDuckGo")
    expect(choice.notes).toContain("OLLAMA_API_KEY")
  })
})

// Minimal stand-in for the createResponses return shape the executor reads.
function fakeCreateResponses(result: unknown) {
  return () => Promise.resolve(result as never)
}

describe("CopilotResponsesExecutor.search — harvest from /responses", () => {
  it("harvests cited (title+url) then raw sources, deduped and capped", async () => {
    const responsesResult = {
      output: [
        {
          type: "web_search_call",
          action: {
            sources: [
              { type: "url", url: "https://a.example/raw1" },
              { type: "url", url: "https://cited.example/x" }, // dup of cited
              { type: "url", url: "https://b.example/raw2" },
            ],
          },
        },
        {
          type: "message",
          content: [
            {
              type: "output_text",
              text: "answer",
              annotations: [
                {
                  type: "url_citation",
                  url: "https://cited.example/x",
                  title: "Cited X",
                },
              ],
            },
          ],
        },
      ],
    }
    const exec = new CopilotResponsesExecutor({
      model: "gpt-5-mini",
      createResponsesFn: fakeCreateResponses(responsesResult),
    })
    const result = await exec.search("anything", { maxResults: 3 })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    // Cited hit first (has a real title), then raw URLs backfill; the dup
    // of the cited URL is dropped.
    expect(result.items).toEqual([
      { url: "https://cited.example/x", title: "Cited X", page_age: null },
      {
        url: "https://a.example/raw1",
        title: "https://a.example/raw1",
        page_age: null,
      },
      {
        url: "https://b.example/raw2",
        title: "https://b.example/raw2",
        page_age: null,
      },
    ])
  })

  it("returns unavailable when createResponses throws", async () => {
    const exec = new CopilotResponsesExecutor({
      model: "gpt-5-mini",
      createResponsesFn: () => Promise.reject(new Error("boom")),
    })
    expect(await exec.search("q")).toEqual({ ok: false, code: "unavailable" })
  })

  it("returns unavailable on a non-object / streamed result", async () => {
    const exec = new CopilotResponsesExecutor({
      model: "gpt-5-mini",
      createResponsesFn: fakeCreateResponses({ notOutput: true }),
    })
    expect(await exec.search("q")).toEqual({ ok: false, code: "unavailable" })
  })

  it("delegates fetch() to the injected fetch executor", async () => {
    const calls: Array<string> = []
    const exec = new CopilotResponsesExecutor({
      model: "gpt-5-mini",
      createResponsesFn: fakeCreateResponses({ output: [] }),
      fetchExecutor: {
        fetch: (url: string) => {
          calls.push(url)
          return Promise.resolve({ ok: true, markdown: "md" })
        },
        search: () => Promise.resolve({ ok: true, items: [] }),
      },
    })
    const r = await exec.fetch("https://example.com")
    expect(calls).toEqual(["https://example.com"])
    expect(r).toEqual({ ok: true, markdown: "md" })
  })
})

describe("harvestResponsesHits — defensive parsing", () => {
  it("returns [] for a result with no output array", () => {
    expect(harvestResponsesHits({}, 5)).toEqual([])
  })

  it("skips malformed annotations and sources without url", () => {
    const hits = harvestResponsesHits(
      {
        output: [
          {
            type: "message",
            content: [
              {
                type: "output_text",
                annotations: [
                  { type: "url_citation" }, // no url → skipped
                  { type: "other", url: "https://nope.example" }, // wrong type
                  {
                    type: "url_citation",
                    url: "https://ok.example",
                    title: "OK",
                  },
                ],
              },
            ],
          },
          {
            type: "web_search_call",
            action: { sources: [{ type: "url" }, "not-an-object"] },
          },
        ],
      },
      5,
    )
    expect(hits).toEqual([
      { url: "https://ok.example", title: "OK", page_age: null },
    ])
  })
})
