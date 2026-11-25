/**
 * Recorded requests as the what-if replay and the suggestions read them: one
 * row per `token_usage_events` row, with the subject budget scopes match on.
 * The subject is built the way the service builds it from a recorded row
 * (`runtime.ts`: key from the label or client, provider from the source), so
 * a replay covers what the live limit would have.
 */

import {
  isTokenUsageStorageEnabled,
  readUsageDb,
} from "~/lib/token-usage/store"

import type { UsageEventRow } from "./simulate"

import { budgetKeyOf } from "../scope"

export interface UsageRowQuery {
  fromMs: number
  /** Exclusive. */
  toMs: number
  /** Only these sessions. A request with no session id belongs to
   *  `other:<client>`. */
  sessionIds?: ReadonlyArray<string>
}

/** The pseudo-session a request with no session id belongs to. */
export const UNATTRIBUTED_PREFIX = "other:"

function sessionFilter(ids: ReadonlyArray<string>): {
  sql: string
  values: Array<string>
} {
  const named = ids.filter((id) => !id.startsWith(UNATTRIBUTED_PREFIX))
  const clients = ids
    .filter((id) => id.startsWith(UNATTRIBUTED_PREFIX))
    .map((id) => id.slice(UNATTRIBUTED_PREFIX.length))
  const clauses: Array<string> = []
  const values: Array<string> = []
  if (named.length > 0) {
    clauses.push(`session_id IN (${named.map(() => "?").join(", ")})`)
    values.push(...named)
  }
  if (clients.length > 0) {
    clauses.push(
      `(session_id = '' AND client IN (${clients.map(() => "?").join(", ")}))`,
    )
    values.push(...clients)
  }
  return { sql: clauses.length === 0 ? "0" : clauses.join(" OR "), values }
}

const text = (value: unknown): string =>
  typeof value === "string" ? value : ""

/** The requests in the range, oldest first; empty when storage is off. */
export async function getUsageEventRows(
  query: UsageRowQuery,
): Promise<Array<UsageEventRow>> {
  if (!isTokenUsageStorageEnabled()) return []
  const where = ["created_at_ms >= ?", "created_at_ms < ?"]
  const values: Array<string | number> = [query.fromMs, query.toMs]
  if (query.sessionIds !== undefined) {
    const filter = sessionFilter(query.sessionIds)
    where.push(`(${filter.sql})`)
    values.push(...filter.values)
  }
  const rows = await readUsageDb((db) =>
    db
      .prepare(
        `SELECT created_at_ms, total_nano_aiu, client, client_label, plugin_id,
                source, provider_name, session_id, model
         FROM token_usage_events WHERE ${where.join(" AND ")}
         ORDER BY created_at_ms ASC, id ASC`,
      )
      .all(...values),
  )
  return (rows as Array<Record<string, unknown>>).map((row) => {
    const plugin = row.plugin_id
    return {
      createdAtMs: Number(row.created_at_ms),
      nanoAiu: Number(row.total_nano_aiu),
      key: budgetKeyOf(
        typeof row.client_label === "string" ? row.client_label : null,
        String(row.client),
      ),
      provider: row.source === "copilot" ? "copilot" : text(row.provider_name),
      ...(typeof plugin === "string" ? { plugin } : {}),
      sessionId: text(row.session_id),
      ...(typeof row.model === "string" ? { model: row.model } : {}),
    }
  })
}
