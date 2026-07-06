#!/usr/bin/env bun
/**
 * measure-baseline.ts — reusable measurement harness for three upcoming
 * workstreams. Run it against a RUNNING, authenticated proxy to capture a
 * before/after snapshot; diff two JSON reports to quantify the improvement.
 *
 * The three workstreams and the signal each one moves:
 *
 *   (2) Billing/cost visibility — is per-request cost (`total_nano_aiu`)
 *       surfaced by the token-usage API (and, downstream, the dashboard)?
 *       Baseline: cost is CAPTURED in the store but the summary/events JSON
 *       (and the dashboard) do not expose it. This is a visibility metric,
 *       not latency: we report present/non-zero, not milliseconds.
 *
 *   (3) Warmup short-circuit — latency of a Claude Code "Warmup" request.
 *       Baseline: a warmup (single user message text exactly "Warmup", no
 *       tools, tiny max_tokens, anthropic-beta set) is forced onto the small
 *       model and round-trips to gpt-5-mini upstream. Target: a canned local
 *       response (near-zero). Metric: total round-trip latency ms.
 *
 *   (4) /responses prompt caching — cache reuse on a repeat large-context
 *       request that routes to a GPT `/responses` model. Metric:
 *       `cache_read_input_tokens` on the SECOND identical request, plus TTFT
 *       and total latency for each. Baseline today: the upstream
 *       (`prompt_cache_key`) cache already yields reuse on a fast repeat;
 *       `prompt_cache_retention:"24h"` is commented out at
 *       responses-translation.ts:87, so there is no 24h retention — reuse
 *       decays once the upstream window closes. This harness measures the
 *       reuse we CAN observe from here (fast repeat) and records the caveat.
 *
 * Design: the number-crunching (SSE/JSON parsing, verdict logic, report
 * shaping) is pure and exported for unit tests; the live I/O is thin.
 *
 * Usage:
 *
 *   # Capture a baseline against a live proxy on :4141
 *   bun run measure:baseline -- --label before
 *
 *   # Point at another host/port
 *   bun run measure:baseline -- --label before --base-url http://127.0.0.1:4142
 *
 *   # Skip the caching probe's inter-request wait (default 3000ms)
 *   bun run measure:baseline -- --label before --cache-gap-ms 0
 *
 * Env overrides: MAXIMAL_BASE_URL, MAXIMAL_MEASURE_MODEL (the /responses GPT
 * model used for the caching probe; default gpt-5-mini).
 *
 * Output: human-readable summary to stdout + a JSON report at
 * reports/baseline-<label>.json (diffable across runs).
 *
 * NOTE ON `Date`: some repo contexts forbid Date.now()/new Date(); this is a
 * normal Bun script, so Date is fine here (used only for the report stamp).
 */

const ANTHROPIC_API_VERSION = "2023-06-01"
const DEFAULT_BASE_URL = "http://127.0.0.1:4141"
const DEFAULT_MEASURE_MODEL = "gpt-5-mini"
const DEFAULT_CACHE_GAP_MS = 3000
/** A Claude model id; forces the warmup small-model short-circuit path so we
 *  measure the round-trip the workstream will replace. Any Claude id works —
 *  the proxy rewrites it and (with beta + no tools + "Warmup") routes to the
 *  small model regardless. */
const WARMUP_MODEL = "claude-opus-4-8-20260301"

// ────────────────────────────────────────────────────────────────────
// Pure logic (exported for tests)
// ────────────────────────────────────────────────────────────────────

export interface AnthropicUsage {
  input_tokens?: number
  output_tokens?: number
  cache_read_input_tokens?: number
  cache_creation_input_tokens?: number
}

export interface NormalizedUsage {
  input_tokens: number
  output_tokens: number
  cache_read_input_tokens: number
}

/** Normalize a non-streaming Anthropic `usage` object to plain numbers. */
export function normalizeUsage(
  usage: AnthropicUsage | null | undefined,
): NormalizedUsage {
  return {
    input_tokens: numeric(usage?.input_tokens),
    output_tokens: numeric(usage?.output_tokens),
    cache_read_input_tokens: numeric(usage?.cache_read_input_tokens),
  }
}

function numeric(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0
}

/**
 * Extract the highest `cache_read_input_tokens` seen anywhere in a streamed
 * SSE body. Anthropic emits usage in `message_start` (initial, often 0 for
 * cache_read) and again in `message_delta` (final, carries the real cache
 * read), so the max across the stream is the authoritative reuse figure.
 */
export function extractStreamCacheRead(sseBody: string): number {
  const matches = [
    ...sseBody.matchAll(/"cache_read_input_tokens"\s*:\s*(\d+)/g),
  ].map((m) => Number.parseInt(m[1], 10))
  if (matches.length === 0) return 0
  return Math.max(...matches)
}

/**
 * Verdict for the caching probe: caching is "reused" when the second
 * request's cache_read is meaningfully larger than the first's (which starts
 * cold at ~0). We require the second read to exceed the first by a margin so
 * a noisy 0→handful doesn't read as a hit.
 */
export function assessCaching(input: {
  firstCacheRead: number
  secondCacheRead: number
}): { reused: boolean; delta: number } {
  const delta = input.secondCacheRead - input.firstCacheRead
  return { reused: input.secondCacheRead > 0 && delta > 100, delta }
}

export interface CostVisibility {
  /** Field present in the summary `totals` object at all. */
  fieldPresent: boolean
  /** Present AND non-zero (cost actually captured for the period). */
  captured: boolean
  value: number | null
}

/**
 * Assess whether the token-usage summary exposes per-request cost. We look at
 * `totals.total_nano_aiu`: absent → not surfaced by the API (baseline);
 * present-but-0 → surfaced but nothing recorded; present-and-positive → cost
 * captured and exposed.
 */
export function assessCostVisibility(summary: unknown): CostVisibility {
  const totals =
    isRecord(summary) && isRecord(summary.totals) ? summary.totals : undefined
  if (!totals || !("total_nano_aiu" in totals)) {
    return { fieldPresent: false, captured: false, value: null }
  }
  const raw = totals.total_nano_aiu
  const value = typeof raw === "number" && Number.isFinite(raw) ? raw : null
  return {
    fieldPresent: true,
    captured: value !== null && value > 0,
    value,
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}

// ────────────────────────────────────────────────────────────────────
// Report shaping (pure, exported for tests)
// ────────────────────────────────────────────────────────────────────

export interface StreamedRequestResult {
  status: number
  ttft_ms: number | null
  total_ms: number
  cache_read_input_tokens: number
}

export interface CachingMetric {
  measured: boolean
  model: string
  cache_gap_ms: number
  first: StreamedRequestResult | null
  second: StreamedRequestResult | null
  verdict: { reused: boolean; delta: number } | null
  note: string
}

export interface WarmupMetric {
  measured: boolean
  samples: Array<{
    status: number
    total_ms: number
    resolved_model: string | null
  }>
  median_ms: number | null
  note: string
}

export interface CostMetric {
  measured: boolean
  visibility: CostVisibility | null
  note: string
}

export interface BaselineReport {
  label: string
  captured_at_utc: string
  base_url: string
  proxy_reachable: boolean
  harness_version: number
  metrics: {
    caching: CachingMetric
    warmup: WarmupMetric
    cost: CostMetric
  }
}

export const HARNESS_VERSION = 1

/** Median of a numeric list, or null if empty. */
export function median(values: Array<number>): number | null {
  if (values.length === 0) return null
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0 ?
      Math.round((sorted[mid - 1] + sorted[mid]) / 2)
    : sorted[mid]
}

// ────────────────────────────────────────────────────────────────────
// Live I/O
// ────────────────────────────────────────────────────────────────────

interface ProxyContext {
  baseUrl: string
}

async function isProxyReachable(baseUrl: string): Promise<boolean> {
  try {
    const res = await fetch(`${baseUrl}/`, {
      signal: AbortSignal.timeout(3000),
    })
    return res.ok
  } catch {
    return false
  }
}

const anthropicHeaders = (
  extra?: Record<string, string>,
): Record<string, string> => ({
  "content-type": "application/json",
  "anthropic-version": ANTHROPIC_API_VERSION,
  ...extra,
})

/** Send one streamed /v1/messages request; time TTFT + total, harvest the
 *  cache-read signal from the SSE body. */
async function streamOnce(
  ctx: ProxyContext,
  body: unknown,
): Promise<StreamedRequestResult> {
  const t0 = performance.now()
  const res = await fetch(`${ctx.baseUrl}/v1/messages`, {
    method: "POST",
    headers: anthropicHeaders(),
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(120_000),
  })
  if (!res.ok || !res.body) {
    return {
      status: res.status,
      ttft_ms: null,
      total_ms: Math.round(performance.now() - t0),
      cache_read_input_tokens: 0,
    }
  }
  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let ttft: number | null = null
  let buffer = ""
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    if (ttft === null) ttft = performance.now() - t0
    buffer += decoder.decode(value, { stream: true })
  }
  return {
    status: res.status,
    ttft_ms: ttft === null ? null : Math.round(ttft),
    total_ms: Math.round(performance.now() - t0),
    cache_read_input_tokens: extractStreamCacheRead(buffer),
  }
}

/** Build a large, deterministic context so both requests are byte-identical
 *  (a prerequisite for prompt-cache reuse). */
function largeContextBody(model: string): unknown {
  const filler =
    "Baseline harness context paragraph about proxy routing and translation. "
  return {
    model,
    max_tokens: 16,
    stream: true,
    messages: [
      {
        role: "user",
        content: `${filler.repeat(2600)}\n\nReply with exactly: OK`,
      },
    ],
  }
}

async function measureCaching(
  ctx: ProxyContext,
  model: string,
  cacheGapMs: number,
): Promise<CachingMetric> {
  const body = largeContextBody(model)
  const first = await streamOnce(ctx, body)
  if (cacheGapMs > 0) {
    await new Promise((resolve) => setTimeout(resolve, cacheGapMs))
  }
  const second = await streamOnce(ctx, body)
  const verdict = assessCaching({
    firstCacheRead: first.cache_read_input_tokens,
    secondCacheRead: second.cache_read_input_tokens,
  })
  return {
    measured: true,
    model,
    cache_gap_ms: cacheGapMs,
    first,
    second,
    verdict,
    note:
      "Measures the reuse observable from here (fast repeat via upstream "
      + "prompt_cache_key). prompt_cache_retention:\"24h\" is commented out at "
      + "src/routes/messages/responses-translation.ts:87, so there is no 24h "
      + "retention — reuse decays once the upstream window closes. Workstream "
      + "(4) enables retention; re-run this after the gap grows past the "
      + "upstream window to prove 24h reuse.",
  }
}

async function measureWarmup(ctx: ProxyContext): Promise<WarmupMetric> {
  const samples: WarmupMetric["samples"] = []
  for (let i = 0; i < 3; i++) {
    const t0 = performance.now()
    try {
      const res = await fetch(`${ctx.baseUrl}/v1/messages`, {
        method: "POST",
        headers: anthropicHeaders({ "anthropic-beta": "claude-code-20250219" }),
        body: JSON.stringify({
          model: WARMUP_MODEL,
          max_tokens: 1,
          messages: [{ role: "user", content: "Warmup" }],
        }),
        signal: AbortSignal.timeout(60_000),
      })
      const json = (await res.json()) as { model?: unknown }
      samples.push({
        status: res.status,
        total_ms: Math.round(performance.now() - t0),
        resolved_model: typeof json.model === "string" ? json.model : null,
      })
    } catch {
      samples.push({
        status: 0,
        total_ms: Math.round(performance.now() - t0),
        resolved_model: null,
      })
    }
  }
  return {
    measured: true,
    samples,
    median_ms: median(samples.map((s) => s.total_ms)),
    note:
      "Baseline: warmup is forced onto the small model (handler.ts:86) and "
      + "round-trips to gpt-5-mini upstream. Workstream (3) short-circuits it "
      + "to a canned local response (target: near-zero). resolved_model shows "
      + "the upstream model the round-trip actually hit.",
  }
}

async function measureCost(ctx: ProxyContext): Promise<CostMetric> {
  try {
    const res = await fetch(`${ctx.baseUrl}/token-usage?period=day`, {
      signal: AbortSignal.timeout(10_000),
    })
    if (!res.ok) {
      return {
        measured: false,
        visibility: null,
        note: `token-usage returned ${res.status}`,
      }
    }
    const summary: unknown = await res.json()
    const visibility = assessCostVisibility(summary)
    return {
      measured: true,
      visibility,
      note:
        "total_nano_aiu is captured in the store (store.ts) but this checks "
        + "whether the token-usage summary API exposes it. Baseline: the "
        + "summary omits it and the dashboard (shell/ui/dashboard/main.js) "
        + "renders token counts only — cost is captured but NOT UI-surfaced. "
        + "Workstream (2) surfaces it; expect fieldPresent+captured to flip "
        + "true here and a cost figure to appear in the dashboard.",
    }
  } catch (err) {
    return {
      measured: false,
      visibility: null,
      note: `token-usage unreachable: ${String(err)}`,
    }
  }
}

// ────────────────────────────────────────────────────────────────────
// CLI
// ────────────────────────────────────────────────────────────────────

interface Args {
  label: string
  baseUrl: string
  model: string
  cacheGapMs: number
}

export function parseArgs(argv: Array<string>): Args {
  const get = (flag: string): string | undefined => {
    const idx = argv.indexOf(flag)
    return idx >= 0 && idx + 1 < argv.length ? argv[idx + 1] : undefined
  }
  const label = get("--label") ?? "unlabeled"
  const baseUrl =
    get("--base-url") ?? process.env.MAXIMAL_BASE_URL ?? DEFAULT_BASE_URL
  const model =
    get("--model") ?? process.env.MAXIMAL_MEASURE_MODEL ?? DEFAULT_MEASURE_MODEL
  const gapRaw = get("--cache-gap-ms")
  const cacheGapMs =
    gapRaw !== undefined ? Number.parseInt(gapRaw, 10) : DEFAULT_CACHE_GAP_MS
  return {
    label,
    baseUrl: baseUrl.replace(/\/$/, ""),
    model,
    cacheGapMs: Number.isFinite(cacheGapMs) ? cacheGapMs : DEFAULT_CACHE_GAP_MS,
  }
}

function printNoProxyGuidance(args: Args): void {
  console.error("")
  console.error("  No live proxy at " + args.baseUrl + " — cannot capture a")
  console.error("  live baseline. This is expected without GitHub Copilot auth.")
  console.error("")
  console.error("  To capture live numbers once an authenticated proxy exists:")
  console.error("")
  console.error("    # Terminal A — start the proxy from source (needs auth):")
  console.error("    bun run dev -- start --port 4141")
  console.error("")
  console.error("    # Terminal B — run the harness:")
  console.error("    bun run measure:baseline -- --label before")
  console.error("")
  console.error("  See reports/baseline-README.md for the documented baseline.")
  console.error("")
}

function printHuman(report: BaselineReport): void {
  const { metrics } = report
  console.log("")
  console.log(`  Baseline: ${report.label}  (${report.captured_at_utc})`)
  console.log(`  Proxy:    ${report.base_url}`)
  console.log("  " + "─".repeat(60))

  console.log("  (2) Cost visibility (total_nano_aiu in token-usage summary)")
  const v = metrics.cost.visibility
  if (metrics.cost.measured && v) {
    console.log(`      field present: ${v.fieldPresent}`)
    console.log(`      cost captured: ${v.captured}  (value: ${v.value})`)
    console.log(
      `      → ${v.fieldPresent ? "surfaced by API" : "NOT surfaced by API (baseline)"}`,
    )
  } else {
    console.log(`      not measured: ${metrics.cost.note}`)
  }

  console.log("  (3) Warmup round-trip latency")
  if (metrics.warmup.measured) {
    console.log(`      median: ${metrics.warmup.median_ms} ms`)
    for (const s of metrics.warmup.samples) {
      console.log(
        `        ${s.total_ms} ms  (status ${s.status}, model ${s.resolved_model})`,
      )
    }
  } else {
    console.log(`      not measured: ${metrics.warmup.note}`)
  }

  console.log("  (4) /responses prompt caching")
  const c = metrics.caching
  if (c.measured && c.first && c.second) {
    console.log(`      model: ${c.model}  (gap ${c.cache_gap_ms} ms)`)
    console.log(
      `      first : ttft ${c.first.ttft_ms} ms, total ${c.first.total_ms} ms, `
        + `cache_read ${c.first.cache_read_input_tokens}`,
    )
    console.log(
      `      second: ttft ${c.second.ttft_ms} ms, total ${c.second.total_ms} ms, `
        + `cache_read ${c.second.cache_read_input_tokens}`,
    )
    console.log(
      `      → cache reused: ${c.verdict?.reused} (delta ${c.verdict?.delta})`,
    )
  } else {
    console.log(`      not measured: ${c.note}`)
  }
  console.log("  " + "─".repeat(60))
  console.log("")
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))
  const ctx: ProxyContext = { baseUrl: args.baseUrl }
  const reachable = await isProxyReachable(args.baseUrl)

  const emptyCaching: CachingMetric = {
    measured: false,
    model: args.model,
    cache_gap_ms: args.cacheGapMs,
    first: null,
    second: null,
    verdict: null,
    note: "proxy not reachable",
  }
  const emptyWarmup: WarmupMetric = {
    measured: false,
    samples: [],
    median_ms: null,
    note: "proxy not reachable",
  }
  const emptyCost: CostMetric = {
    measured: false,
    visibility: null,
    note: "proxy not reachable",
  }

  const report: BaselineReport = {
    label: args.label,
    captured_at_utc: new Date().toISOString(),
    base_url: args.baseUrl,
    proxy_reachable: reachable,
    harness_version: HARNESS_VERSION,
    metrics: {
      cost: reachable ? await measureCost(ctx) : emptyCost,
      warmup: reachable ? await measureWarmup(ctx) : emptyWarmup,
      caching:
        reachable ?
          await measureCaching(ctx, args.model, args.cacheGapMs)
        : emptyCaching,
    },
  }

  if (!reachable) printNoProxyGuidance(args)
  printHuman(report)

  const outPath = `reports/baseline-${args.label}.json`
  await Bun.write(outPath, JSON.stringify(report, null, 2) + "\n")
  console.log(`  Report written: ${outPath}`)
  console.log("")

  if (!reachable) process.exitCode = 2
}

if (import.meta.main) {
  await main()
}
