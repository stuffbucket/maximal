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
 *   # More warmup samples + drop the first N cold-start samples from stats
 *   bun run measure:baseline -- --label before --samples 20 --discard 2
 *
 *   # Skip the caching probe's inter-request wait (default 3000ms)
 *   bun run measure:baseline -- --label before --cache-gap-ms 0
 *
 *   # A/B compare two proxies with INTERLEAVED warmup sampling + a
 *   # significance test (both arms see the same congestion window):
 *   bun run measure:baseline -- --label old-vs-new \
 *     --base-url http://127.0.0.1:4141 --compare http://127.0.0.1:4142 --samples 20
 *
 * On timing noise: single before/after runs taken minutes apart can't
 * separate a real delta from upstream congestion. For small deltas (caching,
 * future WebSocket TTFT) use --compare, which interleaves A/B so both share
 * the same congestion and reports a Mann–Whitney p-value; the order-of-
 * magnitude warmup short-circuit delta is safe to read from a single run.
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
/** Warmup latency samples per run. n≈8 gives enough spread to compute a stable
 *  p50 and a Mann–Whitney verdict against another run. */
const DEFAULT_SAMPLES = 8
/** Leading samples discarded before stats (cold connection / model warm-up). */
const DEFAULT_DISCARD = 1
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
  /** Dispersion across the (post-discard) samples — lets a reader judge
   *  whether a between-run delta exceeds this run's own spread. */
  stats: LatencyStats | null
  /** How many leading samples were discarded as cold-start warmups. */
  discarded: number
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

/**
 * The p-th percentile (0..100) via linear interpolation between ranks, or null
 * for an empty list. p50 equals the median for odd lists (even lists differ by
 * the interpolation method — that's fine; we report both p50 and median).
 */
export function percentile(values: Array<number>, p: number): number | null {
  if (values.length === 0) return null
  if (values.length === 1) return values[0]
  const sorted = [...values].sort((a, b) => a - b)
  const rank = (p / 100) * (sorted.length - 1)
  const lo = Math.floor(rank)
  const hi = Math.ceil(rank)
  if (lo === hi) return sorted[lo]
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (rank - lo)
}

/** Arithmetic mean, or null for an empty list. */
export function mean(values: Array<number>): number | null {
  if (values.length === 0) return null
  return values.reduce((a, b) => a + b, 0) / values.length
}

/** Sample standard deviation (n-1), or null for fewer than 2 values. */
export function stdev(values: Array<number>): number | null {
  if (values.length < 2) return null
  const m = mean(values) as number
  const variance =
    values.reduce((acc, v) => acc + (v - m) ** 2, 0) / (values.length - 1)
  return Math.sqrt(variance)
}

export interface LatencyStats {
  n: number
  min: number | null
  p50: number | null
  p90: number | null
  max: number | null
  mean: number | null
  stdev: number | null
}

/** Summarize a latency sample set with the dispersion needed to judge whether
 *  a between-run delta is real or just spread. All ms, rounded for display. */
export function summarizeSamples(values: Array<number>): LatencyStats {
  const round = (v: number | null): number | null =>
    v === null ? null : Math.round(v)
  return {
    n: values.length,
    min: values.length ? Math.min(...values) : null,
    p50: round(percentile(values, 50)),
    p90: round(percentile(values, 90)),
    max: values.length ? Math.max(...values) : null,
    mean: round(mean(values)),
    stdev: round(stdev(values)),
  }
}

// ── Significance: Mann–Whitney U (nonparametric; no normality assumption,
//    which matters because latency distributions are right-skewed). Two-sided
//    normal approximation with tie + continuity correction. ──────────────────

/** Normal CDF via an Abramowitz–Stegun erf approximation (deterministic). */
export function normalCdf(z: number): number {
  const t = 1 / (1 + 0.3275911 * Math.abs(z / Math.SQRT2))
  const y =
    1 -
    ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) *
      t +
      0.254829592) *
      t *
      Math.exp(-((z / Math.SQRT2) ** 2))
  const erf = z >= 0 ? y : -y
  return 0.5 * (1 + erf)
}

/**
 * Mann–Whitney U with average-rank tie handling and a two-sided p-value from
 * the normal approximation (with continuity + tie correction). Returns the
 * U statistic and approximate p. Meaningful only for n≳8 per group; callers
 * gate the verdict on sample size.
 */
export function mannWhitneyU(
  a: Array<number>,
  b: Array<number>,
): { u: number; p: number } {
  const n1 = a.length
  const n2 = b.length
  if (n1 === 0 || n2 === 0) return { u: 0, p: 1 }
  const combined = [
    ...a.map((v) => ({ v, group: 0 })),
    ...b.map((v) => ({ v, group: 1 })),
  ].sort((x, y) => x.v - y.v)

  // Average ranks for ties.
  const ranks = new Array<number>(combined.length)
  const tieGroups: Array<number> = []
  let i = 0
  while (i < combined.length) {
    let j = i
    while (j + 1 < combined.length && combined[j + 1].v === combined[i].v) j++
    const avgRank = (i + j) / 2 + 1 // ranks are 1-based
    for (let k = i; k <= j; k++) ranks[k] = avgRank
    if (j > i) tieGroups.push(j - i + 1)
    i = j + 1
  }

  let rankSumA = 0
  for (let k = 0; k < combined.length; k++) {
    if (combined[k].group === 0) rankSumA += ranks[k]
  }
  const u1 = rankSumA - (n1 * (n1 + 1)) / 2
  const u2 = n1 * n2 - u1
  const u = Math.min(u1, u2)

  const n = n1 + n2
  const meanU = (n1 * n2) / 2
  const tieTerm =
    tieGroups.reduce((acc, t) => acc + (t ** 3 - t), 0) / (n * (n - 1))
  const sigma = Math.sqrt(((n1 * n2) / 12) * (n + 1 - tieTerm))
  if (sigma === 0) return { u, p: 1 }
  // Continuity correction, clamped so an exact tie at the mean stays z=0
  // (never pushed away from center by the -0.5).
  const z = Math.max(0, Math.abs(u - meanU) - 0.5) / sigma
  const p = 2 * (1 - normalCdf(Math.abs(z)))
  return { u, p: Math.min(1, Math.max(0, p)) }
}

export interface DeltaAssessment {
  /** p50(B) − p50(A), ms. Negative = B faster. */
  medianDeltaMs: number | null
  /** Percent change of p50 from A to B. */
  pctChange: number | null
  /** Two-sided Mann–Whitney p; null if either group is empty. */
  p: number | null
  /** true/false when both groups have ≥ minN samples; null = too few to judge. */
  significant: boolean | null
  note: string
}

/**
 * Compare two latency sample sets: report the p50 delta, % change, and a
 * significance verdict. `significant` is only asserted with enough samples
 * (minN per group) — otherwise null, so a tiny sample never masquerades as a
 * confident result. A significant delta means the change likely dominates
 * upstream-congestion noise; a null/false verdict means "re-run with more
 * samples or the delta is within noise."
 */
export function assessDelta(
  a: Array<number>,
  b: Array<number>,
  opts: { minN?: number; alpha?: number } = {},
): DeltaAssessment {
  const minN = opts.minN ?? 8
  const alpha = opts.alpha ?? 0.05
  const pa = percentile(a, 50)
  const pb = percentile(b, 50)
  if (pa === null || pb === null) {
    return {
      medianDeltaMs: null,
      pctChange: null,
      p: null,
      significant: null,
      note: "one or both sample sets are empty",
    }
  }
  const medianDeltaMs = Math.round(pb - pa)
  const pctChange = pa === 0 ? null : Math.round(((pb - pa) / pa) * 1000) / 10
  const { p } = mannWhitneyU(a, b)
  const enoughSamples = a.length >= minN && b.length >= minN
  const significant = enoughSamples ? p < alpha : null
  const note =
    !enoughSamples ?
      `too few samples for a confident verdict (need ≥${minN}/group; have ${a.length}/${b.length}) — treat as inconclusive`
    : significant ?
      `delta likely real (p≈${p.toFixed(3)} < ${alpha}); dominates congestion noise`
    : `delta within noise (p≈${p.toFixed(3)} ≥ ${alpha}); not distinguishable from congestion`
  return { medianDeltaMs, pctChange, p, significant, note }
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

async function warmupOnce(
  ctx: ProxyContext,
): Promise<WarmupMetric["samples"][number]> {
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
    return {
      status: res.status,
      total_ms: Math.round(performance.now() - t0),
      resolved_model: typeof json.model === "string" ? json.model : null,
    }
  } catch {
    return {
      status: 0,
      total_ms: Math.round(performance.now() - t0),
      resolved_model: null,
    }
  }
}

async function measureWarmup(
  ctx: ProxyContext,
  samples: number,
  discard: number,
): Promise<WarmupMetric> {
  const collected: WarmupMetric["samples"] = []
  for (let i = 0; i < samples; i++) {
    collected.push(await warmupOnce(ctx))
  }
  // Drop leading cold-start samples (connection/model warm-up) before stats,
  // but keep them in `samples` for transparency.
  const retained = collected.slice(Math.min(discard, collected.length))
  const retainedMs = retained
    .filter((s) => s.status === 200)
    .map((s) => s.total_ms)
  return {
    measured: true,
    samples: collected,
    median_ms: median(retainedMs),
    stats: summarizeSamples(retainedMs),
    discarded: Math.min(discard, collected.length),
    note:
      "Baseline: warmup is forced onto the small model (handler.ts:86) and "
      + "round-trips to gpt-5-mini upstream. Workstream (3) short-circuits it "
      + "to a canned local response (target: near-zero). Stats exclude the "
      + "first `discarded` cold-start sample(s); resolved_model shows the "
      + "upstream model the round-trip actually hit.",
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
  samples: number
  discard: number
  compareUrl: string | null
}

export function parseArgs(argv: Array<string>): Args {
  const get = (flag: string): string | undefined => {
    const idx = argv.indexOf(flag)
    return idx >= 0 && idx + 1 < argv.length ? argv[idx + 1] : undefined
  }
  const intArg = (flag: string, fallback: number): number => {
    const raw = get(flag)
    if (raw === undefined) return fallback
    const n = Number.parseInt(raw, 10)
    return Number.isFinite(n) ? n : fallback
  }
  const label = get("--label") ?? "unlabeled"
  const baseUrl =
    get("--base-url") ?? process.env.MAXIMAL_BASE_URL ?? DEFAULT_BASE_URL
  const model =
    get("--model") ?? process.env.MAXIMAL_MEASURE_MODEL ?? DEFAULT_MEASURE_MODEL
  const compareRaw = get("--compare")
  return {
    label,
    baseUrl: baseUrl.replace(/\/$/, ""),
    model,
    cacheGapMs: intArg("--cache-gap-ms", DEFAULT_CACHE_GAP_MS),
    samples: Math.max(1, intArg("--samples", DEFAULT_SAMPLES)),
    discard: Math.max(0, intArg("--discard", DEFAULT_DISCARD)),
    compareUrl: compareRaw ? compareRaw.replace(/\/$/, "") : null,
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
    const st = metrics.warmup.stats
    if (st) {
      console.log(
        `      p50 ${st.p50} ms  (n=${st.n}, p90 ${st.p90}, min ${st.min}, `
          + `max ${st.max}, stdev ${st.stdev}; discarded ${metrics.warmup.discarded})`,
      )
    } else {
      console.log(`      median: ${metrics.warmup.median_ms} ms`)
    }
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

  // Compare mode: interleave warmup samples between two proxies (A = base-url,
  // B = --compare) so both see the SAME upstream-congestion window, then run a
  // significance test on the paired samples. This is the honest way to tell a
  // real change from a quieter-upstream moment — separate before/after runs
  // taken minutes apart can't.
  if (args.compareUrl) {
    await runCompare(args)
    return
  }

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
    stats: null,
    discarded: 0,
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
      warmup:
        reachable ? await measureWarmup(ctx, args.samples, args.discard)
        : emptyWarmup,
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

/**
 * Interleaved A/B warmup comparison. Alternates one sample against A, one
 * against B, repeatedly — so transient congestion hits both arms roughly
 * equally — then reports each arm's dispersion and a Mann–Whitney verdict on
 * whether the p50 delta is real. Writes reports/compare-<label>.json.
 */
async function runCompare(args: Args): Promise<void> {
  const compareUrl = args.compareUrl as string
  const ctxA: ProxyContext = { baseUrl: args.baseUrl }
  const ctxB: ProxyContext = { baseUrl: compareUrl }
  const reachA = await isProxyReachable(args.baseUrl)
  const reachB = await isProxyReachable(compareUrl)
  if (!reachA || !reachB) {
    console.error("")
    console.error(`  Compare needs BOTH proxies reachable:`)
    console.error(`    A ${args.baseUrl}: ${reachA ? "ok" : "UNREACHABLE"}`)
    console.error(`    B ${compareUrl}: ${reachB ? "ok" : "UNREACHABLE"}`)
    console.error("")
    process.exitCode = 2
    return
  }

  const aMs: Array<number> = []
  const bMs: Array<number> = []
  for (let i = 0; i < args.samples; i++) {
    const a = await warmupOnce(ctxA)
    const b = await warmupOnce(ctxB)
    if (i >= args.discard) {
      if (a.status === 200) aMs.push(a.total_ms)
      if (b.status === 200) bMs.push(b.total_ms)
    }
  }

  const statsA = summarizeSamples(aMs)
  const statsB = summarizeSamples(bMs)
  const delta = assessDelta(aMs, bMs, { minN: DEFAULT_SAMPLES })
  const out = {
    label: args.label,
    captured_at_utc: new Date().toISOString(),
    mode: "compare-warmup",
    harness_version: HARNESS_VERSION,
    a: { base_url: args.baseUrl, stats: statsA },
    b: { base_url: compareUrl, stats: statsB },
    delta,
  }

  console.log("")
  console.log(`  A/B warmup compare: ${args.label}`)
  console.log(`    A ${args.baseUrl}: p50 ${statsA.p50} ms (n=${statsA.n}, `
    + `p90 ${statsA.p90}, stdev ${statsA.stdev})`)
  console.log(`    B ${compareUrl}: p50 ${statsB.p50} ms (n=${statsB.n}, `
    + `p90 ${statsB.p90}, stdev ${statsB.stdev})`)
  console.log(`    Δp50: ${delta.medianDeltaMs} ms `
    + `(${delta.pctChange === null ? "n/a" : `${delta.pctChange}%`})`)
  console.log(`    significant: ${delta.significant}  — ${delta.note}`)
  console.log("")

  const outPath = `reports/compare-${args.label}.json`
  await Bun.write(outPath, JSON.stringify(out, null, 2) + "\n")
  console.log(`  Report written: ${outPath}`)
  console.log("")
}

if (import.meta.main) {
  await main()
}
