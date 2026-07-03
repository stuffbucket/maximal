/**
 * Executor interface and implementations. The agent loop calls these to
 * resolve `web_search` / `web_fetch` tool calls.
 *
 * Three implementations, in preference order (see chooseExecutor):
 *   - CopilotResponsesExecutor — resolves `search` via an internal /responses
 *     side-call using a GPT model that has Copilot's native (server-side Bing)
 *     web_search tool. No extra key: reuses the Copilot entitlement already
 *     present. Claude models can't reach /responses, which is exactly why a
 *     Claude client's web_search has to be brokered through a GPT model here.
 *     `fetch` delegates to the in-process HTTP fetcher (no backend needed).
 *   - OllamaWebExecutor — both halves via ollama.com's hosted API when
 *     OLLAMA_API_KEY is set.
 *   - InProcessFetchExecutor — no key at all: fetch via plain HTTPS + Turndown,
 *     search by scraping DuckDuckGo's server-rendered HTML.
 */

import { randomUUID } from "node:crypto"
import TurndownService from "turndown"

import type { ResponsesPayload } from "~/services/copilot/create-responses"

import { Cache } from "~/lib/cache"
import { getSmallModel } from "~/lib/config"
import { state } from "~/lib/state"
import {
  createCopilotTokenUsageRecorder,
  normalizeResponsesUsage,
  type UsageTokens,
} from "~/lib/token-usage"
import { createResponses } from "~/services/copilot/create-responses"

import type { WebFetchErrorCode, WebSearchErrorCode } from "./vocab"

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

// Cap raw HTML before handing it to Turndown. Turndown walks the DOM
// synchronously on the event loop, so a pathological multi-MB page stalls
// every other in-flight request. Output is still bounded by maxChars
// after conversion; this guard protects the conversion step itself.
const MAX_HTML_INPUT_CHARS = 2_000_000

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

function htmlToMarkdown(body: string): string {
  return turndown.turndown(trimTo(body, MAX_HTML_INPUT_CHARS))
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
    const markdown = isHtml ? htmlToMarkdown(body) : body

    return { ok: true, markdown: trimTo(markdown, maxChars), title }
  }

  // Falls back to scraping DuckDuckGo's server-rendered HTML results page —
  // no API key required, matching the no-key philosophy of fetch() above.
  // Configure OLLAMA_API_KEY for a real search API at better quality.
  search(query: string, opts: SearchOpts = {}): Promise<SearchResult> {
    return ddgHtmlSearch(query, opts.maxResults ?? DEFAULT_SEARCH_MAX_RESULTS)
  }
}

// ────────────────────────────────────────────────────────────────────
// Copilot Responses-API web search. Copilot's native web search is a
// server-side Bing capability exposed ONLY on the /responses endpoint,
// and ONLY GPT models advertise /responses (no Claude model does — which
// is why a Claude client's web_search reaches us here unresolved). We
// broker it: fire an internal /responses call with a GPT model and the
// `{type:"web_search"}` tool, then harvest the structured sources the
// model cites.
//
// Verified response shape (2026-07-03, gpt-5-mini):
//   output[].type === "web_search_call"
//     .action.sources[] === { type:"url", url }        // raw hits
//   output[].type === "message"
//     .content[].annotations[] === {                    // cited hits (+title)
//       type:"url_citation", url, title, start_index, end_index }
//
// `fetch` needs no backend — plain HTTPS + Turndown already works key-free
// — so we delegate it to an inner InProcessFetchExecutor.
// ────────────────────────────────────────────────────────────────────

export interface CopilotResponsesExecutorOpts {
  /** GPT model id that advertises the /responses endpoint. */
  model: string
  /** Injected for tests; defaults to the real createResponses. */
  createResponsesFn?: typeof createResponses
  /** Injected for tests; defaults to a real InProcessFetchExecutor. */
  fetchExecutor?: Executor
  /** Injected for tests; defaults to a real token-usage recorder so the
   *  brokered /responses call is billed against the account's quota
   *  visibly (it spends GPT-model tokens the same as any /responses call). */
  recordUsage?: (usage: UsageTokens) => void
}

export class CopilotResponsesExecutor implements Executor {
  private readonly model: string
  private readonly createResponsesFn: typeof createResponses
  private readonly fetchExecutor: Executor
  private readonly recordUsage: (usage: UsageTokens) => void

  constructor(opts: CopilotResponsesExecutorOpts) {
    this.model = opts.model
    this.createResponsesFn = opts.createResponsesFn ?? createResponses
    this.fetchExecutor = opts.fetchExecutor ?? new InProcessFetchExecutor()
    this.recordUsage =
      opts.recordUsage
      ?? createCopilotTokenUsageRecorder({
        endpoint: "responses",
        model: opts.model,
      })
  }

  // Copilot resolves web_fetch server-side too, but a plain HTTPS GET +
  // HTML→markdown is simpler, cheaper, and already key-free, so reuse it.
  fetch(url: string, opts?: FetchOpts): Promise<FetchResult> {
    return this.fetchExecutor.fetch(url, opts)
  }

  async search(query: string, opts: SearchOpts = {}): Promise<SearchResult> {
    const maxResults = opts.maxResults ?? DEFAULT_SEARCH_MAX_RESULTS
    const payload: ResponsesPayload = {
      model: this.model,
      // Steer the GPT broker to actually run a search and cite what it
      // used, rather than answer from memory — we harvest sources, not prose.
      input:
        `Search the web for: ${query}\n\n`
        + "Use the web_search tool and base your answer only on the results. "
        + "Cite the sources you use.",
      tools: [{ type: "web_search" }],
      // The sources array is only surfaced when explicitly included.
      include: ["web_search_call.action.sources"],
      stream: false,
    }

    let result: Awaited<ReturnType<typeof createResponses>>
    try {
      result = await this.createResponsesFn(payload, {
        vision: false,
        initiator: "agent",
        requestId: randomUUID(),
      })
    } catch {
      return { ok: false, code: "unavailable" }
    }

    // createResponses returns a stream union member when payload.stream is
    // true; we set it false, so a shape without `output` is a contract
    // violation we treat as unavailable rather than crash on.
    if (!("output" in result)) {
      return { ok: false, code: "unavailable" }
    }

    // This side-call spends the account's Copilot quota (GPT-model tokens +
    // a web_search request). Record it so it's visible in `maximal debug` /
    // the token-usage view rather than billed invisibly to the user.
    this.recordUsage(normalizeResponsesUsage(result.usage))

    return { ok: true, items: harvestResponsesHits(result, maxResults) }
  }
}

/**
 * Pull SearchHit[] out of a /responses result. url_citation annotations
 * carry both url AND title, so they seed the list first (richer); raw
 * web_search_call.action.sources[] fill in any remaining slots (url only).
 * Deduped by url, capped at maxResults.
 */
export function harvestResponsesHits(
  result: { output?: unknown },
  maxResults: number,
): Array<SearchHit> {
  const items: Array<SearchHit> = []
  const seen = new Set<string>()
  const output = Array.isArray(result.output) ? result.output : []

  const push = (url: unknown, title: unknown): void => {
    if (items.length >= maxResults) return
    if (typeof url !== "string" || url.length === 0 || seen.has(url)) return
    seen.add(url)
    items.push({
      url,
      title: typeof title === "string" && title.length > 0 ? title : url,
      page_age: null,
    })
  }

  // Pass 1 — cited URLs (have titles). Pass 2 — raw searched sources
  // (url only), backfilling remaining slots.
  for (const item of output) harvestCitations(item, push)
  for (const item of output) harvestSearchSources(item, push)

  return items
}

type PushHit = (url: unknown, title: unknown) => void

function harvestCitations(item: unknown, push: PushHit): void {
  if (!isRecord(item) || item.type !== "message") return
  const content = Array.isArray(item.content) ? item.content : []
  for (const block of content) {
    if (!isRecord(block)) continue
    const annotations =
      Array.isArray(block.annotations) ? block.annotations : []
    for (const ann of annotations) {
      if (!isRecord(ann) || ann.type !== "url_citation") continue
      push(ann.url, ann.title)
    }
  }
}

function harvestSearchSources(item: unknown, push: PushHit): void {
  if (!isRecord(item) || item.type !== "web_search_call") return
  const action = isRecord(item.action) ? item.action : {}
  const sources = Array.isArray(action.sources) ? action.sources : []
  for (const src of sources) {
    if (!isRecord(src)) continue
    push(src.url, undefined)
  }
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null
}

// ────────────────────────────────────────────────────────────────────
// No-key web search: scrape DuckDuckGo's html.duckduckgo.com results page
// (the same server-rendered HTML a JS-disabled browser gets — no API key,
// no JSON endpoint). Fragile to DuckDuckGo markup changes by nature of
// being a scrape rather than an API; OllamaWebExecutor is the higher-
// quality option when a key is available.
// ────────────────────────────────────────────────────────────────────

const DDG_HTML_SEARCH_URL = "https://html.duckduckgo.com/html/"
const DEFAULT_SEARCH_MAX_RESULTS = 5
const SEARCH_TIMEOUT_MS = 15_000

// DDG's html results wrap each hit in `<a ... class="result__a" ...>Title</a>`;
// attribute order isn't guaranteed, so capture the whole opening tag and
// inner text, then pull `class` / `href` out of the tag independently.
const RESULT_ANCHOR_RE = /<a\b([^>]*)>([\s\S]*?)<\/a>/giu
const HREF_ATTR_RE = /href="([^"]*)"/iu
const TAG_RE = /<[^>]+>/gu

// Strip HTML tags. Loop until the output is stable: a single pass over
// crafted input (e.g. `<scr<script>ipt>`) can leave tag-like residue behind,
// which CodeQL flags as incomplete-multi-character-sanitization. Iterating
// to a fixpoint removes any tags exposed by an earlier removal.
function stripTags(html: string): string {
  let current = html
  let previous: string
  do {
    previous = current
    current = current.replaceAll(TAG_RE, "")
  } while (current !== previous)
  return current.replaceAll(WHITESPACE_RE, " ").trim()
}

const HTML_ENTITY_RE = /&(amp|lt|gt|quot|#39);/gu
const HTML_ENTITY_MAP: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  "#39": "'",
}

// Single-pass decode via one regex + lookup. Decoding entities
// sequentially (`&amp;`→`&` first, then `&lt;`→`<`) double-unescapes input
// like `&amp;lt;` into `<` when it should stay the literal `&lt;`. A single
// pass never re-examines its own output, so ordering can't compound.
function decodeHtmlEntities(s: string): string {
  return s.replaceAll(
    HTML_ENTITY_RE,
    (_, name: string) => HTML_ENTITY_MAP[name],
  )
}

// DDG's html endpoint doesn't link directly to results — it wraps them in
// a same-site redirect (`//duckduckgo.com/l/?uddg=<url-encoded target>&...`)
// so it can log the outbound click. Decode `uddg` directly instead of
// following the redirect (fewer round-trips, and it's a same-page anchor
// href, not a real navigation the model requested).
function resolveDdgResultUrl(href: string): string | undefined {
  if (href.includes("duckduckgo.com/l/")) {
    const query = href.slice(href.indexOf("?") + 1)
    const uddg = new URLSearchParams(query).get("uddg")
    return uddg || undefined
  }
  if (href.startsWith("http://") || href.startsWith("https://")) return href
  return undefined
}

function parseDdgResults(html: string, maxResults: number): Array<SearchHit> {
  const items: Array<SearchHit> = []
  const seenUrls = new Set<string>()
  for (const m of html.matchAll(RESULT_ANCHOR_RE)) {
    if (items.length >= maxResults) break
    const [, attrs, inner] = m
    if (!attrs.includes('class="result__a"')) continue

    const hrefMatch = attrs.match(HREF_ATTR_RE)
    if (!hrefMatch) continue
    const url = resolveDdgResultUrl(hrefMatch[1])
    if (!url || seenUrls.has(url)) continue

    const title = decodeHtmlEntities(stripTags(inner))
    if (!title) continue

    seenUrls.add(url)
    items.push({ url, title, page_age: null })
  }
  return items
}

async function ddgHtmlSearch(
  query: string,
  maxResults: number,
): Promise<SearchResult> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), SEARCH_TIMEOUT_MS)

  let response: Response
  try {
    response = await fetch(
      `${DDG_HTML_SEARCH_URL}?q=${encodeURIComponent(query)}`,
      {
        method: "GET",
        redirect: "follow",
        signal: controller.signal,
        headers: {
          "User-Agent": "Mozilla/5.0 (compatible; maximal-proxy/0.1)",
          Accept: "text/html",
        },
      },
    )
  } catch {
    clearTimeout(timer)
    return { ok: false, code: "unavailable" }
  }
  clearTimeout(timer)

  if (!response.ok) {
    return {
      ok: false,
      code: response.status === 429 ? "too_many_requests" : "unavailable",
    }
  }

  let html: string
  try {
    html = await response.text()
  } catch {
    return { ok: false, code: "unavailable" }
  }

  return { ok: true, items: parseDdgResults(html, maxResults) }
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
  /** Per-request prefetch cache. Bounded at 50 entries — well above
   *  the worst-case turn × max_results product (10 × 5 = 50) so the
   *  cap is effectively a runaway guard, not a steady-state limiter.
   *  Marked transient so the global registry stays clean. */
  private readonly prefetch = new Cache<
    string,
    { markdown: string; title?: string }
  >({
    name: "web-tools.prefetch",
    max: 50,
    transient: true,
  })

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
 * Description of which executor `selectExecutor()` would return, with the
 * diagnostic shape used by `maximal debug` and `/_debug/state`. Pure — no
 * side effects, no instantiation.
 *
 * Discriminated on `kind`. The Ollama variant carries the resolved apiKey
 * and the Copilot variant the resolved model so `selectExecutor` can
 * construct without re-deriving anything.
 *
 * Single source of truth for the executor-selection contract.
 */
export type ExecutorChoice =
  | { kind: "OllamaWebExecutor"; base: string; apiKey: string }
  | { kind: "CopilotResponsesExecutor"; model: string; notes: string }
  | { kind: "InProcessFetchExecutor"; notes: string }

export interface ChooseExecutorDeps {
  /** A GPT model id that advertises the /responses endpoint and can run
   *  Copilot's native web_search, if the account has one and is
   *  authenticated. undefined otherwise. Resolved from live state by
   *  `resolveResponsesModel()`; injectable for pure/testable selection. */
  responsesModel?: string
}

export function chooseExecutor(
  env: NodeJS.ProcessEnv = process.env,
  deps: ChooseExecutorDeps = {},
): ExecutorChoice {
  // 1. Explicit OLLAMA_API_KEY wins — a deliberate operator opt-in to a
  //    separate hosted provider; honor it over the implicit Copilot path.
  const apiKey = env.OLLAMA_API_KEY
  if (apiKey !== undefined && apiKey.length > 0) {
    return {
      kind: "OllamaWebExecutor",
      base: OLLAMA_DEFAULT_BASE,
      apiKey,
    }
  }
  // 2. No key, but the account can reach Copilot's native (server-side Bing)
  //    web_search via a GPT /responses model. Best no-key option — uses the
  //    Copilot entitlement already present, real search, structured sources.
  if (deps.responsesModel) {
    return {
      kind: "CopilotResponsesExecutor",
      model: deps.responsesModel,
      notes: `search via Copilot /responses (${deps.responsesModel}); no extra key`,
    }
  }
  // 3. Last resort — scrape DuckDuckGo HTML. No key, no Copilot needed.
  return {
    kind: "InProcessFetchExecutor",
    notes:
      "search via DuckDuckGo HTML scrape (no Copilot /responses model available); set OLLAMA_API_KEY for hosted search",
  }
}

/**
 * Resolve a GPT model that can broker web_search via /responses, reading
 * live Copilot state. Returns undefined when unauthenticated or the catalog
 * has no /responses-capable model (e.g. Claude-only accounts — no Claude
 * model supports /responses, which is the whole reason this broker exists).
 *
 * Never trusts a frozen model id — it queries the LIVE catalog, so a
 * deprecated model (e.g. gpt-5-mini retired by GitHub) simply drops out and
 * selection moves on. Order of preference:
 *   1. the configured small model, if it supports /responses (honor the user);
 *   2. else a "mini"-class /responses model — tracks the cheap tier by class,
 *      not a pinned string, so it survives gpt-5-mini → gpt-6-mini renames;
 *   3. else any /responses-capable model, so search still works.
 */
export function resolveResponsesModel(): string | undefined {
  if (!state.copilotToken) return undefined
  return pickResponsesModel(
    (state.models?.data ?? []).map((m) => ({
      id: m.id,
      supportsResponses: m.supported_endpoints?.includes("/responses") ?? false,
    })),
    getSmallModel(),
  )
}

/**
 * Pure model-selection core (see resolveResponsesModel for the policy).
 * Split out so it's testable without live Copilot state.
 */
export function pickResponsesModel(
  models: Array<{ id: string; supportsResponses: boolean }>,
  configuredSmall: string,
): string | undefined {
  const responsesModels = models.filter((m) => m.supportsResponses)
  if (responsesModels.length === 0) return undefined

  // 1. Honor the configured small model when it can do /responses.
  if (responsesModels.some((m) => m.id === configuredSmall)) {
    return configuredSmall
  }
  // 2. Prefer the cheap "mini" tier by class (not a frozen id).
  const mini = responsesModels.find((m) => m.id.toLowerCase().includes("mini"))
  if (mini) return mini.id
  // 3. Any /responses-capable model keeps search working.
  return responsesModels[0].id
}

/**
 * Select the executor. Per-request so the Ollama prefetch cache stays
 * scoped to one request.
 */
export function selectExecutor(): Executor {
  const choice = chooseExecutor(process.env, {
    responsesModel: resolveResponsesModel(),
  })
  switch (choice.kind) {
    case "OllamaWebExecutor": {
      return new OllamaWebExecutor({ apiKey: choice.apiKey })
    }
    case "CopilotResponsesExecutor": {
      return new CopilotResponsesExecutor({ model: choice.model })
    }
    case "InProcessFetchExecutor": {
      return new InProcessFetchExecutor()
    }
    default: {
      throw new Error(
        `unhandled executor kind: ${(choice as { kind: string }).kind}`,
      )
    }
  }
}
