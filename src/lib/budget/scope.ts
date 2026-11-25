/**
 * Who a billed request is, as budget scopes see it, and which limits cover
 * it. Pure. The same subject is built from a request before the call (a
 * `BudgetIntent`) and from a usage row after it (a `SpendEvent`), so a limit
 * counts what it admits.
 */

import type { SpendScope } from "~/lib/token-usage/spend"

import type { BudgetFilterConfig, BudgetScope } from "./schema"

import { globMatches } from "./glob"

/** What a billed request is doing. Model operations and server tools carry a
 *  hold; the chat endpoints are gated on spend already recorded. */
export type BudgetOperation =
  | "chat_completions"
  | "decisions"
  | "images.edits"
  | "images.generations"
  | "messages"
  | "responses"
  | "server_tool"
  | "systemone"

/** The attributes a scope selects on. */
export interface BudgetSubject {
  /** The client key (`budgetKeyOf`). */
  key: string
  /** The plugin or built-in capability (`images`), when the call has one. */
  plugin?: string
  /** The provider that bills it (`copilot`), when known. */
  provider?: string
  /** The model the call names, when it names one. */
  model?: string
}

/** A scope with its filter looked up: what the ledger and the database
 *  match rows against. */
export type ResolvedScope = SpendScope

/** The key a request or usage row belongs to: the API key's label, else the
 *  client Maximal recognised, else `unidentified`. */
export function budgetKeyOf(
  label: string | null | undefined,
  client: string,
): string {
  if (label !== null && label !== undefined && label !== "") return label
  return client === "other" ? "unidentified" : client
}

const FILTER_FIELD = {
  models: "model",
  clients: "key",
  plugins: "plugin",
} as const

/** Look a `filter` scope's filter up. A filter that no longer exists selects
 *  nothing, so its limit is inert rather than global. */
export function resolveScope(
  scope: BudgetScope,
  filters: ReadonlyArray<BudgetFilterConfig> | undefined,
): ResolvedScope {
  if (scope.kind !== "filter") return scope
  const filter = filters?.find((candidate) => candidate.id === scope.id)
  return {
    kind: "members",
    field: filter === undefined ? "model" : FILTER_FIELD[filter.kind],
    members: filter?.members ?? [],
  }
}

export function scopeMatches(
  scope: ResolvedScope,
  subject: BudgetSubject,
): boolean {
  if (scope.kind === "members") {
    const value = subject[scope.field]
    if (value === undefined) return false
    return scope.members.some((member) => globMatches(member, value))
  }
  if (scope.kind === "global") return true
  if (scope.kind === "key") return subject.key === scope.id
  if (scope.kind === "plugin") return subject.plugin === scope.id
  return subject.provider === scope.id
}
