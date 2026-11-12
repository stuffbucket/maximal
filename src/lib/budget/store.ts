/**
 * The budget service's store: spend read from, and holds written to, the
 * token-usage database (`budget_holds`, migration "add budget_holds").
 *
 * Hold writes go through the usage write queue, so they land in order with
 * the usage rows. With no usage database (`isTokenUsageStorageEnabled()`
 * false) nothing persists and spend reads 0: limits still hold within one
 * run.
 */

import { getNanoAiuSpend, getNanoAiuSpendRows } from "~/lib/token-usage/spend"
import {
  enqueueUsageDbWrite,
  isTokenUsageStorageEnabled,
  readUsageDb,
} from "~/lib/token-usage/store"

import type { BudgetStore } from "./service"

/** Closed holds are kept this long, then pruned. */
const CLOSED_HOLD_RETENTION_MS = 7 * 86_400_000

export function createUsageDbBudgetStore(): BudgetStore {
  return {
    async spend(scope, range) {
      const [sum] = await getNanoAiuSpend(scope, [range])
      return sum
    },

    spendRows(scope, range) {
      return getNanoAiuSpendRows(scope, range)
    },

    async recover(nowMs) {
      if (!isTokenUsageStorageEnabled()) return
      enqueueUsageDbWrite((db) => {
        db.prepare(
          "UPDATE budget_holds SET state = 'orphaned' WHERE state = 'open'",
        ).run()
        db.prepare(
          "DELETE FROM budget_holds WHERE state IN ('committed', 'released') AND closed_at_ms < ?",
        ).run(nowMs - CLOSED_HOLD_RETENTION_MS)
      }, "Failed to recover budget holds")
      // Wait for the queue, so the first hold opens after the recovery.
      await readUsageDb(() => undefined)
    },

    openHold(hold) {
      enqueueUsageDbWrite((db) => {
        db.prepare(
          `INSERT OR REPLACE INTO budget_holds (
            id, created_at_ms, operation, provider, plugin_id, tool_name,
            client_key, estimate_nano_aiu, state
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'open')`,
        ).run(
          hold.id,
          hold.createdAtMs,
          hold.operation,
          hold.provider ?? null,
          hold.plugin ?? null,
          hold.tool ?? null,
          hold.key,
          hold.estimateNanoAiu,
        )
      }, "Failed to record a budget hold")
    },

    closeHold(close) {
      enqueueUsageDbWrite((db) => {
        db.prepare(
          "UPDATE budget_holds SET state = ?, actual_nano_aiu = ?, closed_at_ms = ? WHERE id = ? AND state = 'open'",
        ).run(
          close.state,
          close.actualNanoAiu ?? null,
          close.closedAtMs,
          close.id,
        )
      }, "Failed to close a budget hold")
    },
  }
}
