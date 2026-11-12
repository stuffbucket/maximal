import { useCallback, useEffect, useRef, useState } from "react";

import type { BudgetSessionsResponse } from "../../../../../src/lib/config/settings-types";
import { apiCall } from "../../../proxy/client";
import { type Problem, describeProblem, withRetry } from "../../problems";

import type { RangeChoice } from "./range";
import { sessionsPath } from "./sessions";

interface UseSessions {
  report: BudgetSessionsResponse | null;
  isLoading: boolean;
  problem: Problem | null;
  refresh: () => void;
}

/**
 * What each session cost over a range, biggest first (`GET /settings/api/budget/sessions`).
 * Refetches when the range changes, clearing the previous list before the new
 * range is named so sessions never sit under another range's heading. A custom
 * range that isn't complete yet asks for nothing.
 */
export function useSessions(choice: RangeChoice): UseSessions {
  const [report, setReport] = useState<BudgetSessionsResponse | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [problem, setProblem] = useState<Problem | null>(null);
  const latest = useRef(0);
  const path = sessionsPath(choice);

  const load = useCallback(async () => {
    const ticket = ++latest.current;
    if (path === null) {
      setIsLoading(false);
      return;
    }
    const result = await withRetry(() => apiCall({ kind: "budget-sessions", method: "GET", path }));
    if (ticket !== latest.current) return;
    if (result.ok) {
      setReport(result.data);
      setProblem(null);
    } else {
      setReport(null);
      setProblem(describeProblem(result, { subject: "your sessions" }));
    }
    setIsLoading(false);
  }, [path]);

  useEffect(() => {
    setReport(null);
    setProblem(null);
    setIsLoading(true);
    void load();
  }, [load]);

  const refresh = useCallback(() => {
    setIsLoading(true);
    void load();
  }, [load]);

  return { report, isLoading, problem, refresh };
}
