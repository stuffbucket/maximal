/**
 * The budget decision log (`budget_events`, migration "add budget_events"):
 * refusals, first-crossings of a limit's warning threshold, and billed calls
 * admitted with an estimate held. Written from the service's decision paths
 * through the usage write queue (so it lands in order with the usage rows);
 * read by the timeline. With no usage database nothing is written or read.
 */

import {
  enqueueUsageDbWrite,
  isTokenUsageStorageEnabled,
  readUsageDb,
} from "~/lib/token-usage/store"

import type { BudgetScope } from "../schema"
import type { BudgetEvent, BudgetEventKind } from "../service"

/** Events are kept this long, then pruned the first time one is written in a
 *  process. */
const EVENT_RETENTION_MS = 400 * 86_400_000

let pruned = false

export function recordBudgetEvent(event: BudgetEvent): void {
  enqueueUsageDbWrite((db) => {
    if (!pruned) {
      pruned = true
      db.prepare("DELETE FROM budget_events WHERE created_at_ms < ?").run(
        event.atMs - EVENT_RETENTION_MS,
      )
    }
    db.prepare(
      `INSERT INTO budget_events (
        created_at_ms, kind, limit_id, scope_kind, scope_id, client_key,
        operation, estimate_nano_aiu, used_nano_aiu, limit_nano_aiu
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      event.atMs,
      event.kind,
      event.limitId,
      event.scope.kind,
      event.scope.kind === "global" ? null : event.scope.id,
      event.key,
      event.operation,
      event.estimateNanoAiu,
      event.usedNanoAiu,
      event.limitNanoAiu,
    )
  }, "Failed to record a budget event")
}

/** A stored event. */
export interface StoredBudgetEvent {
  atMs: number
  kind: BudgetEventKind
  limitId: string
  scope: BudgetScope
  key: string
  operation: string
  estimateNanoAiu: number
  usedNanoAiu: number
  limitNanoAiu: number
}

function scopeOf(kind: unknown, id: unknown): BudgetScope {
  if (kind === "key" || kind === "plugin" || kind === "provider") {
    return { kind, id: typeof id === "string" ? id : "" }
  }
  return { kind: "global" }
}

/** The limit's events in `[fromMs, toMs)`, oldest first. */
export async function getBudgetEvents(query: {
  limitId: string
  fromMs: number
  toMs: number
  kind?: BudgetEventKind
}): Promise<Array<StoredBudgetEvent>> {
  if (!isTokenUsageStorageEnabled()) return []
  const kindFilter = query.kind === undefined ? "" : "AND kind = ?"
  const values: Array<string | number> = [
    query.limitId,
    query.fromMs,
    query.toMs,
    ...(query.kind === undefined ? [] : [query.kind]),
  ]
  const rows = await readUsageDb((db) =>
    db
      .prepare(
        `SELECT created_at_ms, kind, limit_id, scope_kind, scope_id, client_key,
                operation, estimate_nano_aiu, used_nano_aiu, limit_nano_aiu
         FROM budget_events
         WHERE limit_id = ? AND created_at_ms >= ? AND created_at_ms < ? ${kindFilter}
         ORDER BY created_at_ms ASC, id ASC`,
      )
      .all(...values),
  )
  return (rows as Array<Record<string, unknown>>).map((row) => ({
    atMs: Number(row.created_at_ms),
    kind: row.kind as BudgetEventKind,
    limitId: String(row.limit_id),
    scope: scopeOf(row.scope_kind, row.scope_id),
    key: String(row.client_key),
    operation: String(row.operation),
    estimateNanoAiu: Number(row.estimate_nano_aiu),
    usedNanoAiu: Number(row.used_nano_aiu),
    limitNanoAiu: Number(row.limit_nano_aiu),
  }))
}
