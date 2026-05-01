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

// ────────────────────────────────────────────────────────────────────
// Ollama hosted web tools (https://ollama.com/api/web_search,
// /api/web_fetch). Covers both halves of the executor surface from a
// single vendor with one API key.
//
// Verified shapes (2026-05-01):
//
//   POST /api/web_search { query, max_results } →
//     { results: [{ title, url, content }] }     // content = full body
//
//   POST /api/web_fetch  { url } →
//     { title, content, links: [string] }        // content = extracted text
//
// `web_search` already returns full bodies per result, so we cache
// them on the instance keyed by URL. A subsequent `fetch()` for any of
// those URLs is satisfied without an extra round-trip.
// ────────────────────────────────────────────────────────────────────

const OLLAMA_DEFAULT_BASE = "https://ollama.com/api"

interface PostOk {
  ok: true
  data: unknown
}
interface PostErr {
  ok: false
  status: number
  reason: "auth" | "rate_limit" | "client" | "server" | "network" | "timeout"
}

export interface OllamaWebExecutorOpts {
  apiKey: string
  baseUrl?: string
  /** Default per-call timeout, ms. Search/fetch can take a few seconds
   *  on the hosted endpoint; default to 30s. */
  timeoutMs?: number
}

export class OllamaWebExecutor implements Executor {
  private readonly apiKey: string
  private readonly base: string
  private readonly timeoutMs: number
  private readonly prefetch = new Map<
    string,
    { markdown: string; title?: string }
  >()

  constructor(opts: OllamaWebExecutorOpts) {
    this.apiKey = opts.apiKey
    this.base = opts.baseUrl ?? OLLAMA_DEFAULT_BASE
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS * 2
  }

  async search(query: string, opts: SearchOpts = {}): Promise<SearchResult> {
    const body = JSON.stringify({
      query,
      max_results: opts.maxResults ?? 5,
    })
    const r = await this.post("/web_search", body)
    if (!r.ok) return { ok: false, code: searchErrorFromPost(r) }

    const data = r.data as { results?: unknown }
    if (!Array.isArray(data.results)) {
      return { ok: false, code: "unavailable" }
    }

    const items: Array<SearchHit> = []
    for (const raw of data.results) {
      if (typeof raw !== "object" || raw === null) continue
      const hit = raw as { title?: unknown; url?: unknown; content?: unknown }
      if (typeof hit.url !== "string" || typeof hit.title !== "string") continue
      items.push({ url: hit.url, title: hit.title, page_age: null })
      if (typeof hit.content === "string" && hit.content.length > 0) {
        this.prefetch.set(hit.url, {
          markdown: hit.content,
          title: hit.title,
        })
      }
    }

    return { ok: true, items }
  }

  async fetch(url: string, opts: FetchOpts = {}): Promise<FetchResult> {
    const maxChars = opts.maxChars ?? DEFAULT_MAX_CHARS

    const cached = this.prefetch.get(url)
    if (cached) {
      return {
        ok: true,
        markdown: trimTo(cached.markdown, maxChars),
        title: cached.title,
      }
    }

    const r = await this.post("/web_fetch", JSON.stringify({ url }))
    if (!r.ok) return { ok: false, code: fetchErrorFromPost(r) }

    const data = r.data as { title?: unknown; content?: unknown }
    if (typeof data.content !== "string") {
      return { ok: false, code: "url_not_accessible" }
    }
    const title = typeof data.title === "string" ? data.title : undefined

    return {
      ok: true,
      markdown: trimTo(data.content, maxChars),
      title,
    }
  }

  private async post(path: string, body: string): Promise<PostOk | PostErr> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.timeoutMs)
    let response: Response
    try {
      response = await fetch(`${this.base}${path}`, {
        method: "POST",
        signal: controller.signal,
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          "Content-Type": "application/json",
        },
        body,
      })
    } catch (err) {
      clearTimeout(timer)
      const isTimeout = err instanceof Error && err.name === "AbortError"
      return { ok: false, status: 0, reason: isTimeout ? "timeout" : "network" }
    }
    clearTimeout(timer)

    if (!response.ok) {
      const status = response.status
      let reason: PostErr["reason"]
      if (status === 401 || status === 403) reason = "auth"
      else if (status === 429) reason = "rate_limit"
      else if (status >= 500) reason = "server"
      else reason = "client"
      try {
        await response.text()
      } catch {
        /* drain failure: ignore */
      }
      return { ok: false, status, reason }
    }

    let data: unknown
    try {
      data = await response.json()
    } catch {
      return { ok: false, status: response.status, reason: "server" }
    }
    return { ok: true, data }
  }
}

function trimTo(s: string, maxChars: number): string {
  return s.length > maxChars ? s.slice(0, maxChars) : s
}

function searchErrorFromPost(err: PostErr): WebSearchErrorCode {
  switch (err.reason) {
    case "rate_limit": {
      return "too_many_requests"
    }
    case "auth":
    case "server":
    case "network":
    case "timeout": {
      return "unavailable"
    }
    case "client": {
      return "invalid_input"
    }
    default: {
      return "unavailable"
    }
  }
}

function fetchErrorFromPost(err: PostErr): WebFetchErrorCode {
  switch (err.reason) {
    case "rate_limit": {
      return "too_many_requests"
    }
    case "auth":
    case "server":
    case "timeout": {
      return "unavailable"
    }
    case "network":
    case "client": {
      // 4xx from /web_fetch most commonly means the URL itself was
      // unreachable / refused upstream; fold network errors here too.
      return "url_not_accessible"
    }
    default: {
      return "unavailable"
    }
  }
}

/**
 * Select the executor based on environment.
 *
 * - `OLLAMA_API_KEY` set → `OllamaWebExecutor` (covers both search and
 *   fetch via ollama.com hosted endpoints; per-request prefetch cache
 *   short-circuits search→fetch on the same URL).
 * - Otherwise → `InProcessFetchExecutor` (fetch works, search returns
 *   `unavailable`).
 *
 * Constructed per-request rather than as a module-level singleton so
 * the prefetch cache scope matches request lifetime.
 */
export function selectExecutor(): Executor {
  const apiKey = process.env.OLLAMA_API_KEY
  if (apiKey !== undefined && apiKey.length > 0) {
    return new OllamaWebExecutor({ apiKey })
  }
  return new InProcessFetchExecutor()
}

export const defaultExecutor: Executor = new InProcessFetchExecutor()
