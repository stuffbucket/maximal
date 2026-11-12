import { useCallback, useEffect, useRef, useState } from "react";

import {
  type ApiResult,
  apiCall,
  subscribeBudgetEvents,
} from "../../../proxy/client";
import { type Problem, describeProblem, withRetry } from "../../problems";
import type {
  BudgetLimitPutRequest,
  BudgetStatusResponse,
} from "../../../../../src/lib/config/settings-types";

/**
 * The budget over `GET /settings/api/budget`, kept live. The server pushes the
 * whole status as `budget.changed` whenever a limit, the on/off switch or the
 * display unit changes, or a limit crosses its warning, so the hook takes that
 * frame as it comes and refetches only on a (re)connect of the stream and when
 * the surface is shown again. `version` counts every new status so the
 * activity can refetch on the same beat.
 */
interface UseBudget {
  status: BudgetStatusResponse | null;
  isLoading: boolean;
  /** The status failed to load after automatic retries. A failed refresh keeps the last good status. */
  problem: Problem | null;
  version: number;
  refresh: () => Promise<void>;
  /** Each change answers with the new status (folded in) or why it didn't save. */
  setEnabled: (enabled: boolean) => Promise<Problem | null>;
  setUnit: (unit: BudgetStatusResponse["display"]["unit"]) => Promise<Problem | null>;
  saveLimit: (id: string, body: BudgetLimitPutRequest) => Promise<Problem | null>;
  deleteLimit: (id: string) => Promise<Problem | null>;
}

const limitPath = (id: string): `/settings/api/budget/limits/${string}` =>
  `/settings/api/budget/limits/${encodeURIComponent(id)}`;

export function useBudget(): UseBudget {
  const [status, setStatus] = useState<BudgetStatusResponse | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [problem, setProblem] = useState<Problem | null>(null);
  const [version, setVersion] = useState(0);

  // One fetch at a time; a nudge that lands mid-fetch asks for one more
  // afterwards so the newest state wins.
  const inFlight = useRef(false);
  const again = useRef(false);

  const accept = useCallback((next: BudgetStatusResponse) => {
    setStatus(next);
    setProblem(null);
    setVersion((v) => v + 1);
  }, []);

  const load = useCallback(async () => {
    if (inFlight.current) {
      again.current = true;
      return;
    }
    inFlight.current = true;
    try {
      do {
        again.current = false;
        const result = await withRetry(() =>
          apiCall({ kind: "budget-status", method: "GET", path: "/settings/api/budget" }),
        );
        if (result.ok) accept(result.data);
        else setProblem(describeProblem(result, { subject: "your budget" }));
        setIsLoading(false);
      } while (again.current);
    } finally {
      inFlight.current = false;
    }
  }, [accept]);

  useEffect(() => {
    void load();
  }, [load]);

  // main.ts dispatches this when the Rules surface is shown, so what was
  // spent while another surface was up is current on arrival.
  useEffect(() => {
    const onRefresh = (): void => void load();
    window.addEventListener("maximal:budget-refresh", onRefresh);
    return () => window.removeEventListener("maximal:budget-refresh", onRefresh);
  }, [load]);

  useEffect(() => {
    let closed = false;
    let close: (() => void) | undefined;
    void subscribeBudgetEvents({
      onChanged: accept,
      onOpen: () => void load(),
    }).then((subscription) => {
      if (closed) subscription.close();
      else close = subscription.close;
    });
    return () => {
      closed = true;
      close?.();
    };
  }, [accept, load]);

  const change = useCallback(
    async (call: () => Promise<ApiResult<BudgetStatusResponse>>): Promise<Problem | null> => {
      const result = await call();
      if (result.ok) {
        accept(result.data);
        return null;
      }
      return describeProblem(result, { subject: "your budget", doing: "save" });
    },
    [accept],
  );

  const setEnabled = useCallback(
    (enabled: boolean) =>
      change(() =>
        apiCall({ kind: "budget-settings", method: "PATCH", path: "/settings/api/budget", body: { enabled } }),
      ),
    [change],
  );
  const setUnit = useCallback(
    (unit: BudgetStatusResponse["display"]["unit"]) =>
      change(() =>
        apiCall({
          kind: "budget-settings",
          method: "PATCH",
          path: "/settings/api/budget",
          body: { display_unit: unit },
        }),
      ),
    [change],
  );
  const saveLimit = useCallback(
    (id: string, body: BudgetLimitPutRequest) =>
      change(() => apiCall({ kind: "budget-limit-put", method: "PUT", path: limitPath(id), body })),
    [change],
  );
  const deleteLimit = useCallback(
    (id: string) =>
      change(() => apiCall({ kind: "budget-limit-delete", method: "DELETE", path: limitPath(id) })),
    [change],
  );

  return { status, isLoading, problem, version, refresh: load, setEnabled, setUnit, saveLimit, deleteLimit };
}
