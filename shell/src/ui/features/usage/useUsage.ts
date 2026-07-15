import { useCallback, useEffect, useState } from "react";

import type { TokenUsageSummary } from "./usage-types";

/**
 * Data hook over `/token-usage` (spec §4). The endpoint is loopback-exempt from
 * auth, so a same-origin fetch from the tab needs no key. Loads on mount and on
 * the `maximal:models-refresh`/nav signal; a live `usage` WS event also nudges it.
 *
 * Kept deliberately close to the standalone dashboard's fetch: one GET for the
 * period summary (totals + per-model breakdown). The events table + pagination
 * from the old dashboard are a follow-on; this lands the headline usage view.
 */
export type UsagePeriod = "day" | "week" | "month" | "all";

interface UseUsage {
  summary: TokenUsageSummary | null;
  period: UsagePeriod;
  setPeriod: (p: UsagePeriod) => void;
  isLoading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
}

async function fetchSummary(
  period: UsagePeriod,
): Promise<{ ok: true; data: TokenUsageSummary } | { ok: false; error: string }> {
  try {
    const res = await fetch(
      `/token-usage?period=${encodeURIComponent(period)}`,
    );
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
    return { ok: true, data: (await res.json()) as TokenUsageSummary };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export function useUsage(): UseUsage {
  const [summary, setSummary] = useState<TokenUsageSummary | null>(null);
  const [period, setPeriod] = useState<UsagePeriod>("day");
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const result = await fetchSummary(period);
    if (result.ok) {
      setSummary(result.data);
      setError(null);
    } else {
      setError(result.error);
    }
    setIsLoading(false);
  }, [period]);

  useEffect(() => {
    void load();
  }, [load]);

  // Re-pull on nav back to Usage and on a live `usage` WS event (main.ts
  // dispatches the same channel the islands already use).
  useEffect(() => {
    const onRefresh = (): void => void load();
    window.addEventListener("maximal:usage-refresh", onRefresh);
    return () =>
      window.removeEventListener("maximal:usage-refresh", onRefresh);
  }, [load]);

  return { summary, period, setPeriod, isLoading, error, refresh: load };
}
