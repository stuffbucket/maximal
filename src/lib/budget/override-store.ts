/**
 * Overrides in the token-usage database (`budget_overrides`, migration
 * "add budget_overrides"), so what an approval granted survives a restart.
 * Writes go through the usage write queue, in order with the usage rows.
 * With no usage database nothing persists and overrides last one run.
 */

import { z } from "zod"

import {
  enqueueUsageDbWrite,
  isTokenUsageStorageEnabled,
  readUsageDb,
} from "~/lib/token-usage/store"

import type { BudgetOverride, OverrideStorage } from "./overrides"

const RowSchema = z.object({
  id: z.string(),
  limit_id: z.string(),
  kind: z.enum(["extra", "unlimited"]),
  extra_nano_aiu: z.number(),
  created_at_ms: z.number(),
  expires_at_ms: z.number().nullable(),
})

export function createUsageDbOverrideStorage(
  clock: () => number = Date.now,
): OverrideStorage {
  return {
    async load() {
      if (!isTokenUsageStorageEnabled()) return []
      const nowMs = clock()
      // What has run out is of no use to anyone.
      enqueueUsageDbWrite((db) => {
        db.prepare(
          "DELETE FROM budget_overrides WHERE expires_at_ms IS NOT NULL AND expires_at_ms <= ?",
        ).run(nowMs)
      }, "Failed to prune budget overrides")
      const rows = await readUsageDb((db) =>
        db
          .prepare(
            "SELECT id, limit_id, kind, extra_nano_aiu, created_at_ms, expires_at_ms FROM budget_overrides",
          )
          .all(),
      )
      return rows.flatMap((row): Array<BudgetOverride> => {
        const parsed = RowSchema.safeParse(row)
        if (!parsed.success) return []
        const { data } = parsed
        return [
          {
            id: data.id,
            limitId: data.limit_id,
            kind: data.kind,
            extraNanoAiu: data.extra_nano_aiu,
            createdAtMs: data.created_at_ms,
            expiresAtMs: data.expires_at_ms,
          },
        ]
      })
    },

    save(override) {
      enqueueUsageDbWrite((db) => {
        db.prepare(
          "INSERT OR REPLACE INTO budget_overrides (id, limit_id, kind, extra_nano_aiu, created_at_ms, expires_at_ms) VALUES (?, ?, ?, ?, ?, ?)",
        ).run(
          override.id,
          override.limitId,
          override.kind,
          override.extraNanoAiu,
          override.createdAtMs,
          override.expiresAtMs,
        )
      }, "Failed to record a budget override")
    },

    remove(id) {
      enqueueUsageDbWrite((db) => {
        db.prepare("DELETE FROM budget_overrides WHERE id = ?").run(id)
      }, "Failed to remove a budget override")
    },
  }
}
