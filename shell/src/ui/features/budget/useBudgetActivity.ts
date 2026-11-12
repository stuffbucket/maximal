import { useCallback, useEffect, useRef, useState } from "react";

import { apiCall } from "../../../proxy/client";
import { type Problem, describeProblem, withRetry } from "../../problems";
import type { BudgetActivityResponse } from "../../../../../src/lib/config/settings-types";

import { type ActivityGroup, type ActivityPeriod, activityQuery } from "./format";

/**
 * Spend for one period and grouping over `GET /settings/api/budget/activity`.
 * Refetches when the choice changes and whenever `version` moves (the budget
 * changed), and keeps the previous rows on screen while the next ones load so
 * switching the picker doesn't blank the chart.
 */
interface UseBudgetActivity {
  activity: BudgetActivityResponse | null;
  isLoading: boolean;
  problem: Problem | null;
}

export function useBudgetActivity(
  period: ActivityPeriod,
  group: ActivityGroup,
  version: number,
): UseBudgetActivity {
  const [activity, setActivity] = useState<BudgetActivityResponse | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [problem, setProblem] = useState<Problem | null>(null);
  const latest = useRef(0);

  const load = useCallback(async () => {
    const ticket = ++latest.current;
    const result = await withRetry(() =>
      apiCall({
        kind: "budget-activity",
        method: "GET",
        path: `/settings/api/budget/activity?${activityQuery(period, group)}`,
      }),
    );
    // A slower earlier answer must not overwrite the one for the current choice.
    if (ticket !== latest.current) return;
    if (result.ok) {
      setActivity(result.data);
      setProblem(null);
    } else {
      setProblem(describeProblem(result, { subject: "your spending" }));
    }
    setIsLoading(false);
  }, [period, group]);

  useEffect(() => {
    setIsLoading(true);
    void load();
  }, [load, version]);

  return { activity, isLoading, problem };
}
