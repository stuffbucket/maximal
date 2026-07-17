import { describe, expect, test } from "bun:test"

import { escapeHtml, renderDiagnosticsPage } from "~/routes/ui/diagnostics"
import { server } from "~/server"

/**
 * Read-only diagnostics page (spec §1.7). It is served unauthenticated under /ui
 * and renders runtime state into HTML, so escaping is security-critical, and it
 * must expose secret SOURCES only (never values) and offer no mutation surface.
 */

type DiagnosticsData = Parameters<typeof renderDiagnosticsPage>[0]

function fakeData(overrides: Partial<DiagnosticsData> = {}): DiagnosticsData {
  return {
    git: { sha: "abc1234", branch: "main" },
    runtime: {
      account_type: "individual",
      verbose: false,
      manual_approve: false,
      rate_limit_seconds: null,
      rate_limit_wait: false,
      models_loaded: false,
      models_count: 0,
      copilot_token_present: false,
      github_token_present: false,
    },
    config: {},
    executor: { kind: "in-process" },
    caches: {},
    secrets: [{ name: "GITHUB_TOKEN", source: "env" }],
    ...overrides,
  } as DiagnosticsData
}

describe("escapeHtml", () => {
  test("neutralizes the HTML metacharacters", () => {
    expect(escapeHtml(`<a href="x">&`)).toBe(
      "&lt;a href=&quot;x&quot;&gt;&amp;",
    )
  })
})

describe("renderDiagnosticsPage", () => {
  test("is a complete HTML document", () => {
    const html = renderDiagnosticsPage(fakeData())
    expect(html.startsWith("<!doctype html>")).toBe(true)
    expect(html.includes("Maximal diagnostics")).toBe(true)
    expect(html.includes("abc1234 (main)")).toBe(true)
  })

  test("escapes hostile runtime values in the raw state tree (XSS anchor)", () => {
    const html = renderDiagnosticsPage(
      fakeData({
        config: { note: "</script><script>alert(1)</script>" } as never,
      }),
    )
    // The injected closing tag must not appear un-escaped anywhere.
    expect(html.includes("</script><script>alert(1)")).toBe(false)
    expect(html.includes("&lt;/script&gt;&lt;script&gt;")).toBe(true)
  })

  test("shows secret SOURCES, never values", () => {
    const html = renderDiagnosticsPage(
      // A source of "env"; the type carries no value field, so a value can't leak.
      fakeData({ secrets: [{ name: "COPILOT_TOKEN", source: "env" }] }),
    )
    expect(html.includes("COPILOT_TOKEN")).toBe(true)
    expect(html.includes("&lt;env&gt;")).toBe(true)
  })

  test("is mutation-free — no forms, no fetch/XHR, no client script", () => {
    const html = renderDiagnosticsPage(fakeData())
    expect(/<form/i.test(html)).toBe(false)
    expect(/fetch\(|XMLHttpRequest|<script(?![^>]*\/)/i.test(html)).toBe(false)
  })
})

describe("GET /ui/diagnostics route", () => {
  test("serves the page unauthenticated as no-store HTML", async () => {
    const res = await server.request("/ui/diagnostics")
    expect(res.status).toBe(200)
    expect(res.headers.get("content-type")).toContain("text/html")
    expect(res.headers.get("cache-control")).toBe("no-store")
    expect(await res.text()).toContain("Maximal diagnostics")
  })

  test("is read-only — POST is not a valid method", async () => {
    const res = await server.request("/ui/diagnostics", { method: "POST" })
    expect(res.status).not.toBe(200)
  })
})
