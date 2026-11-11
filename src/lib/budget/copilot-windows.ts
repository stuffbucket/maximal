/**
 * Copilot's quota windows, normalised to `ProviderQuotaWindow`.
 *
 * - Every Copilot reply carries one `x-quota-snapshot-<id>` header per quota
 *   (`premium_interactions`, …), a query string: `ent` (entitlement), `crUsed`
 *   (used), `rem` (percent remaining), `rst` (the reset), `ov` / `ovPerm`
 *   (overage used / permitted).
 * - `/copilot_internal/user` returns the same quotas as `quota_snapshots`,
 *   with one `quota_reset_date` for all of them.
 *
 * The counters lag real spend; only the reset is used by budgets.
 */

import consola from "consola"
import { z } from "zod"

import {
  observeProviderWindows,
  type ProviderQuotaWindow,
} from "~/lib/budget/provider-windows"

const PROVIDER = "copilot"
const HEADER_PREFIX = "x-quota-snapshot-"

const LABELS: Readonly<Record<string, string>> = {
  premium_interactions: "Copilot premium allowance",
  chat: "Copilot chat",
  completions: "Copilot code completions",
}

function labelFor(id: string): string {
  return LABELS[id] ?? `Copilot ${id.replaceAll("_", " ")}`
}

function finiteNumber(value: string | null): number | undefined {
  if (value === null || value.trim() === "") return undefined
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : undefined
}

/** An ISO reset from an ISO string, a date, or an epoch in seconds or ms. */
export function normalizeResetAt(
  value: string | null | undefined,
): string | undefined {
  if (value === null || value === undefined || value.trim() === "") {
    return undefined
  }
  const trimmed = value.trim()
  const epoch = /^\d+(?:\.\d+)?$/u.test(trimmed) ? Number(trimmed) : undefined
  let ms: number
  if (epoch === undefined) ms = Date.parse(trimmed)
  else ms = epoch < 1e12 ? epoch * 1000 : epoch
  return Number.isFinite(ms) ? new Date(ms).toISOString() : undefined
}

function overageOf(
  used: number | undefined,
  permitted: boolean | undefined,
): ProviderQuotaWindow["overage"] {
  if (used === undefined && permitted === undefined) return undefined
  return { used, permitted }
}

function windowFromHeader(
  id: string,
  value: string,
  observedAt: string,
): ProviderQuotaWindow {
  const params = new URLSearchParams(value)
  const ovPerm = params.get("ovPerm")
  const limit = finiteNumber(params.get("ent"))
  return {
    provider: PROVIDER,
    id,
    label: labelFor(id),
    unit: params.has("crUsed") ? "credits" : "requests",
    used: finiteNumber(params.get("crUsed")),
    limit: limit !== undefined && limit >= 0 ? limit : undefined,
    percentRemaining: finiteNumber(params.get("rem")),
    resetsAt: normalizeResetAt(params.get("rst")),
    kind: "fixed",
    overage: overageOf(
      finiteNumber(params.get("ov")),
      ovPerm === null ? undefined : ovPerm === "true",
    ),
    observedAt,
    source: "header",
  }
}

/** One window per `x-quota-snapshot-<id>` header. */
export function copilotWindowsFromHeaders(
  headers: Headers,
  observedAt = new Date().toISOString(),
): Array<ProviderQuotaWindow> {
  const windows: Array<ProviderQuotaWindow> = []
  for (const [name, value] of headers) {
    const lower = name.toLowerCase()
    if (!lower.startsWith(HEADER_PREFIX)) continue
    const id = lower.slice(HEADER_PREFIX.length)
    if (!/^[\w.-]+$/u.test(id)) continue
    windows.push(windowFromHeader(id, value, observedAt))
  }
  return windows
}

const QuotaSnapshotSchema = z.object({
  entitlement: z.number().optional(),
  remaining: z.number().optional(),
  percent_remaining: z.number().optional(),
  overage_count: z.number().optional(),
  overage_permitted: z.boolean().optional(),
  unlimited: z.boolean().optional(),
})

const CopilotUsageSchema = z.object({
  quota_reset_date: z.string().optional(),
  quota_reset_date_utc: z.string().optional(),
  quota_snapshots: z.record(z.string(), z.unknown()).optional(),
})

/** One window per `quota_snapshots` entry of a `/copilot_internal/user`
 *  reply; [] for anything unrecognisable. */
export function copilotWindowsFromUsage(
  usage: unknown,
  observedAt = new Date().toISOString(),
): Array<ProviderQuotaWindow> {
  const parsed = CopilotUsageSchema.safeParse(usage)
  if (!parsed.success) return []
  const resetsAt = normalizeResetAt(
    parsed.data.quota_reset_date_utc ?? parsed.data.quota_reset_date,
  )
  const windows: Array<ProviderQuotaWindow> = []
  for (const [id, raw] of Object.entries(parsed.data.quota_snapshots ?? {})) {
    const snapshot = QuotaSnapshotSchema.safeParse(raw)
    if (!snapshot.success || !/^[\w.-]+$/u.test(id)) continue
    const quota = snapshot.data
    const bounded = quota.unlimited !== true
    const used =
      (
        bounded
        && quota.entitlement !== undefined
        && quota.remaining !== undefined
      ) ?
        Math.max(0, quota.entitlement - quota.remaining)
      : undefined
    windows.push({
      provider: PROVIDER,
      id,
      label: labelFor(id),
      unit: "requests",
      used,
      limit: bounded ? quota.entitlement : undefined,
      percentRemaining: bounded ? quota.percent_remaining : undefined,
      resetsAt,
      kind: "fixed",
      overage: overageOf(quota.overage_count, quota.overage_permitted),
      observedAt,
      source: "endpoint",
    })
  }
  return windows
}

/** Record the quota windows on a Copilot reply. Never throws. */
export function observeCopilotQuotaHeaders(headers: Headers): void {
  try {
    observeProviderWindows(copilotWindowsFromHeaders(headers))
  } catch (error) {
    consola.debug("Couldn't read Copilot quota headers", error)
  }
}

/** Record the quota windows in a `/copilot_internal/user` reply. Never
 *  throws. */
export function observeCopilotUsage(usage: unknown): void {
  try {
    observeProviderWindows(copilotWindowsFromUsage(usage))
  } catch (error) {
    consola.debug("Couldn't read Copilot quota snapshots", error)
  }
}
