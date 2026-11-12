/**
 * Who a billed request is, as budget scopes see it, and which limits cover
 * it. Pure. The same subject is built from a request before the call (a
 * `BudgetIntent`) and from a usage row after it (a `SpendEvent`), so a limit
 * counts what it admits.
 */

import type { BudgetScope } from "./schema"

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
}

/** The key a request or usage row belongs to: the API key's label, else the
 *  client Maximal recognised, else `unidentified`. */
export function budgetKeyOf(
  label: string | null | undefined,
  client: string,
): string {
  if (label !== null && label !== undefined && label !== "") return label
  return client === "other" ? "unidentified" : client
}

export function scopeMatches(
  scope: BudgetScope,
  subject: BudgetSubject,
): boolean {
  if (scope.kind === "global") return true
  if (scope.kind === "key") return subject.key === scope.id
  if (scope.kind === "plugin") return subject.plugin === scope.id
  return subject.provider === scope.id
}
