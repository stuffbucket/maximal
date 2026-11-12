import {
  type BudgetHold,
  noopBudgetHold as createNoopBudgetHold,
} from "~/lib/budget/service"

/** A flow-level hold double for tests that exercise transport behavior only. */
export function noopBudgetHold(): BudgetHold {
  return createNoopBudgetHold("test-budget-hold")
}
