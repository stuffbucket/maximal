import consola from "consola"
import path from "node:path"

import { PATHS } from "~/lib/platform/paths"
import { registerProcessCleanup } from "~/lib/platform/process-cleanup"
import {
  type Migration,
  isSqliteRuntimeSupported,
  runMigrations,
  SqliteDbStore,
  type SqliteDatabase,
} from "~/lib/platform/sqlite"

export type TokenUsageSource = "copilot" | "provider"

export type TokenUsageEndpoint =
  | "chat_completions"
  | "embeddings"
  | "messages"
  | "provider_messages"
  | "responses"

export type TokenUsagePeriod = "day" | "week" | "month" | "all"

export interface UsageTokens {
  cache_creation_input_tokens?: number | null
  cache_read_input_tokens?: number | null
  input_tokens?: number | null
  output_tokens?: number | null
  total_tokens?: number | null
  /** Copilot per-request cost in nano-AIU (copilot_usage.total_nano_aiu).
   *  Authoritative billing signal under usage-based billing. */
  total_nano_aiu?: number | null
}

export interface PersistedTokenUsageEvent {
  cache_creation_input_tokens: number
  cache_read_input_tokens: number
  created_at_ms: number
  created_at_utc: string
  endpoint: TokenUsageEndpoint
  input_tokens: number
  model: string
  output_tokens: number
  provider_name: string | null
  session_id: string
  source: TokenUsageSource
  total_tokens: number
  total_nano_aiu: number
  /** 1 = premium model, 0 = included, null = unknown (model not in catalog
   *  at record time, or a pre-capture row). SQLite stores 0/1/NULL. */
  is_premium: number | null
  trace_id: string
  user_id: string
}

export interface TokenUsageTotals {
  cache_creation_input_tokens: number
  cache_read_input_tokens: number
  input_tokens: number
  output_tokens: number
  request_count: number
  total_tokens: number
  total_nano_aiu: number
}

export interface TokenUsageModelSummary extends TokenUsageTotals {
  model: string
  /** Premium status for this model, if known (from the model catalog's
   *  billing.is_premium). null when no row carried a known value. */
  is_premium: boolean | null
}

/**
 * Per-provider rollup (GROUP BY source, provider_name). The UI's provider
 * dimension: today one row (`copilot`), but the shape is provider-forward so
 * additional upstreams (`source: "provider"`, keyed by `provider_name`) fan out
 * here without a schema change. `provider` is the display/stable key — `copilot`
 * for the built-in path, else the `provider_name`.
 */
export interface TokenUsageProviderSummary extends TokenUsageTotals {
  source: TokenUsageSource
  provider_name: string | null
  provider: string
}

export interface TokenUsageEventRecord {
  cache_creation_input_tokens: number
  cache_read_input_tokens: number
  created_at_ms: number
  created_at_utc: string
  endpoint: TokenUsageEndpoint
  id: number
  input_tokens: number
  model: string
  output_tokens: number
  provider_name: string | null
  session_id: string
  source: TokenUsageSource
  total_tokens: number
  total_nano_aiu: number
  is_premium: boolean | null
  trace_id: string
  user_id: string
}

export interface TokenUsageSummary {
  byModel: Array<TokenUsageModelSummary>
  byProvider: Array<TokenUsageProviderSummary>
  period: TokenUsagePeriod
  range: {
    end_ms: number
    end_utc: string
    start_ms: number
    start_utc: string
  }
  totals: TokenUsageTotals
}

/**
 * One time bucket of the usage series (§4 live/trend charts). Buckets are
 * fixed-width windows of `created_at_ms` (floor to `bucketMs`), carrying the
 * token-type split so a stacked area (input / output / cache) renders directly.
 * `request_count` drives the per-bucket density read.
 */
export interface TokenUsageSeriesBucket extends TokenUsageTotals {
  bucket_start_ms: number
}

export interface TokenUsageSeries {
  buckets: Array<TokenUsageSeriesBucket>
  bucket_ms: number
  period: TokenUsagePeriod
  range: {
    end_ms: number
    end_utc: string
    start_ms: number
    start_utc: string
  }
}

export interface TokenUsageEventsPage {
  items: Array<TokenUsageEventRecord>
  page: number
  page_size: number
  period: TokenUsagePeriod
  range: {
    end_ms: number
    end_utc: string
    start_ms: number
    start_utc: string
  }
  total: number
  total_pages: number
}

const DB_PATH_ENV = "COPILOT_API_SQLITE_DB_PATH"
const DEFAULT_DB_FILENAME = "copilot-api.sqlite"

let writeQueue: Promise<void> = Promise.resolve()

function getDbPath(): string {
  return (
    process.env[DB_PATH_ENV] ?? path.join(PATHS.APP_DIR, DEFAULT_DB_FILENAME)
  )
}

const tokenUsageDbStore = new SqliteDbStore({
  getPath: getDbPath,
  initialize: initializeTokenUsageDb,
})

function getDb(): Promise<SqliteDatabase> {
  return tokenUsageDbStore.getDb()
}

export function isTokenUsageStorageEnabled(): boolean {
  return isSqliteRuntimeSupported()
}

function initializeTokenUsageDb(db: SqliteDatabase): void {
  db.exec("PRAGMA journal_mode = WAL")
  db.exec("PRAGMA busy_timeout = 5000")
  // Baseline schema (schema version 0). CREATE ... IF NOT EXISTS + the two
  // legacy ensureColumn calls are idempotent and predate the versioned
  // migration framework, so they stay as the v0 floor for DBs created before
  // it. New schema changes go through TOKEN_USAGE_MIGRATIONS below.
  db.exec(`
    CREATE TABLE IF NOT EXISTS token_usage_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      created_at_ms INTEGER NOT NULL,
      created_at_utc TEXT NOT NULL,
      trace_id TEXT NOT NULL,
      session_id TEXT NOT NULL DEFAULT '',
      user_id TEXT NOT NULL DEFAULT '',
      source TEXT NOT NULL,
      endpoint TEXT NOT NULL,
      provider_name TEXT,
      model TEXT NOT NULL,
      input_tokens INTEGER NOT NULL DEFAULT 0,
      output_tokens INTEGER NOT NULL DEFAULT 0,
      cache_read_input_tokens INTEGER NOT NULL DEFAULT 0,
      cache_creation_input_tokens INTEGER NOT NULL DEFAULT 0,
      total_tokens INTEGER NOT NULL DEFAULT 0
    )
  `)
  ensureColumn(db, "user_id", "TEXT NOT NULL DEFAULT ''")
  ensureColumn(db, "total_tokens", "INTEGER NOT NULL DEFAULT 0")

  // Versioned migrations for everything after the v0 baseline. Runs on every
  // open; already-applied steps are skipped via PRAGMA user_version.
  runMigrations(db, TOKEN_USAGE_MIGRATIONS)

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_token_usage_events_created_at_ms
    ON token_usage_events(created_at_ms)
  `)
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_token_usage_events_model
    ON token_usage_events(model)
  `)
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_token_usage_events_trace_id
    ON token_usage_events(trace_id)
  `)
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_token_usage_events_session_id
    ON token_usage_events(session_id)
  `)
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_token_usage_events_user_id
    ON token_usage_events(user_id)
  `)
}

// Ordered, append-only. Each entry advances user_version by one; NEVER
// reorder or edit a shipped migration (that would desync already-migrated
// DBs) — only append.
export const TOKEN_USAGE_MIGRATIONS: Array<Migration> = [
  {
    // Copilot returns per-request cost (`copilot_usage.total_nano_aiu`) and
    // each model advertises `billing.is_premium`. Capture both so usage can
    // be costed and split premium/included. Existing rows predate capture:
    // total_nano_aiu backfills to 0 (cost was never recorded and can't be
    // known retroactively), is_premium to NULL (genuinely unknown).
    name: "add total_nano_aiu + is_premium",
    up: (db) => {
      db.exec(
        "ALTER TABLE token_usage_events ADD COLUMN total_nano_aiu INTEGER NOT NULL DEFAULT 0",
      )
      db.exec("ALTER TABLE token_usage_events ADD COLUMN is_premium INTEGER")
    },
  },
  {
    // Forward-looking (spec §5): a nullable per-project attribution key so the
    // schema/filter/route exist BEFORE per-project tracking turns on. It will be
    // populated later — from `api_key_id` first, then a client-supplied
    // `workspace` header — never from the ephemeral, high-cardinality
    // `session_id` (which would flood the rail). Existing rows predate it and
    // stay NULL (unattributed), which is the correct "no project" reading.
    name: "add nullable project_id",
    up: (db) => {
      db.exec("ALTER TABLE token_usage_events ADD COLUMN project_id TEXT")
    },
  },
]

function ensureColumn(
  db: SqliteDatabase,
  name: string,
  definition: string,
): void {
  const rows = db
    .prepare("PRAGMA table_info(token_usage_events)")
    .all() as Array<Record<string, unknown>>
  const hasColumn = rows.some((row) => row.name === name)
  if (!hasColumn) {
    db.exec(`ALTER TABLE token_usage_events ADD COLUMN ${name} ${definition}`)
  }
}

export function normalizeToken(value: number | null | undefined): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return 0
  }
  return Math.max(0, Math.floor(value))
}

export function normalizeOptionalToken(
  value: number | null | undefined,
): number | undefined {
  return value === null || value === undefined ?
      undefined
    : normalizeToken(value)
}

export function hasAnyToken(tokens: UsageTokens): boolean {
  return (
    normalizeToken(tokens.input_tokens) > 0
    || normalizeToken(tokens.output_tokens) > 0
    || normalizeToken(tokens.cache_read_input_tokens) > 0
    || normalizeToken(tokens.cache_creation_input_tokens) > 0
    || normalizeToken(tokens.total_tokens) > 0
    // A recorded cost with no token counts is still a real, billable event
    // worth persisting (e.g. a tool-only turn).
    || normalizeToken(tokens.total_nano_aiu) > 0
  )
}

export function resolveTotalTokens(input: UsageTokens): number {
  const explicitTotal = normalizeOptionalToken(input.total_tokens)
  if (explicitTotal !== undefined) {
    return explicitTotal
  }
  return (
    normalizeToken(input.input_tokens)
    + normalizeToken(input.output_tokens)
    + normalizeToken(input.cache_read_input_tokens)
    + normalizeToken(input.cache_creation_input_tokens)
  )
}

async function writeTokenUsageEvent(
  event: PersistedTokenUsageEvent,
): Promise<void> {
  const db = await getDb()
  db.prepare(
    `
      INSERT INTO token_usage_events (
        created_at_ms,
        created_at_utc,
        trace_id,
        session_id,
        user_id,
        source,
        endpoint,
        provider_name,
        model,
        input_tokens,
        output_tokens,
        cache_read_input_tokens,
        cache_creation_input_tokens,
        total_tokens,
        total_nano_aiu,
        is_premium
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
  ).run(
    event.created_at_ms,
    event.created_at_utc,
    event.trace_id,
    event.session_id,
    event.user_id,
    event.source,
    event.endpoint,
    event.provider_name,
    event.model,
    event.input_tokens,
    event.output_tokens,
    event.cache_read_input_tokens,
    event.cache_creation_input_tokens,
    event.total_tokens,
    event.total_nano_aiu,
    event.is_premium,
  )
}

export function enqueueTokenUsageWrite(event: PersistedTokenUsageEvent): void {
  if (!isTokenUsageStorageEnabled()) {
    return
  }

  writeQueue = writeQueue
    .then(() => writeTokenUsageEvent(event))
    .catch((error: unknown) => {
      consola.warn("Failed to record token usage", error)
    })
}

async function flushTokenUsageEvents(): Promise<void> {
  let currentQueue = writeQueue
  while (true) {
    await currentQueue
    if (currentQueue === writeQueue) {
      return
    }
    currentQueue = writeQueue
  }
}

function getPeriodRange(period: TokenUsagePeriod, now = new Date()) {
  // All-time: from the epoch to now. A fixed lower bound (rather than a
  // MIN(created_at_ms) probe) keeps this pure and synchronous like the other
  // ranges; the UI labels it "All time" and never renders the 1970 start.
  if (period === "all") {
    return { endMs: now.getTime(), startMs: 0 }
  }

  const start = new Date(now)

  switch (period) {
    case "day": {
      start.setHours(0, 0, 0, 0)
      break
    }
    case "week": {
      const daysSinceMonday = (start.getDay() + 6) % 7
      start.setDate(start.getDate() - daysSinceMonday)
      start.setHours(0, 0, 0, 0)
      break
    }
    case "month": {
      start.setDate(1)
      start.setHours(0, 0, 0, 0)
      break
    }
    default: {
      break
    }
  }

  const end = new Date(start)
  switch (period) {
    case "day": {
      end.setDate(end.getDate() + 1)
      break
    }
    case "week": {
      end.setDate(end.getDate() + 7)
      break
    }
    case "month": {
      end.setMonth(end.getMonth() + 1)
      break
    }
    default: {
      break
    }
  }

  return {
    endMs: end.getTime(),
    startMs: start.getTime(),
  }
}

function createEmptyTotals(): TokenUsageTotals {
  return {
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
    input_tokens: 0,
    output_tokens: 0,
    request_count: 0,
    total_tokens: 0,
    total_nano_aiu: 0,
  }
}

function createEmptySummary(period: TokenUsagePeriod): TokenUsageSummary {
  const range = getPeriodRange(period)

  return {
    byModel: [],
    byProvider: [],
    period,
    range: {
      end_ms: range.endMs,
      end_utc: new Date(range.endMs).toISOString(),
      start_ms: range.startMs,
      start_utc: new Date(range.startMs).toISOString(),
    },
    totals: createEmptyTotals(),
  }
}

function createEmptyEventsPage(input: {
  page: number
  pageSize: number
  period: TokenUsagePeriod
}): TokenUsageEventsPage {
  const range = getPeriodRange(input.period)
  const page = Math.max(1, Math.floor(input.page))
  const pageSize = Math.min(100, Math.max(1, Math.floor(input.pageSize)))

  return {
    items: [],
    page,
    page_size: pageSize,
    period: input.period,
    range: {
      end_ms: range.endMs,
      end_utc: new Date(range.endMs).toISOString(),
      start_ms: range.startMs,
      start_utc: new Date(range.startMs).toISOString(),
    },
    total: 0,
    total_pages: 1,
  }
}

function numberFromRow(
  row: Record<string, unknown> | undefined,
  key: string,
): number {
  const value = row?.[key]
  return typeof value === "number" && Number.isFinite(value) ? value : 0
}

function totalsFromRow(
  row: Record<string, unknown> | undefined,
): TokenUsageTotals {
  return {
    cache_creation_input_tokens: numberFromRow(
      row,
      "cache_creation_input_tokens",
    ),
    cache_read_input_tokens: numberFromRow(row, "cache_read_input_tokens"),
    input_tokens: numberFromRow(row, "input_tokens"),
    output_tokens: numberFromRow(row, "output_tokens"),
    request_count: numberFromRow(row, "request_count"),
    total_tokens: numberFromRow(row, "total_tokens"),
    total_nano_aiu: numberFromRow(row, "total_nano_aiu"),
  }
}

/** Map a SQLite is_premium cell (1/0/NULL) to boolean|null. In summaries
 *  the cell is `MAX(is_premium)` so a model with any known-premium row reads
 *  true; all-null (never captured) stays null. */
function premiumFromRow(
  row: Record<string, unknown>,
  key: string,
): boolean | null {
  const value = row[key]
  return typeof value === "number" ? value === 1 : null
}

function stringFromRow(row: Record<string, unknown>, key: string): string {
  const value = row[key]
  return typeof value === "string" ? value : ""
}

function nullableStringFromRow(
  row: Record<string, unknown>,
  key: string,
): string | null {
  const value = row[key]
  return typeof value === "string" ? value : null
}

/** Stable display key for the provider dimension: the built-in Copilot path is
 *  always `copilot`; an external upstream is keyed by its `provider_name`,
 *  falling back to the generic `provider` when unnamed. */
function providerKey(
  source: TokenUsageSource,
  providerName: string | null,
): string {
  if (source === "copilot") return "copilot"
  return providerName && providerName.trim() ? providerName : "provider"
}

function usageEventFromRow(
  row: Record<string, unknown>,
): TokenUsageEventRecord {
  return {
    cache_creation_input_tokens: numberFromRow(
      row,
      "cache_creation_input_tokens",
    ),
    cache_read_input_tokens: numberFromRow(row, "cache_read_input_tokens"),
    created_at_ms: numberFromRow(row, "created_at_ms"),
    created_at_utc: stringFromRow(row, "created_at_utc"),
    endpoint: stringFromRow(row, "endpoint") as TokenUsageEndpoint,
    id: numberFromRow(row, "id"),
    input_tokens: numberFromRow(row, "input_tokens"),
    model: stringFromRow(row, "model") || "unknown",
    output_tokens: numberFromRow(row, "output_tokens"),
    provider_name: nullableStringFromRow(row, "provider_name"),
    session_id: stringFromRow(row, "session_id"),
    source: stringFromRow(row, "source") as TokenUsageSource,
    total_tokens: numberFromRow(row, "total_tokens"),
    total_nano_aiu: numberFromRow(row, "total_nano_aiu"),
    is_premium: premiumFromRow(row, "is_premium"),
    trace_id: stringFromRow(row, "trace_id"),
    user_id: stringFromRow(row, "user_id"),
  }
}

export async function getTokenUsageSummary(
  period: TokenUsagePeriod,
): Promise<TokenUsageSummary> {
  if (!isTokenUsageStorageEnabled()) {
    return createEmptySummary(period)
  }

  await flushTokenUsageEvents()
  const range = getPeriodRange(period)
  const db = await getDb()
  const totalsRow = db
    .prepare(
      `
    SELECT
      COUNT(*) AS request_count,
      COALESCE(SUM(input_tokens), 0) AS input_tokens,
      COALESCE(SUM(output_tokens), 0) AS output_tokens,
      COALESCE(SUM(cache_read_input_tokens), 0) AS cache_read_input_tokens,
      COALESCE(SUM(cache_creation_input_tokens), 0) AS cache_creation_input_tokens,
      COALESCE(SUM(total_tokens), 0) AS total_tokens,
      COALESCE(SUM(total_nano_aiu), 0) AS total_nano_aiu
    FROM token_usage_events
    WHERE created_at_ms >= ? AND created_at_ms < ?
  `,
    )
    .get(range.startMs, range.endMs) as Record<string, unknown> | undefined

  const byModelRows = db
    .prepare(
      `
    SELECT
      model,
      COUNT(*) AS request_count,
      COALESCE(SUM(input_tokens), 0) AS input_tokens,
      COALESCE(SUM(output_tokens), 0) AS output_tokens,
      COALESCE(SUM(cache_read_input_tokens), 0) AS cache_read_input_tokens,
      COALESCE(SUM(cache_creation_input_tokens), 0) AS cache_creation_input_tokens,
      COALESCE(SUM(total_tokens), 0) AS total_tokens,
      COALESCE(SUM(total_nano_aiu), 0) AS total_nano_aiu,
      MAX(is_premium) AS is_premium
    FROM token_usage_events
    WHERE created_at_ms >= ? AND created_at_ms < ?
    GROUP BY model
    ORDER BY
      total_tokens DESC,
      model ASC
  `,
    )
    .all(range.startMs, range.endMs) as Array<Record<string, unknown>>

  // Provider dimension (§4). GROUP BY the raw (source, provider_name) pair; a
  // NULL provider_name for a `provider` row collapses under COALESCE so it is
  // still one bucket. Ordered by traffic so the dominant provider leads.
  const byProviderRows = db
    .prepare(
      `
    SELECT
      source,
      provider_name,
      COUNT(*) AS request_count,
      COALESCE(SUM(input_tokens), 0) AS input_tokens,
      COALESCE(SUM(output_tokens), 0) AS output_tokens,
      COALESCE(SUM(cache_read_input_tokens), 0) AS cache_read_input_tokens,
      COALESCE(SUM(cache_creation_input_tokens), 0) AS cache_creation_input_tokens,
      COALESCE(SUM(total_tokens), 0) AS total_tokens,
      COALESCE(SUM(total_nano_aiu), 0) AS total_nano_aiu
    FROM token_usage_events
    WHERE created_at_ms >= ? AND created_at_ms < ?
    GROUP BY source, provider_name
    ORDER BY
      total_tokens DESC,
      source ASC
  `,
    )
    .all(range.startMs, range.endMs) as Array<Record<string, unknown>>

  return {
    byModel: byModelRows.map((row) => ({
      ...totalsFromRow(row),
      model: typeof row.model === "string" ? row.model : "unknown",
      is_premium: premiumFromRow(row, "is_premium"),
    })),
    byProvider: byProviderRows.map((row) => {
      const source = stringFromRow(row, "source") as TokenUsageSource
      const providerName = nullableStringFromRow(row, "provider_name")
      return {
        ...totalsFromRow(row),
        source,
        provider_name: providerName,
        provider: providerKey(source, providerName),
      }
    }),
    period,
    range: {
      end_ms: range.endMs,
      end_utc: new Date(range.endMs).toISOString(),
      start_ms: range.startMs,
      start_utc: new Date(range.startMs).toISOString(),
    },
    totals: totalsFromRow(totalsRow),
  }
}

export async function getTokenUsageEventsPage(input: {
  page: number
  pageSize: number
  period: TokenUsagePeriod
}): Promise<TokenUsageEventsPage> {
  if (!isTokenUsageStorageEnabled()) {
    return createEmptyEventsPage(input)
  }

  await flushTokenUsageEvents()
  const range = getPeriodRange(input.period)
  const page = Math.max(1, Math.floor(input.page))
  const pageSize = Math.min(100, Math.max(1, Math.floor(input.pageSize)))
  const offset = (page - 1) * pageSize
  const db = await getDb()

  const totalRow = db
    .prepare(
      `
    SELECT COUNT(*) AS total
    FROM token_usage_events
    WHERE created_at_ms >= ? AND created_at_ms < ?
  `,
    )
    .get(range.startMs, range.endMs) as Record<string, unknown> | undefined

  const rows = db
    .prepare(
      `
    SELECT
      id,
      created_at_ms,
      created_at_utc,
      trace_id,
      session_id,
      user_id,
      source,
      endpoint,
      provider_name,
      model,
      input_tokens,
      output_tokens,
      cache_read_input_tokens,
      cache_creation_input_tokens,
      total_tokens,
      total_nano_aiu,
      is_premium
    FROM token_usage_events
    WHERE created_at_ms >= ? AND created_at_ms < ?
    ORDER BY created_at_ms DESC, id DESC
    LIMIT ? OFFSET ?
  `,
    )
    .all(range.startMs, range.endMs, pageSize, offset) as Array<
    Record<string, unknown>
  >

  const total = numberFromRow(totalRow, "total")

  return {
    items: rows.map((row) => usageEventFromRow(row)),
    page,
    page_size: pageSize,
    period: input.period,
    range: {
      end_ms: range.endMs,
      end_utc: new Date(range.endMs).toISOString(),
      start_ms: range.startMs,
      start_utc: new Date(range.startMs).toISOString(),
    },
    total,
    total_pages: Math.max(1, Math.ceil(total / pageSize)),
  }
}

/** Aim for ~this many buckets across a period; cap the total so an all-time
 *  query over a wide span can't emit an unbounded (zero-filled) series. */
const SERIES_TARGET_BUCKETS = 60
const SERIES_MAX_BUCKETS = 500
const MINUTE_MS = 60_000
const HOUR_MS = 3_600_000
const DAY_MS = 86_400_000

/** Pick a bucket width for a series: an explicit request wins (clamped so the
 *  span can't exceed SERIES_MAX_BUCKETS), else a period-appropriate default. */
function resolveBucketMs(input: {
  period: TokenUsagePeriod
  startMs: number
  endMs: number
  requestedMs?: number
}): number {
  const { period, startMs, endMs, requestedMs } = input
  const span = Math.max(1, endMs - startMs)
  let base: number
  if (
    requestedMs !== undefined
    && Number.isFinite(requestedMs)
    && requestedMs > 0
  ) {
    base = Math.floor(requestedMs)
  } else {
    switch (period) {
      case "day": {
        base = HOUR_MS
        break
      }
      case "week":
      case "month": {
        base = DAY_MS
        break
      }
      default: {
        // all-time: size to the target bucket count over the real span
        base = Math.max(DAY_MS, Math.ceil(span / SERIES_TARGET_BUCKETS))
        break
      }
    }
  }
  const floor = Math.ceil(span / SERIES_MAX_BUCKETS)
  return Math.max(base, floor, MINUTE_MS)
}

function createEmptySeries(period: TokenUsagePeriod): TokenUsageSeries {
  const range = getPeriodRange(period)
  return {
    buckets: [],
    bucket_ms: resolveBucketMs({
      period,
      startMs: range.startMs,
      endMs: range.endMs,
    }),
    period,
    range: {
      end_ms: range.endMs,
      end_utc: new Date(range.endMs).toISOString(),
      start_ms: range.startMs,
      start_utc: new Date(range.startMs).toISOString(),
    },
  }
}

/**
 * Time-bucketed token series for the trend/live charts (§4). Buckets floor
 * `created_at_ms` to a fixed width and carry the token-type split so a stacked
 * area renders directly. Empty buckets are zero-filled between the first and
 * last populated windows so the chart has a continuous x-axis (the count is
 * bounded by SERIES_MAX_BUCKETS). For "all", the range is tightened to the real
 * min/max event time so the buckets track the data, not the epoch.
 */
export async function getTokenUsageSeries(input: {
  period: TokenUsagePeriod
  bucketMs?: number
}): Promise<TokenUsageSeries> {
  const period = input.period
  if (!isTokenUsageStorageEnabled()) {
    return createEmptySeries(period)
  }

  await flushTokenUsageEvents()
  const db = await getDb()

  let { startMs, endMs } = getPeriodRange(period)
  if (period === "all") {
    const bounds = db
      .prepare(
        "SELECT MIN(created_at_ms) AS min_ms, MAX(created_at_ms) AS max_ms FROM token_usage_events",
      )
      .get() as Record<string, unknown> | undefined
    const maxMs = numberFromRow(bounds, "max_ms")
    if (maxMs > 0) {
      startMs = numberFromRow(bounds, "min_ms")
      endMs = maxMs + 1
    } else {
      // No data — show a single day's empty axis rather than 56 years of it.
      startMs = endMs - DAY_MS
    }
  }

  const bucketMs = resolveBucketMs({
    period,
    startMs,
    endMs,
    requestedMs: input.bucketMs,
  })

  const rows = db
    .prepare(
      `
    SELECT
      (CAST(created_at_ms / ? AS INTEGER)) * ? AS bucket_start_ms,
      COUNT(*) AS request_count,
      COALESCE(SUM(input_tokens), 0) AS input_tokens,
      COALESCE(SUM(output_tokens), 0) AS output_tokens,
      COALESCE(SUM(cache_read_input_tokens), 0) AS cache_read_input_tokens,
      COALESCE(SUM(cache_creation_input_tokens), 0) AS cache_creation_input_tokens,
      COALESCE(SUM(total_tokens), 0) AS total_tokens,
      COALESCE(SUM(total_nano_aiu), 0) AS total_nano_aiu
    FROM token_usage_events
    WHERE created_at_ms >= ? AND created_at_ms < ?
    GROUP BY bucket_start_ms
    ORDER BY bucket_start_ms ASC
  `,
    )
    .all(bucketMs, bucketMs, startMs, endMs) as Array<Record<string, unknown>>

  const byBucket = new Map<number, TokenUsageTotals>()
  for (const row of rows) {
    byBucket.set(numberFromRow(row, "bucket_start_ms"), totalsFromRow(row))
  }

  // Zero-fill from the first aligned bucket up to (not including) endMs.
  const firstBucket = Math.floor(startMs / bucketMs) * bucketMs
  const buckets: Array<TokenUsageSeriesBucket> = []
  for (let t = firstBucket; t < endMs; t += bucketMs) {
    const totals = byBucket.get(t) ?? createEmptyTotals()
    buckets.push({ ...totals, bucket_start_ms: t })
  }

  return {
    buckets,
    bucket_ms: bucketMs,
    period,
    range: {
      end_ms: endMs,
      end_utc: new Date(endMs).toISOString(),
      start_ms: startMs,
      start_utc: new Date(startMs).toISOString(),
    },
  }
}

export async function closeUsageStore(): Promise<void> {
  await flushTokenUsageEvents()
  await tokenUsageDbStore.close({
    beforeClose: (db) => {
      try {
        db.exec("PRAGMA wal_checkpoint(TRUNCATE)")
      } catch {
        // Ignore cleanup errors in tests.
      }
    },
  })
  writeQueue = Promise.resolve()
}

registerProcessCleanup(closeUsageStore)
