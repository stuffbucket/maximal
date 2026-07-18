import { describe, expect, test } from "bun:test"

import type { LiveFeedSnapshot } from "~/lib/ws/feed-types"

import {
  injectInlineState,
  isHtmlResponse,
  renderStateScript,
  type InlineUiState,
} from "~/routes/ui/inline-state"

/**
 * Instant-paint state inlining (spec §1.4). Security-critical: state is inlined
 * into served HTML as `window.__STATE__`, so a naive `JSON.stringify` is an XSS
 * vector. The escaping test is the anchor. Skipped until the bodies land.
 */

function fakeState(overrides: Partial<InlineUiState> = {}): InlineUiState {
  return {
    snapshot: {} as LiveFeedSnapshot,
    sessionToken: "tok",
    locale: "en",
    boundPort: 4141,
    dismissedUpdateVersion: null,
    ...overrides,
  }
}

describe("renderStateScript escaping — unskip when implemented", () => {
  test("neutralizes a </script> breakout embedded in state", () => {
    const evil = fakeState({ locale: "</script><script>alert(1)</script>" })
    const script = renderStateScript(evil)
    // The literal closing tag must not appear un-escaped anywhere in the output.
    expect(script.includes("</script><script>")).toBe(false)
    expect(script.startsWith("<script>window.__STATE__=")).toBe(true)
  })

  test("neutralizes an HTML comment opener (<!--) in state", () => {
    const script = renderStateScript(fakeState({ locale: "<!--" }))
    expect(script.includes("<!--")).toBe(false)
  })

  test("round-trips state containing '<' back to the exact value (escape is lossless)", () => {
    // Escaping must NEITHER drop the `<` (a mutant replacing the escape with "")
    // NOR corrupt the JSON (a mutant emptying the search). Parsing the inlined
    // payload back must reproduce the original object exactly.
    const original = fakeState({ locale: "a<b</x>" })
    const script = renderStateScript(original)
    const PREFIX = "<script>window.__STATE__="
    const SUFFIX = "</script>"
    const json = script.slice(PREFIX.length, script.length - SUFFIX.length)
    expect(JSON.parse(json)).toEqual(original)
  })

  test("neutralizes U+2028/U+2029 line terminators (they break a JS string)", () => {
    // Literal line breaks inside a JS string literal — unescaped, they make
    // `window.__STATE__=…` a syntax error and drop first-paint state.
    const LS = String.raw`\u2028`
    const PS = String.raw`\u2029`
    const raw = `a${String.fromCodePoint(0x2028)}b${String.fromCodePoint(0x2029)}c`
    const script = renderStateScript(fakeState({ locale: raw }))
    expect(script.includes(String.fromCodePoint(0x2028))).toBe(false)
    expect(script.includes(String.fromCodePoint(0x2029))).toBe(false)
    expect(script.includes(LS)).toBe(true)
    expect(script.includes(PS)).toBe(true)
  })
})

describe("isHtmlResponse — unskip when implemented", () => {
  test("true for text/html, false for JS/CSS/JSON assets", () => {
    expect(isHtmlResponse("text/html; charset=utf-8")).toBe(true)
    expect(isHtmlResponse("application/javascript")).toBe(false)
    expect(isHtmlResponse("text/css")).toBe(false)
  })
})

describe("injectInlineState — unskip when implemented", () => {
  test("inserts the state script before </head> exactly once", () => {
    const html = "<html><head><title>x</title></head><body></body></html>"
    const out = injectInlineState(html, fakeState())
    expect(out.match(/window\.__STATE__/g) ?? []).toHaveLength(1)
    expect(out.indexOf("window.__STATE__")).toBeLessThan(out.indexOf("</head>"))
    // Adjacency, not just ordering: the script must sit immediately before
    // </head> (a prepend would also satisfy the ordering check above).
    expect(out.includes("</script></head>")).toBe(true)
    // Exactly one </head> — a mutant that inserts at position 0 would duplicate it.
    expect(out.match(/<\/head>/g) ?? []).toHaveLength(1)
  })

  test("falls back to prepending when there is no </head> (never drops state)", () => {
    const out = injectInlineState("<body>no head</body>", fakeState())
    expect(out.includes("window.__STATE__")).toBe(true)
    expect(out.startsWith("<script>window.__STATE__=")).toBe(true)
  })
})
