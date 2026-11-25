/**
 * The budget service's store: spend read from, and holds written to, the
 * token-usage database (`budget_holds`, migration "add budget_holds").
 *
 * Hold writes go through the usage write queue, so they land in order with
 * the usage rows. With no usage database (`isTokenUsageStorageEnabled()`
 * false) nothing persists and spend reads 0: limits still hold within one
 * run.
 */

import type { SqliteDatabase } from "~/lib/platform/sqlite"

import {
  getNanoAiuSpend,
  getNanoAiuSpendRows,
  getRequestTimes,
} from "~/lib/token-usage/spend"
import {
  insertTokenUsageEvent,
  isTokenUsageStorageEnabled,
  queueUsageDbWrite,
} from "~/lib/token-usage/store"

import type { BudgetStore } from "./service"

/** Closed holds are kept this long, then pruned. */
const CLOSED_HOLD_RETENTION_MS = 7 * 86_400_000

type HoldClose = Parameters<BudgetStore["closeHold"]>[0]
type HoldSettlement = Parameters<BudgetStore["settleHold"]>

function closeOpenHold(db: SqliteDatabase, close: HoldClose): void {
  const result = db
    .prepare(
      "UPDATE budget_holds SET state = ?, actual_nano_aiu = ?, closed_at_ms = ? WHERE id = ? AND state = 'open'",
    )
    .run(
      close.state,
      close.actualNanoAiu ?? null,
      close.closedAtMs,
      close.id,
    ) as { changes?: unknown }
  if (result.changes !== 1) {
    throw new Error(`Budget hold ${close.id} is not open`)
  }
}

function settleOpenHold(
  db: SqliteDatabase,
  events: HoldSettlement[0],
  close: HoldSettlement[1],
): void {
  db.exec("BEGIN IMMEDIATE")
  try {
    const result = db
      .prepare(
        `UPDATE budget_holds
         SET state = ?, actual_nano_aiu = ?, closed_at_ms = ?,
             est_input_tokens = CASE WHEN ? = 1 THEN 0 ELSE est_input_tokens END,
             est_output_tokens = CASE WHEN ? = 1 THEN 0 ELSE est_output_tokens END
         WHERE id = ? AND state = 'open'`,
      )
      .run(
        close.state,
        close.actualNanoAiu ?? null,
        close.closedAtMs,
        close.observedTokens?.input ? 1 : 0,
        close.observedTokens?.output ? 1 : 0,
        close.id,
      ) as { changes?: unknown }
    if (result.changes !== 1) {
      throw new Error(`Budget hold ${close.id} is not open`)
    }
    for (const event of events) insertTokenUsageEvent(db, event)
    db.exec("COMMIT")
  } catch (error) {
    db.exec("ROLLBACK")
    throw error
  }
}

export function createUsageDbBudgetStore(): BudgetStore {
  return {
    async spend(scope, range, metric) {
      const [sum] = await getNanoAiuSpend(scope, [range], metric)
      return sum
    },

    spendRows(scope, range, metric) {
      return getNanoAiuSpendRows(scope, range, metric)
    },

    requestTimes(scope, range) {
      return getRequestTimes(scope, range)
    },

    async recover(nowMs) {
      if (!isTokenUsageStorageEnabled()) return
      await queueUsageDbWrite((db) => {
        db.prepare(
          "UPDATE budget_holds SET state = 'orphaned' WHERE state = 'open'",
        ).run()
        db.prepare(
          "DELETE FROM budget_holds WHERE state IN ('committed', 'released') AND closed_at_ms < ?",
        ).run(nowMs - CLOSED_HOLD_RETENTION_MS)
      })
    },

    async openHold(hold) {
      await queueUsageDbWrite((db) => {
        db.prepare(
          `INSERT INTO budget_holds (
            id, created_at_ms, operation, provider, plugin_id, tool_name,
            client_key, estimate_nano_aiu, model, est_input_tokens,
            est_output_tokens, state
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'open')`,
        ).run(
          hold.id,
          hold.createdAtMs,
          hold.operation,
          hold.provider ?? null,
          hold.plugin ?? null,
          hold.tool ?? null,
          hold.key,
          hold.estimateNanoAiu,
          hold.model ?? null,
          hold.estimateInputTokens,
          hold.estimateOutputTokens,
        )
      })
    },

    async closeHold(close) {
      await queueUsageDbWrite((db) => closeOpenHold(db, close))
    },

    async settleHold(events, close) {
      await queueUsageDbWrite((db) => settleOpenHold(db, events, close))
    },
  }
}
