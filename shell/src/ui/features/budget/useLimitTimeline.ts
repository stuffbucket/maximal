import { useCallback, useEffect, useRef, useState } from "react";

import { apiCall } from "../../../proxy/client";
import { type Problem, describeProblem, withRetry } from "../../problems";

import type { RangeChoice } from "./range";
import { type Timeline, timelinePath } from "./timeline";

interface UseLimitTimeline {
  timeline: Timeline | null;
  isLoading: boolean;
  problem: Problem | null;
  refresh: () => void;
}

/**
 * How one rule performed over a range, from `GET /settings/api/budget/limits/:id/timeline`.
 * Refetches when the range changes and whenever `version` moves (the budget
 * changed), keeping the previous answer on screen meanwhile; a failed load
 * drops it, so a range's figures never sit under another's. `enabled` false
 * asks for nothing (a closed detail view).
 */
export function useLimitTimeline(id: string, choice: RangeChoice, version: number, enabled = true): UseLimitTimeline {
  const [timeline, setTimeline] = useState<Timeline | null>(null);
  const [isLoading, setIsLoading] = useState(enabled);
  const [problem, setProblem] = useState<Problem | null>(null);
  const latest = useRef(0);
  const path = timelinePath(id, choice);

  const load = useCallback(async () => {
    const ticket = ++latest.current;
    if (path === null || !enabled) {
      setIsLoading(false);
      return;
    }
    const result = await withRetry(() => apiCall({ kind: "budget-timeline", method: "GET", path }));
    // A slower earlier answer must not overwrite the one for the current choice.
    if (ticket !== latest.current) return;
    if (result.ok) {
      setTimeline(result.data);
      setProblem(null);
    } else {
      setTimeline(null);
      setProblem(describeProblem(result, { subject: "this rule's history" }));
    }
    setIsLoading(false);
  }, [path, enabled]);

  useEffect(() => {
    if (enabled) setIsLoading(true);
    void load();
  }, [load, version, enabled]);

  const refresh = useCallback(() => {
    setIsLoading(true);
    void load();
  }, [load]);

  return { timeline, isLoading, problem, refresh };
}
