/**
 * Executor interface + InProcessFetchExecutor implementation.
 *
 * Closes domain D5. The interceptor calls Executor; Executor does the
 * actual side effects (HTTPS GET, future MCP-stdio call, future search
 * API). v1 ships an in-process fetch implementation only; search
 * returns `unavailable` until a backend is wired.
 *
 * Spec: docs/spec/web-tools.md, sections "Implementation outline" and
 * "Out of scope".
 */

import TurndownService from "turndown"

import type { WebFetchErrorCode, WebSearchErrorCode } from "./web-tools-vocab"

// ────────────────────────────────────────────────────────────────────
// Result shapes — discriminated unions keyed by `ok`. Errors use the
// per-tool error code unions from D1.
// ────────────────────────────────────────────────────────────────────

export type FetchResult =
  | { ok: true; markdown: string; title?: string }
  | { ok: false; code: WebFetchErrorCode }

export interface SearchHit {
  url: string
  title: string
  page_age?: string | null
}

export type SearchResult =
  | { ok: true; items: Array<SearchHit> }
  | { ok: false; code: WebSearchErrorCode }

export interface FetchOpts {
  /** Approximate character budget for the resulting markdown. Anthropic
   *  spec talks tokens; ~4 chars/token is the standard rough conversion
   *  applied by the interceptor before calling here. */
  maxChars?: number
  /** Timeout in ms for the upstream HTTP request. */
  timeoutMs?: number
}

export interface SearchOpts {
  maxResults?: number
}

export interface Executor {
  fetch(url: string, opts?: FetchOpts): Promise<FetchResult>
  search(query: string, opts?: SearchOpts): Promise<SearchResult>
}

// ────────────────────────────────────────────────────────────────────
// In-process implementation.
// ────────────────────────────────────────────────────────────────────

const DEFAULT_TIMEOUT_MS = 15_000
const DEFAULT_MAX_CHARS = 400_000

const turndown = new TurndownService({
  headingStyle: "atx",
  codeBlockStyle: "fenced",
  emDelimiter: "*",
})

const TITLE_RE = /<title[^>]*>([\s\S]*?)<\/title>/iu
const WHITESPACE_RE = /\s+/gu

function extractTitle(html: string): string | undefined {
  const m = html.match(TITLE_RE)
  if (!m) return undefined
  return m[1].replaceAll(WHITESPACE_RE, " ").trim() || undefined
}

function isTextual(mediaType: string): boolean {
  return (
    mediaType.startsWith("text/")
    || mediaType.endsWith("+xml")
    || mediaType === "application/json"
  )
}

export class InProcessFetchExecutor implements Executor {
  async fetch(url: string, opts: FetchOpts = {}): Promise<FetchResult> {
    const maxChars = opts.maxChars ?? DEFAULT_MAX_CHARS
    const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)

    let response: Response
    try {
      response = await fetch(url, {
        method: "GET",
        redirect: "follow",
        signal: controller.signal,
        headers: {
          // Identify as a Mozilla-class UA so cooperative servers don't
          // 403 us. No need to lie about a specific browser version.
          "User-Agent": "Mozilla/5.0 (compatible; maximal-proxy/0.1)",
          Accept:
            "text/html, text/plain, application/xhtml+xml; q=0.9, */*; q=0.5",
        },
      })
    } catch (err) {
      clearTimeout(timer)
      if (err instanceof Error && err.name === "AbortError") {
        return { ok: false, code: "url_not_accessible" }
      }
      return { ok: false, code: "url_not_accessible" }
    }
    clearTimeout(timer)

    if (!response.ok) return { ok: false, code: "url_not_accessible" }

    const ct = (response.headers.get("content-type") ?? "").toLowerCase()
    const mediaType = ct.split(";")[0].trim()
    if (!isTextual(mediaType)) {
      return { ok: false, code: "unsupported_content_type" }
    }

    let body: string
    try {
      body = await response.text()
    } catch {
      return { ok: false, code: "url_not_accessible" }
    }

    const isHtml =
      mediaType === "text/html" || mediaType === "application/xhtml+xml"
    const title = isHtml ? extractTitle(body) : undefined
    const markdown = isHtml ? turndown.turndown(body) : body

    const trimmed =
      markdown.length > maxChars ? markdown.slice(0, maxChars) : markdown

    return { ok: true, markdown: trimmed, title }
  }

  // No search backend wired; configure a different Executor to enable.
  search(_query: string, _opts?: SearchOpts): Promise<SearchResult> {
    return Promise.resolve({ ok: false, code: "unavailable" })
  }
}

export const defaultExecutor: Executor = new InProcessFetchExecutor()
