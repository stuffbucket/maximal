/**
 * What each session cost, for building rules from real usage.
 *
 * Nothing is stored per session: a session is the set of
 * `token_usage_events` rows that share a `session_id`, which every request
 * records (the affinity header, else the client's own id, else Responses'
 * `prompt_cache_key`; see *Token-usage sessions* in `docs/architecture.md`).
 * A request that carries none lands in one `other:<client>` pseudo-session
 * per client, flagged `attributed: false` (the same rule as the Dashboard's
 * Sessions view). Maximal records no title or project for a session, so
 * there is none to show: the client and its key label identify it.
 */

import {
  numberFromRow,
  totalsFromRow,
  USAGE_TOTALS_SELECT,
} from "~/lib/token-usage/aggregate"
import { customKeyLabel } from "~/lib/token-usage/client"
import {
  isTokenUsageStorageEnabled,
  readUsageDb,
  type TokenUsageTotals,
} from "~/lib/token-usage/store"

import type { UsageRange } from "./range"

import { budgetKeyOf } from "../scope"
import { UNATTRIBUTED_PREFIX } from "./usage-rows"

export interface SessionModelMix {
  model: string
  requests: number
  nanoAiu: number
  totalTokens: number
}

export interface SessionSummary {
  /** The recorded session id, or `other:<client>`. */
  id: string
  attributed: boolean
  /** `claude-code`, `claude-desktop`, `codex` or `other`. */
  client: string
  /** The API key's label when the user named it; null for none, or for the
   *  label an integration provisioned (it only repeats the client's name). */
  clientLabel: string | null
  /** The budget key the session's spend counts under (`budgetKeyOf`). */
  key: string
  startedAtMs: number
  endedAtMs: number
  usage: TokenUsageTotals
  /** Models by spend, biggest first. */
  models: Array<SessionModelMix>
}

export interface SessionsReport {
  /** Biggest spender first. */
  sessions: Array<SessionSummary>
  /** Every session in the range, before `limit` cut the list. */
  totalSessions: number
  /** Everything the range recorded. */
  totals: TokenUsageTotals
}

interface Group {
  sessionId: string
  client: string
  clientLabel: string | null
  model: string
  usage: TokenUsageTotals
  startedAtMs: number
  endedAtMs: number
}

function readGroup(row: Record<string, unknown>): Group {
  return {
    sessionId: typeof row.session_id === "string" ? row.session_id : "",
    client: typeof row.client === "string" ? row.client : "other",
    clientLabel: customKeyLabel(
      typeof row.client_label === "string" ? row.client_label : null,
    ),
    model: typeof row.model === "string" ? row.model : "unknown",
    usage: totalsFromRow(row),
    startedAtMs: numberFromRow(row, "started_ms"),
    endedAtMs: numberFromRow(row, "ended_ms"),
  }
}

function addTotals(a: TokenUsageTotals, b: TokenUsageTotals): TokenUsageTotals {
  return {
    request_count: a.request_count + b.request_count,
    input_tokens: a.input_tokens + b.input_tokens,
    output_tokens: a.output_tokens + b.output_tokens,
    cache_read_input_tokens:
      a.cache_read_input_tokens + b.cache_read_input_tokens,
    cache_creation_input_tokens:
      a.cache_creation_input_tokens + b.cache_creation_input_tokens,
    total_tokens: a.total_tokens + b.total_tokens,
    total_nano_aiu: a.total_nano_aiu + b.total_nano_aiu,
  }
}

const NO_USAGE: TokenUsageTotals = {
  request_count: 0,
  input_tokens: 0,
  output_tokens: 0,
  cache_read_input_tokens: 0,
  cache_creation_input_tokens: 0,
  total_tokens: 0,
  total_nano_aiu: 0,
}

/** Fold the (session, client, label, model) groups into one summary per
 *  session. The session's client and key are those of its biggest spender. */
export function summarizeSessions(
  groups: ReadonlyArray<Group>,
): Array<SessionSummary> {
  const bySession = new Map<string, Array<Group>>()
  for (const group of groups) {
    const id =
      group.sessionId === "" ?
        `${UNATTRIBUTED_PREFIX}${group.client}`
      : group.sessionId
    const list = bySession.get(id) ?? []
    list.push(group)
    bySession.set(id, list)
  }
  return [...bySession.entries()].map(([id, parts]) => {
    const lead = parts.reduce((best, part) =>
      (
        part.usage.total_nano_aiu > best.usage.total_nano_aiu
        || (part.usage.total_nano_aiu === best.usage.total_nano_aiu
          && part.usage.request_count > best.usage.request_count)
      ) ?
        part
      : best,
    )
    const models = new Map<string, SessionModelMix>()
    for (const part of parts) {
      const mix = models.get(part.model) ?? {
        model: part.model,
        requests: 0,
        nanoAiu: 0,
        totalTokens: 0,
      }
      mix.requests += part.usage.request_count
      mix.nanoAiu += part.usage.total_nano_aiu
      mix.totalTokens += part.usage.total_tokens
      models.set(part.model, mix)
    }
    return {
      id,
      attributed: !id.startsWith(UNATTRIBUTED_PREFIX),
      client: lead.client,
      clientLabel: lead.clientLabel,
      key: budgetKeyOf(lead.clientLabel, lead.client),
      startedAtMs: Math.min(...parts.map((p) => p.startedAtMs)),
      endedAtMs: Math.max(...parts.map((p) => p.endedAtMs)),
      usage: parts.reduce((sum, p) => addTotals(sum, p.usage), NO_USAGE),
      models: [...models.values()].sort(
        (a, b) => b.nanoAiu - a.nanoAiu || a.model.localeCompare(b.model),
      ),
    }
  })
}

/** Order for the report: the biggest spender first, then the latest. */
function bySpend(a: SessionSummary, b: SessionSummary): number {
  return (
    b.usage.total_nano_aiu - a.usage.total_nano_aiu
    || b.endedAtMs - a.endedAtMs
    || a.id.localeCompare(b.id)
  )
}

/** Per-session cost over the range. `limit` cuts the list, not the totals. */
export async function getSessionsReport(
  range: UsageRange,
  options: { limit: number },
): Promise<SessionsReport> {
  if (!isTokenUsageStorageEnabled()) {
    return { sessions: [], totalSessions: 0, totals: NO_USAGE }
  }
  const rows = await readUsageDb((db) =>
    db
      .prepare(
        `SELECT session_id, client, client_label, model, ${USAGE_TOTALS_SELECT},
                MIN(COALESCE(request_started_at_ms, created_at_ms)) AS started_ms,
                MAX(created_at_ms) AS ended_ms
         FROM token_usage_events
         WHERE created_at_ms >= ? AND created_at_ms < ?
         GROUP BY session_id, client, client_label, model`,
      )
      .all(range.fromMs, range.toMs),
  )
  const groups = (rows as Array<Record<string, unknown>>).map((row) =>
    readGroup(row),
  )
  const sessions = summarizeSessions(groups).sort(bySpend)
  return {
    sessions: sessions.slice(0, options.limit),
    totalSessions: sessions.length,
    totals: groups.reduce((sum, g) => addTotals(sum, g.usage), NO_USAGE),
  }
}
