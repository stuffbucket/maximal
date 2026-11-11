/**
 * Provider quota windows: the allowances a provider reports, normalised to
 * one shape whatever the provider. A provider reports zero or more windows
 * (Copilot's monthly premium allowance today; others report a rolling 5 h and
 * a weekly window, or per-model-class quotas).
 *
 * The registry keeps the latest window per `provider:id`, remembers the reset
 * before the current one (so a budget that follows the window knows when its
 * period started, and how long a cycle is), and persists both in the
 * token-usage database so they survive a restart.
 *
 * A window's counters are context only: they lag real spend. Budgets count
 * local `total_nano_aiu`; the window supplies only the reset.
 */

import consola from "consola"
import { z } from "zod"

import {
  enqueueUsageDbWrite,
  isTokenUsageStorageEnabled,
  readUsageDb,
} from "~/lib/token-usage/store"

const ProviderQuotaWindowSchema = z.object({
  provider: z.string().min(1),
  id: z.string().min(1),
  /** User-facing, e.g. "Copilot premium allowance". */
  label: z.string(),
  /** "credits" | "requests" | "tokens" | "percent", or a provider's own. */
  unit: z.string(),
  used: z.number().optional(),
  limit: z.number().optional(),
  percentRemaining: z.number().optional(),
  /** ISO; absent when the window never resets or the reset is unknown. */
  resetsAt: z.string().optional(),
  kind: z.enum(["fixed", "rolling"]).optional(),
  durationMs: z.number().positive().optional(),
  scope: z
    .object({
      models: z.array(z.string()).optional(),
      modelClass: z.string().optional(),
    })
    .optional(),
  overage: z
    .object({
      used: z.number().optional(),
      permitted: z.boolean().optional(),
    })
    .optional(),
  observedAt: z.string(),
  source: z.enum(["header", "endpoint"]),
})
export type ProviderQuotaWindow = z.infer<typeof ProviderQuotaWindowSchema>

/** A window plus the reset it reported before the current one. */
export interface ObservedProviderWindow extends ProviderQuotaWindow {
  previousResetsAt?: string
}

export function providerWindowRef(window: {
  provider: string
  id: string
}): string {
  return `${window.provider}:${window.id}`
}

function resetMs(window: { resetsAt?: string }): number | undefined {
  if (window.resetsAt === undefined) return undefined
  const ms = Date.parse(window.resetsAt)
  return Number.isFinite(ms) ? ms : undefined
}

/** Fold a new report into what was known. The previous reset is the latest
 *  known reset before the new one: the old current reset when it moved
 *  forward, else the old previous reset if it is still earlier (a reset that
 *  moved back comes from another account or an out-of-order reply). */
export function advanceProviderWindow(
  known: ObservedProviderWindow | undefined,
  next: ProviderQuotaWindow,
): ObservedProviderWindow {
  const nextMs = resetMs(next)
  if (known === undefined || nextMs === undefined) return { ...next }
  const earlier = [known.resetsAt, known.previousResetsAt]
    .map((iso) => ({ iso, ms: resetMs({ resetsAt: iso }) }))
    .filter(
      (entry): entry is { iso: string; ms: number } =>
        entry.iso !== undefined && entry.ms !== undefined && entry.ms < nextMs,
    )
    .sort((a, b) => b.ms - a.ms)
  return earlier.length > 0 ?
      { ...next, previousResetsAt: earlier[0].iso }
    : { ...next }
}

function sameContent(
  a: ObservedProviderWindow,
  b: ObservedProviderWindow,
): boolean {
  const { observedAt: _a, ...restA } = a
  const { observedAt: _b, ...restB } = b
  return JSON.stringify(restA) === JSON.stringify(restB)
}

const StoredRowSchema = z.object({
  window_json: z.string(),
  previous_resets_at: z.string().nullable(),
})

function fromRow(row: unknown): ObservedProviderWindow | null {
  const stored = StoredRowSchema.safeParse(row)
  if (!stored.success) return null
  let raw: unknown
  try {
    raw = JSON.parse(stored.data.window_json)
  } catch {
    return null
  }
  const parsed = ProviderQuotaWindowSchema.safeParse(raw)
  if (!parsed.success) return null
  const previous = stored.data.previous_resets_at
  return previous === null ?
      parsed.data
    : { ...parsed.data, previousResetsAt: previous }
}

/** Persisted in the token-usage database's `provider_quota_windows` table. */
function saveWindow(window: ObservedProviderWindow): void {
  const { previousResetsAt, ...current } = window
  enqueueUsageDbWrite((db) => {
    db.prepare(
      `
      INSERT INTO provider_quota_windows (
        provider, window_id, window_json, previous_resets_at, updated_at_ms
      ) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT (provider, window_id) DO UPDATE SET
        window_json = excluded.window_json,
        previous_resets_at = excluded.previous_resets_at,
        updated_at_ms = excluded.updated_at_ms
    `,
    ).run(
      window.provider,
      window.id,
      JSON.stringify(current),
      previousResetsAt ?? null,
      Date.now(),
    )
  }, "Failed to record a provider quota window")
}

async function loadWindows(): Promise<Array<ObservedProviderWindow>> {
  if (!isTokenUsageStorageEnabled()) return []
  const rows = await readUsageDb((db) =>
    db
      .prepare(
        "SELECT window_json, previous_resets_at FROM provider_quota_windows",
      )
      .all(),
  )
  return rows.flatMap((row) => fromRow(row) ?? [])
}

const windows = new Map<string, ObservedProviderWindow>()
let pending: Array<ProviderQuotaWindow> = []
let loaded = false
let hydration: Promise<void> | undefined

function apply(reported: ReadonlyArray<ProviderQuotaWindow>): void {
  for (const window of reported) {
    const ref = providerWindowRef(window)
    const known = windows.get(ref)
    const next = advanceProviderWindow(known, window)
    windows.set(ref, next)
    if (known === undefined || !sameContent(known, next)) saveWindow(next)
  }
}

function hydrate(): Promise<void> {
  hydration ??= loadWindows()
    .catch((error: unknown) => {
      consola.warn("Failed to load provider quota windows", error)
      return []
    })
    .then((stored) => {
      for (const window of stored)
        windows.set(providerWindowRef(window), window)
      loaded = true
      const queued = pending
      pending = []
      apply(queued)
    })
  return hydration
}

/** Record what a provider just reported. Synchronous and never throws, so it
 *  can sit on a reply's path. Reports that arrive before the persisted windows
 *  are loaded wait for them, so stored history is never overwritten. */
export function observeProviderWindows(
  reported: ReadonlyArray<ProviderQuotaWindow>,
): void {
  if (reported.length === 0) return
  if (loaded) {
    apply(reported)
    return
  }
  pending.push(...reported)
  void hydrate()
}

/** Every known window, persisted ones included, sorted by reference. */
export async function listProviderWindows(): Promise<
  Array<ObservedProviderWindow>
> {
  await hydrate()
  return [...windows.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([, window]) => window)
}

/** Forget the in-memory windows so the next read reloads them. */
export function __resetProviderWindowsForTests(): void {
  windows.clear()
  pending = []
  loaded = false
  hydration = undefined
}
