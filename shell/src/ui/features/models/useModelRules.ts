import { useEffect, useRef, useState } from "react";

import type { BudgetStatusResponse } from "../../../../../src/lib/config/settings-types";

import { apiCall } from "../../../proxy/client";

/**
 * The rules, for marking which models they apply to. The Rules island owns the
 * live budget EventSource and shares every accepted status through a window
 * event, so the always-mounted Models island does not open a second stream.
 * This is optional decoration: a status that will not load simply leaves the
 * list unmarked, with no banner or retry the model list needs.
 */
export function useModelRules(): Pick<BudgetStatusResponse, "budgets" | "filters"> | null {
  const [status, setStatus] = useState<BudgetStatusResponse | null>(null);
  const latest = useRef(0);

  useEffect(() => {
    let closed = false;

    const load = async (): Promise<void> => {
      const ticket = ++latest.current;
      const result = await apiCall({ kind: "budget-status", method: "GET", path: "/settings/api/budget" });
      if (!closed && ticket === latest.current && result.ok) setStatus(result.data);
    };
    const onChanged = (event: Event): void => {
      latest.current += 1;
      setStatus((event as CustomEvent<BudgetStatusResponse>).detail);
    };
    const onRefresh = (): void => void load();

    window.addEventListener("maximal:budget-status", onChanged);
    window.addEventListener("maximal:models-refresh", onRefresh);
    void load();

    return () => {
      closed = true;
      latest.current += 1;
      window.removeEventListener("maximal:budget-status", onChanged);
      window.removeEventListener("maximal:models-refresh", onRefresh);
    };
  }, []);

  return status;
}
