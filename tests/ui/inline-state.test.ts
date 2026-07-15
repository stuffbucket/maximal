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

describe.skip("renderStateScript escaping — unskip when implemented", () => {
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
})

describe.skip("isHtmlResponse — unskip when implemented", () => {
  test("true for text/html, false for JS/CSS/JSON assets", () => {
    expect(isHtmlResponse("text/html; charset=utf-8")).toBe(true)
    expect(isHtmlResponse("application/javascript")).toBe(false)
    expect(isHtmlResponse("text/css")).toBe(false)
  })
})

describe.skip("injectInlineState — unskip when implemented", () => {
  test("inserts the state script before </head> exactly once", () => {
    const html = "<html><head><title>x</title></head><body></body></html>"
    const out = injectInlineState(html, fakeState())
    expect(out.match(/window\.__STATE__/g) ?? []).toHaveLength(1)
    expect(out.indexOf("window.__STATE__")).toBeLessThan(out.indexOf("</head>"))
  })
})
