/**
 * Which rules apply to a model, and the link between the Models list and the
 * Rules window. Free of the DOM and the catalog so it can be tested on its own
 * (tests/budget-model-rules.test.ts).
 *
 * A rule applies to a model when its scope is everything, when it is a filter
 * of models with a member (an exact id or a glob) that matches the model's id,
 * or when it names the provider that serves the model. The Models list is the
 * Copilot catalogue, so its models are served by `copilot`. Client-key and
 * plugin scopes and filters of clients or plugins say nothing about a model.
 */

import { globMatches } from "../../../../../src/lib/budget/glob";
import type { BudgetLimitStatus, BudgetStatusResponse } from "../../../../../src/lib/config/settings-types";

/** The provider that serves every model in the Models list. (`ModelSummary.vendor` is who made it, not who bills it.) */
export const MODEL_PROVIDER = "copilot";

type RuleSource = Pick<BudgetStatusResponse, "budgets" | "filters">;

/** Whether a rule covers the model, by any of the three ways. */
export function ruleCoversModel(rule: BudgetLimitStatus, modelId: string, filters: BudgetStatusResponse["filters"]): boolean {
  const { scope } = rule;
  if (scope.kind === "global") return true;
  if (scope.kind === "provider") return scope.id === MODEL_PROVIDER;
  if (scope.kind === "filter") {
    const filter = filters.find((candidate) => candidate.id === scope.id);
    return filter?.kind === "models" && filter.members.some((member) => globMatches(member, modelId));
  }
  return false;
}

/** Every rule that applies to the model, in the server's order, the ones that cover everything included. */
export function rulesForModel(modelId: string, source: RuleSource): Array<BudgetLimitStatus> {
  return source.budgets.filter((rule) => ruleCoversModel(rule, modelId, source.filters));
}

/**
 * The rules worth marking on the model's row: those that name it (a filter of
 * models or its provider). A rule that covers everything applies to every row,
 * so marking it on each says nothing about this one.
 */
export function rulesNamingModel(modelId: string, source: RuleSource): Array<BudgetLimitStatus> {
  return rulesForModel(modelId, source).filter((rule) => rule.scope.kind !== "global");
}

/** The Rules window filtered to a model: `#rules/model/<id>`, the id escaped so a slash or a space survives. */
export function rulesHashForModel(modelId: string): string {
  return `#rules/model/${encodeURIComponent(modelId)}`;
}

/** What the Rules window's hash asks of it: a model to show rules for, or the sessions to build from. */
export interface RulesHash {
  model: string | null;
}

/** Read `#rules/model/<id>`; anything else (`#rules`, another section) asks for nothing. */
export function parseRulesHash(hash: string): RulesHash {
  const [section, kind, value] = hash.replace(/^#/, "").split("/");
  if (section !== "rules" || kind !== "model" || value === undefined || value === "") return { model: null };
  try {
    return { model: decodeURIComponent(value) };
  } catch {
    return { model: null };
  }
}
