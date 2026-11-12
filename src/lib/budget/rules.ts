/**
 * Export and import of the rules (limits, filters and how amounts are shown)
 * as one versioned JSON document. Pure: `planImport` validates a document
 * strictly, works out what applying it would change, and returns the new
 * config pieces; the route writes them.
 *
 * The document uses the API's field names (`limit_reset`, `warn_at`) and
 * nano-AIU amounts, so it reads the same as what the rest of the API
 * returns and moves between installs whatever unit each shows.
 */

import {
  BudgetRulesDocument,
  type BudgetRuleFilter,
  type BudgetRuleLimit,
  type BudgetRulesChangeSet,
  type BudgetRulesDisplay,
  type BudgetRulesImportResponse,
} from "~/lib/config/settings-types"

import { DEFAULT_NOTIFY, resolveNotify } from "./notify"
import {
  DEFAULT_WARN_AT,
  type BudgetConfig,
  type BudgetFilterConfig,
  type BudgetLimitConfig,
} from "./schema"
import { resolveBudgetDisplay } from "./units"

export const RULES_VERSION = 1

export type ImportMode = "merge" | "replace"
/** What a merge does with an imported id that is already in use by
 *  something different: the import wins, or it is added under a free id. */
export type ImportCollisions = "replace" | "rename"

export interface ImportRequest {
  /** The document, as the client sent it (validated here). */
  rules: unknown
  mode: ImportMode
  collisions?: ImportCollisions
}

export interface RulesProblem {
  /** Dotted, relative to the rules document (`limits.2.scope.id`). */
  path: string
  message: string
}

export function limitToWire(limit: BudgetLimitConfig): BudgetRuleLimit {
  return {
    id: limit.id,
    ...(limit.label === undefined ? {} : { label: limit.label }),
    scope: limit.scope,
    limit: limit.limit,
    limit_reset: limit.limitReset,
    warn_at: limit.warnAt ?? DEFAULT_WARN_AT,
    action: limit.action,
    notify: resolveNotify(limit),
    // Written only when they differ from the plain cost rule.
    ...(limit.unit === "tokens" ?
      { unit: limit.unit, measure: limit.measure ?? ("total" as const) }
    : {}),
    ...(limit.maxRequests === undefined ?
      {}
    : { max_requests: limit.maxRequests }),
    ...(limit.when === undefined ? {} : { when: limit.when }),
  }
}

export function filterToWire(filter: BudgetFilterConfig): BudgetRuleFilter {
  return {
    id: filter.id,
    name: filter.name,
    kind: filter.kind,
    members: filter.members,
  }
}

function limitFromWire(limit: BudgetRuleLimit): BudgetLimitConfig {
  return {
    id: limit.id,
    ...(limit.label === undefined ? {} : { label: limit.label }),
    scope: limit.scope,
    limit: limit.limit,
    limitReset: limit.limit_reset,
    warnAt: limit.warn_at,
    action: limit.action,
    // Only what differs from the default is stored.
    ...(same(limit.notify, DEFAULT_NOTIFY) || limit.notify === undefined ?
      {}
    : { notify: limit.notify }),
    ...(limit.unit === "tokens" ? { unit: limit.unit } : {}),
    ...(limit.measure === undefined ? {} : { measure: limit.measure }),
    ...(limit.max_requests === undefined ?
      {}
    : { maxRequests: limit.max_requests }),
    ...(limit.when === undefined ? {} : { when: limit.when }),
  }
}

function displayToWire(budget: BudgetConfig | undefined): BudgetRulesDisplay {
  const display = resolveBudgetDisplay(budget)
  return { unit: display.unit, credit_usd: display.creditUsd }
}

/** `GET /settings/api/budget/rules/export`. */
export function exportRules(
  budget: BudgetConfig | undefined,
): BudgetRulesDocument {
  return {
    version: RULES_VERSION,
    filters: (budget?.filters ?? []).map((filter) => filterToWire(filter)),
    limits: (budget?.limits ?? []).map((limit) => limitToWire(limit)),
    display: displayToWire(budget),
  }
}

const same = (a: unknown, b: unknown): boolean =>
  JSON.stringify(a) === JSON.stringify(b)

/** The first `<id>-2`, `<id>-3`, ... that `taken` doesn't hold. */
function freeId(id: string, taken: ReadonlySet<string>): string {
  const base = id.slice(0, 60)
  for (let n = 2; ; n += 1) {
    const candidate = `${base}-${n}`
    if (!taken.has(candidate)) return candidate
  }
}

interface Merged<T extends { id: string }> {
  /** The items as they will be stored. */
  items: Array<T>
  changes: BudgetRulesChangeSet<T>
  /** Imported id to the free id it was given. */
  renamed: Map<string, string>
}

interface MergeInput<T extends { id: string }> {
  current: ReadonlyArray<T>
  imported: ReadonlyArray<T>
  mode: ImportMode
  collisions: ImportCollisions
}

/** One list's import: `current` (by id) against `imported`. */
function mergeList<T extends { id: string }>({
  current,
  imported,
  mode,
  collisions,
}: MergeInput<T>): Merged<T> {
  const currentById = new Map(current.map((item) => [item.id, item]))
  const taken = new Set([
    ...current.map((item) => item.id),
    ...imported.map((item) => item.id),
  ])
  const changes: BudgetRulesChangeSet<T> = {
    added: [],
    changed: [],
    removed: [],
    unchanged: [],
  }
  const renamed = new Map<string, string>()
  const replacing = mode === "replace"
  const items = replacing ? [] : [...current]
  if (replacing) {
    const importedIds = new Set(imported.map((item) => item.id))
    changes.removed = current.filter((item) => !importedIds.has(item.id))
  }

  for (const item of imported) {
    const existing = currentById.get(item.id)
    if (existing === undefined) {
      changes.added.push(item)
      items.push(item)
    } else if (same(existing, item)) {
      changes.unchanged.push(item.id)
      if (replacing) items.push(item)
    } else if (replacing || collisions === "replace") {
      changes.changed.push({ before: existing, after: item })
      if (replacing) items.push(item)
      else items[items.findIndex((entry) => entry.id === item.id)] = item
    } else {
      const id = freeId(item.id, taken)
      taken.add(id)
      renamed.set(item.id, id)
      const added = { ...item, id }
      changes.added.push(added)
      items.push(added)
    }
  }
  return { items, changes, renamed }
}

/** The document, or why it can't be read: not an object, another version,
 *  a field that doesn't belong, or the same id twice. */
function readDocument(
  rules: unknown,
): { document: BudgetRulesDocument } | { problems: Array<RulesProblem> } {
  if (typeof rules !== "object" || rules === null || Array.isArray(rules)) {
    return {
      problems: [{ path: "", message: "The rules must be a JSON object" }],
    }
  }
  const { version } = rules as { version?: unknown }
  if (version !== RULES_VERSION) {
    const given = version === undefined ? "(missing)" : JSON.stringify(version)
    return {
      problems: [
        {
          path: "version",
          message: `Unsupported rules version ${given}; this Maximal reads version ${RULES_VERSION}`,
        },
      ],
    }
  }
  const parsed = BudgetRulesDocument.safeParse(rules)
  if (!parsed.success) {
    return {
      problems: parsed.error.issues.map((issue) => ({
        path: issue.path.map(String).join("."),
        message: issue.message,
      })),
    }
  }
  const problems: Array<RulesProblem> = []
  for (const list of ["filters", "limits"] as const) {
    const seen = new Set<string>()
    for (const [index, item] of parsed.data[list].entries()) {
      if (seen.has(item.id)) {
        problems.push({
          path: `${list}.${index}.id`,
          message: `Duplicate ${list === "filters" ? "filter" : "rule"} id '${item.id}'`,
        })
      }
      seen.add(item.id)
    }
  }
  return problems.length > 0 ? { problems } : { document: parsed.data }
}

/** What the merged lists can't be: a rule on a filter that won't exist, or
 *  more than the config holds. */
function resultProblems(
  limits: ReadonlyArray<BudgetRuleLimit>,
  filters: ReadonlyArray<BudgetRuleFilter>,
): Array<RulesProblem> {
  const problems: Array<RulesProblem> = []
  const filterIds = new Set(filters.map((filter) => filter.id))
  for (const [index, limit] of limits.entries()) {
    if (limit.scope.kind === "filter" && !filterIds.has(limit.scope.id)) {
      problems.push({
        path: `limits.${index}.scope.id`,
        message: `Rule '${limit.id}' uses filter '${limit.scope.id}', which isn't defined`,
      })
    }
  }
  if (limits.length > 256) {
    problems.push({
      path: "limits",
      message: "That would be more than 256 rules",
    })
  }
  if (filters.length > 128) {
    problems.push({
      path: "filters",
      message: "That would be more than 128 filters",
    })
  }
  return problems
}

export type ImportPlan =
  | { ok: false; problems: Array<RulesProblem> }
  | {
      ok: true
      next: {
        limits: Array<BudgetLimitConfig>
        filters: Array<BudgetFilterConfig>
        /** Set only when the import changes how amounts are shown. */
        display?: { unit: BudgetRulesDisplay["unit"]; creditUsd: number }
      }
      diff: Omit<BudgetRulesImportResponse, "mode" | "dry_run" | "applied">
    }

/** A renamed filter takes the imported rules scoped to it along. */
function followRenames(
  limits: ReadonlyArray<BudgetRuleLimit>,
  renamed: ReadonlyMap<string, string>,
): Array<BudgetRuleLimit> {
  return limits.map((limit) => {
    const to =
      limit.scope.kind === "filter" ? renamed.get(limit.scope.id) : undefined
    return to === undefined ? limit : (
        { ...limit, scope: { kind: "filter", id: to } }
      )
  })
}

/** Validate `request.rules` and work out what importing it would do to
 *  `budget`. Nothing is written. */
export function planImport(
  budget: BudgetConfig | undefined,
  request: ImportRequest,
): ImportPlan {
  const read = readDocument(request.rules)
  if ("problems" in read) return { ok: false, problems: read.problems }
  const { document } = read
  const { mode, collisions = "replace" } = request

  const filters = mergeList({
    current: (budget?.filters ?? []).map((filter) => filterToWire(filter)),
    imported: document.filters,
    mode,
    collisions,
  })
  const limits = mergeList({
    current: (budget?.limits ?? []).map((limit) => limitToWire(limit)),
    imported: followRenames(document.limits, filters.renamed).map(
      (limit): BudgetRuleLimit => ({
        ...limit,
        notify: limit.notify ?? DEFAULT_NOTIFY,
        ...(limit.unit === "tokens" ?
          { measure: limit.measure ?? ("total" as const) }
        : {}),
      }),
    ),
    mode,
    collisions,
  })
  const problems = resultProblems(limits.items, filters.items)
  if (problems.length > 0) return { ok: false, problems }

  const before = displayToWire(budget)
  const after = mode === "replace" ? (document.display ?? before) : before
  const displayChanged = !same(before, after)
  // What didn't change keeps its stored entry, extra fields included.
  const keptLimits = new Map(
    (budget?.limits ?? []).map((limit) => [limit.id, limit]),
  )
  const keptFilters = new Map(
    (budget?.filters ?? []).map((filter) => [filter.id, filter]),
  )
  return {
    ok: true,
    next: {
      limits: limits.items.map((limit) => {
        const kept = keptLimits.get(limit.id)
        return kept && same(limitToWire(kept), limit) ? kept : (
            limitFromWire(limit)
          )
      }),
      filters: filters.items.map((filter) => {
        const kept = keptFilters.get(filter.id)
        return kept && same(filterToWire(kept), filter) ? kept : filter
      }),
      ...(displayChanged ?
        { display: { unit: after.unit, creditUsd: after.credit_usd } }
      : {}),
    },
    diff: {
      filters: filters.changes,
      limits: limits.changes,
      display: { changed: displayChanged, before, after },
      renamed: [
        ...[...filters.renamed].map(([from, to]) => ({
          kind: "filter" as const,
          from,
          to,
        })),
        ...[...limits.renamed].map(([from, to]) => ({
          kind: "limit" as const,
          from,
          to,
        })),
      ],
    },
  }
}
