import { useCallback, useEffect, useRef, useState } from "react";

import { apiCall } from "../../../proxy/client";
import { type Problem, describeProblem, withRetry } from "../../problems";
import type { BudgetActivityResponse } from "../../../../../src/lib/config/settings-types";

import { type ActivityGroup, activityQuery } from "./format";
import type { RangeChoice } from "./range";

/**
 * Usage for one range and grouping over `GET /settings/api/budget/activity`.
 * Refetches when the choice changes and whenever `version` moves (the budget
 * changed). The previous rows stay on screen while the next ones load, so
 * switching the picker doesn't blank the chart; a failed load drops them, so
 * a range's figures are never shown under another range's heading. A custom
 * range that isn't complete yet (a cleared date) asks for nothing.
 */
interface UseBudgetActivity {
  activity: BudgetActivityResponse | null;
  isLoading: boolean;
  problem: Problem | null;
  refresh: () => void;
}

export function useBudgetActivity(choice: RangeChoice, group: ActivityGroup, version: number): UseBudgetActivity {
  const [activity, setActivity] = useState<BudgetActivityResponse | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [problem, setProblem] = useState<Problem | null>(null);
  const latest = useRef(0);
  const query = activityQuery(choice, group);

  const load = useCallback(async () => {
    const ticket = ++latest.current;
    if (query === null) {
      setIsLoading(false);
      return;
    }
    const result = await withRetry(() =>
      apiCall({
        kind: "budget-activity",
        method: "GET",
        path: `/settings/api/budget/activity?${query}`,
      }),
    );
    // A slower earlier answer must not overwrite the one for the current choice.
    if (ticket !== latest.current) return;
    if (result.ok) {
      setActivity(result.data);
      setProblem(null);
    } else {
      setActivity(null);
      setProblem(describeProblem(result, { subject: "your spending" }));
    }
    setIsLoading(false);
  }, [query]);

  useEffect(() => {
    setIsLoading(true);
    void load();
  }, [load, version]);

  const refresh = useCallback(() => {
    setIsLoading(true);
    void load();
  }, [load]);

  return { activity, isLoading, problem, refresh };
}
