import { afterEach, describe, expect, it } from "bun:test"

import {
  chooseExecutor,
  CopilotResponsesExecutor,
  harvestResponsesHits,
  InProcessFetchExecutor,
  pickResponsesModel,
  withDateHint,
} from "~/routes/messages/web-tools/executor"

const realFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = realFetch
})

function mockFetch(response: Response): void {
  globalThis.fetch = (() =>
    Promise.resolve(response)) as unknown as typeof fetch
}

/** Mock fetch that records the requested URL(s), for asserting query
 *  construction (e.g. injected `site:` operators). */
function mockFetchCapturing(response: Response, urls: Array<string>): void {
  globalThis.fetch = ((input: unknown) => {
    urls.push(String(input))
    return Promise.resolve(response)
  }) as unknown as typeof fetch
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

  it("fully strips nested tags and decodes entities without double-unescaping", async () => {
    // Title carries (a) a nested/split tag a single strip pass would leave
    // residue from, and (b) a double-escaped entity that sequential decoding
    // would wrongly collapse to a raw `<`. Guards the two CodeQL findings.
    const fixture = `
<div class="result">
  <a rel="nofollow" class="result__a" href="https://ex.example/x">A<b>B</b> &amp;lt;tag&gt; <scr<script>ipt>X</a>
</div>
`
    mockFetch(new Response(fixture, { status: 200 }))
    const result = await new InProcessFetchExecutor().search("q")
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.items).toHaveLength(1)
    const title = result.items[0].title
    // No `<` survives — a stray `<` is what could open an injected tag; the
    // fixpoint strip removes all tag-like residue (a lone `>`, e.g. from a
    // legitimately-decoded `&gt;`, can't open a tag, so it's harmless).
    expect(title).not.toContain("<")
    expect(title).not.toContain("<script")
    // `&amp;lt;` stays the literal text `&lt;`, NOT decoded down to `<`.
    expect(title).toContain("&lt;tag")
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

  it("skips non-result anchors, deduplicates URLs, and drops empty titles", async () => {
    // Exercises parseDdgResults guards: the class filter (a nav anchor
    // without result__a), URL dedup (same uddg target twice), and the
    // empty-title skip (anchor whose inner text strips to nothing).
    const fixture = `
      <a class="header__logo" href="https://duckduckgo.com/">DuckDuckGo</a>
      <a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fa.example%2F1">First</a>
      <a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fa.example%2F1">First dup</a>
      <a rel="nofollow" class="result__a" href="https://b.example/2"><img src="x"></a>
      <a rel="nofollow" class="result__a" href="https://c.example/3">Third</a>
    `
    mockFetch(new Response(fixture, { status: 200 }))
    const result = await new InProcessFetchExecutor().search("q")
    expect(result.ok).toBe(true)
    if (!result.ok) return
    // Nav anchor excluded (no result__a); dup dropped; empty-title anchor
    // (b.example) dropped; only the two titled, unique results remain.
    expect(result.items).toEqual([
      { url: "https://a.example/1", title: "First", page_age: null },
      { url: "https://c.example/3", title: "Third", page_age: null },
    ])
  })

  it("stops at maxResults even when more result anchors are present", async () => {
    const fixture = `
      <a rel="nofollow" class="result__a" href="https://a.example/1">One</a>
      <a rel="nofollow" class="result__a" href="https://b.example/2">Two</a>
      <a rel="nofollow" class="result__a" href="https://c.example/3">Three</a>
    `
    mockFetch(new Response(fixture, { status: 200 }))
    const result = await new InProcessFetchExecutor().search("q", {
      maxResults: 2,
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.items.map((i) => i.url)).toEqual([
      "https://a.example/1",
      "https://b.example/2",
    ])
  })

  it("keeps direct http:// result links and drops non-URL hrefs", async () => {
    // resolveDdgResultUrl: the http:// arm (not just https://) is kept; a
    // relative/non-URL href that isn't a duckduckgo redirect is dropped.
    const fixture = `
      <a rel="nofollow" class="result__a" href="http://plain.example/insecure">Insecure</a>
      <a rel="nofollow" class="result__a" href="/relative/path">Relative</a>
    `
    mockFetch(new Response(fixture, { status: 200 }))
    const result = await new InProcessFetchExecutor().search("q")
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.items).toEqual([
      {
        url: "http://plain.example/insecure",
        title: "Insecure",
        page_age: null,
      },
    ])
  })

  it("skips a result anchor that has no href attribute", async () => {
    // parseDdgResults: the `if (!hrefMatch) continue` guard — a result__a
    // anchor with no href at all must be dropped, not crash.
    const fixture = `
      <a rel="nofollow" class="result__a">No href here</a>
      <a rel="nofollow" class="result__a" href="https://ok.example">OK</a>
    `
    mockFetch(new Response(fixture, { status: 200 }))
    const result = await new InProcessFetchExecutor().search("q")
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.items).toEqual([
      { url: "https://ok.example", title: "OK", page_age: null },
    ])
  })

  it("injects DuckDuckGo site:/-site: operators for allowed/blocked domains", async () => {
    const urls: Array<string> = []
    mockFetchCapturing(new Response("<div></div>", { status: 200 }), urls)
    await new InProcessFetchExecutor().search("mountains", {
      allowedDomains: ["en.wikipedia.org", "britannica.com"],
      blockedDomains: ["spam.example"],
    })
    // The q= param carries the query plus an OR-group of site: filters and a
    // -site: exclusion. Decode to assert on the human-readable form.
    const q = new URL(urls[0]).searchParams.get("q")
    expect(q).toBe(
      "mountains (site:en.wikipedia.org OR site:britannica.com) -site:spam.example",
    )
  })

  it("uses a bare site: (no OR-group) for a single allowed domain", async () => {
    const urls: Array<string> = []
    mockFetchCapturing(new Response("<div></div>", { status: 200 }), urls)
    await new InProcessFetchExecutor().search("weather", {
      allowedDomains: ["weather.gov"],
    })
    expect(new URL(urls[0]).searchParams.get("q")).toBe(
      "weather site:weather.gov",
    )
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

// Compact model-descriptor builder for pickResponsesModel cases.
const modelDesc = (id: string, supportsResponses = true) => ({
  id,
  supportsResponses,
})

describe("pickResponsesModel — resilient to model churn", () => {
  const m = modelDesc

  it("returns undefined when no model supports /responses (e.g. Claude-only)", () => {
    expect(
      pickResponsesModel(
        [m("claude-sonnet-5", false), m("claude-haiku-4.5", false)],
        "gpt-5-mini",
      ),
    ).toBeUndefined()
  })

  it("honors the configured small model when it supports /responses", () => {
    expect(
      pickResponsesModel([m("gpt-5-mini"), m("gpt-5.5")], "gpt-5-mini"),
    ).toBe("gpt-5-mini")
  })

  it("falls through to a mini-class model when the configured one is gone", () => {
    // gpt-5-mini deprecated / absent from the live catalog → pick the
    // current mini-class model by pattern, not the frozen id.
    expect(
      pickResponsesModel(
        [m("gpt-5.3-codex"), m("gpt-6-mini"), m("gpt-6")],
        "gpt-5-mini",
      ),
    ).toBe("gpt-6-mini")
  })

  it("falls through to any /responses model when no mini-class exists", () => {
    expect(
      pickResponsesModel([m("gpt-5.3-codex"), m("gpt-5.5")], "gpt-5-mini"),
    ).toBe("gpt-5.3-codex")
  })
})

// Minimal stand-in for the createResponses return shape the executor reads.
function fakeCreateResponses(result: unknown) {
  return () => Promise.resolve(result as never)
}

// Keep the executor's usage recording out of the real token-usage store in
// tests that don't assert on it.
const noopRecord = () => {}

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
      recordUsage: noopRecord,
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

  it("forces the search and stamps an undated query with today's date", async () => {
    const seen: Array<Record<string, unknown>> = []
    const exec = new CopilotResponsesExecutor({
      model: "gpt-5-mini",
      createResponsesFn: (payload) => {
        seen.push(payload)
        return Promise.resolve({ output: [] } as never)
      },
      recordUsage: noopRecord,
      now: () => new Date("2026-07-03T12:00:00Z"),
    })
    await exec.search("best espresso machines")
    expect(seen).toHaveLength(1)
    // Search is forced, tool declared, raw query preserved + dated.
    expect(seen[0].tool_choice).toBe("required")
    expect(seen[0].tools).toEqual([{ type: "web_search" }])
    expect(seen[0].input).toBe("best espresso machines (as of 2026-07-03)")
  })

  it("passes a query that already has a date cue through unchanged", async () => {
    const seen: Array<Record<string, unknown>> = []
    const exec = new CopilotResponsesExecutor({
      model: "gpt-5-mini",
      createResponsesFn: (payload) => {
        seen.push(payload)
        return Promise.resolve({ output: [] } as never)
      },
      recordUsage: noopRecord,
      now: () => new Date("2026-07-03T12:00:00Z"),
    })
    await exec.search("olympics schedule 2028")
    expect(seen[0].input).toBe("olympics schedule 2028")
  })

  it("passes allowed/blocked domains through as a /responses filters object", async () => {
    const seen: Array<Record<string, unknown>> = []
    const exec = new CopilotResponsesExecutor({
      model: "gpt-5-mini",
      createResponsesFn: (payload) => {
        seen.push(payload)
        return Promise.resolve({ output: [] } as never)
      },
      recordUsage: noopRecord,
      now: () => new Date("2026-07-03T12:00:00Z"),
    })
    await exec.search("q", {
      allowedDomains: ["docs.python.org"],
      blockedDomains: ["spam.example"],
    })
    expect(seen[0].tools).toEqual([
      {
        type: "web_search",
        filters: {
          allowed_domains: ["docs.python.org"],
          blocked_domains: ["spam.example"],
        },
      },
    ])
  })

  it("omits the filters key entirely when no domains are set", async () => {
    const seen: Array<Record<string, unknown>> = []
    const exec = new CopilotResponsesExecutor({
      model: "gpt-5-mini",
      createResponsesFn: (payload) => {
        seen.push(payload)
        return Promise.resolve({ output: [] } as never)
      },
      recordUsage: noopRecord,
      now: () => new Date("2026-07-03T12:00:00Z"),
    })
    await exec.search("q")
    expect(seen[0].tools).toEqual([{ type: "web_search" }])
  })

  it("records normalized token usage for the brokered /responses call", async () => {
    const recorded: Array<unknown> = []
    const exec = new CopilotResponsesExecutor({
      model: "gpt-5-mini",
      createResponsesFn: fakeCreateResponses({
        output: [],
        usage: {
          input_tokens: 3103,
          output_tokens: 114,
          total_tokens: 3217,
          input_tokens_details: { cached_tokens: 2432 },
        },
      }),
      recordUsage: (u) => recorded.push(u),
    })
    await exec.search("q")
    expect(recorded).toEqual([
      {
        cache_read_input_tokens: 2432,
        input_tokens: 671, // 3103 - 2432 cached
        output_tokens: 114,
        total_tokens: 3217,
      },
    ])
  })

  it("returns unavailable when createResponses throws", async () => {
    const exec = new CopilotResponsesExecutor({
      model: "gpt-5-mini",
      createResponsesFn: () => Promise.reject(new Error("boom")),
      recordUsage: noopRecord,
    })
    expect(await exec.search("q")).toEqual({ ok: false, code: "unavailable" })
  })

  it("returns unavailable on a non-object / streamed result", async () => {
    const exec = new CopilotResponsesExecutor({
      model: "gpt-5-mini",
      createResponsesFn: fakeCreateResponses({ notOutput: true }),
      recordUsage: noopRecord,
    })
    expect(await exec.search("q")).toEqual({ ok: false, code: "unavailable" })
  })

  it("delegates fetch() to the injected fetch executor", async () => {
    const calls: Array<string> = []
    const exec = new CopilotResponsesExecutor({
      model: "gpt-5-mini",
      createResponsesFn: fakeCreateResponses({ output: [] }),
      recordUsage: noopRecord,
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

  it("caps the harvest at maxResults", () => {
    const sources = Array.from({ length: 5 }, (_, i) => ({
      type: "url",
      url: `https://s${i}.example`,
    }))
    const hits = harvestResponsesHits(
      { output: [{ type: "web_search_call", action: { sources } }] },
      2,
    )
    expect(hits.map((h) => h.url)).toEqual([
      "https://s0.example",
      "https://s1.example",
    ])
  })

  it("falls back to the url as title when a citation has no title", () => {
    const hits = harvestResponsesHits(
      {
        output: [
          {
            type: "message",
            content: [
              {
                type: "output_text",
                annotations: [
                  { type: "url_citation", url: "https://notitle.example" },
                ],
              },
            ],
          },
        ],
      },
      5,
    )
    expect(hits).toEqual([
      {
        url: "https://notitle.example",
        title: "https://notitle.example",
        page_age: null,
      },
    ])
  })

  it("ignores non-object content blocks and non-object source entries", () => {
    // Kills the `if (!isRecord(block)) continue` / `if (!isRecord(src))
    // continue` guards: junk (a bare string) mixed into content[] / sources[]
    // must be skipped, not crash, while valid siblings still harvest.
    const hits = harvestResponsesHits(
      {
        output: [
          {
            type: "message",
            content: [
              "junk-string-block",
              {
                type: "output_text",
                annotations: [
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
            action: {
              sources: ["junk", { type: "url", url: "https://s.example" }],
            },
          },
        ],
      },
      5,
    )
    expect(hits).toEqual([
      { url: "https://ok.example", title: "OK", page_age: null },
      { url: "https://s.example", title: "https://s.example", page_age: null },
    ])
  })
})

describe("withDateHint", () => {
  const now = new Date("2026-07-03T00:00:00Z")

  it("appends the current date to an undated query", () => {
    expect(withDateHint("who won the game", now)).toBe(
      "who won the game (as of 2026-07-03)",
    )
  })

  it("leaves a query with an explicit year unchanged", () => {
    expect(withDateHint("tax brackets 2025", now)).toBe("tax brackets 2025")
  })

  it("leaves a query with a recency word unchanged", () => {
    expect(withDateHint("latest iphone reviews", now)).toBe(
      "latest iphone reviews",
    )
    expect(withDateHint("news today", now)).toBe("news today")
  })

  it("leaves a query with a month name unchanged", () => {
    expect(withDateHint("events in December", now)).toBe("events in December")
  })
})
