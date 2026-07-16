import { useCallback, useEffect, useState } from "react";

import type {
  QuotaDetails,
  TokenUsageEventsPage,
  TokenUsageSummary,
} from "./usage-types";

/**
 * Data hook over `/token-usage`, `/usage`, and `/token-usage/events` (spec §4).
 * These endpoints are loopback-exempt from auth, so a same-origin fetch from the
 * tab needs no key. Loads on mount and on the `maximal:usage-refresh`/nav signal;
 * a live `usage` WS event also nudges it.
 */
export type UsagePeriod = "day" | "week" | "month" | "all";

const EVENTS_PAGE_SIZE = 20;

interface UseUsage {
  summary: TokenUsageSummary | null;
  quotas: Record<string, QuotaDetails> | null;
  events: TokenUsageEventsPage | null;
  period: UsagePeriod;
  setPeriod: (p: UsagePeriod) => void;
  page: number;
  setPage: (p: number) => void;
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

/** Quota snapshots from `/usage`. Best-effort: a failure just hides the cards. */
async function fetchQuotas(): Promise<Record<string, QuotaDetails> | null> {
  try {
    const res = await fetch("/usage");
    if (!res.ok) return null;
    const data = (await res.json()) as {
      quota_snapshots?: Record<string, QuotaDetails> | null;
    };
    return data.quota_snapshots ?? null;
  } catch {
    return null;
  }
}

/** A page of recent events. Best-effort: a failure just hides the table. */
async function fetchEvents(
  period: UsagePeriod,
  page: number,
): Promise<TokenUsageEventsPage | null> {
  try {
    const res = await fetch(
      `/token-usage/events?period=${encodeURIComponent(period)}&page=${page}&page_size=${EVENTS_PAGE_SIZE}`,
    );
    if (!res.ok) return null;
    return (await res.json()) as TokenUsageEventsPage;
  } catch {
    return null;
  }
}

export function useUsage(): UseUsage {
  const [summary, setSummary] = useState<TokenUsageSummary | null>(null);
  const [quotas, setQuotas] = useState<Record<string, QuotaDetails> | null>(
    null,
  );
  const [events, setEvents] = useState<TokenUsageEventsPage | null>(null);
  const [period, setPeriodState] = useState<UsagePeriod>("day");
  const [page, setPage] = useState(1);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Changing the period resets to the first page — the old page number is
  // meaningless against a different period's event set.
  const setPeriod = useCallback((p: UsagePeriod) => {
    setPeriodState(p);
    setPage(1);
  }, []);

  const load = useCallback(async () => {
    const [result, quotaSnapshots, eventsPage] = await Promise.all([
      fetchSummary(period),
      fetchQuotas(),
      fetchEvents(period, page),
    ]);
    if (result.ok) {
      setSummary(result.data);
      setError(null);
    } else {
      setError(result.error);
    }
    setQuotas(quotaSnapshots);
    setEvents(eventsPage);
    setIsLoading(false);
  }, [period, page]);

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

  return {
    summary,
    quotas,
    events,
    period,
    setPeriod,
    page,
    setPage,
    isLoading,
    error,
    refresh: load,
  };
}
