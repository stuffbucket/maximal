import { useCallback, useEffect, useState } from "react";

import { apiCall } from "../../../proxy/client";
import type {
  ModelsListResponse,
  ModelSummary,
} from "../../../../../src/lib/config/settings-types";

/**
 * Data hook over `/settings/api/models`. Owns the model list, the
 * cache's `loadedAt` timestamp, loading/error/refreshing state, and a
 * `refresh()` verb that forces an upstream re-fetch.
 *
 * The list loads once on mount (GET). `refresh()` is a separate POST so
 * the button can show its own in-flight state without blanking the list
 * — the stale list stays visible while the fresh fetch runs.
 */
interface UseModels {
  models: Array<ModelSummary>;
  loadedAt: string | null;
  isLoading: boolean;
  isRefreshing: boolean;
  error: string | null;
  refresh: () => Promise<void>;
}

function applyResult(
  result: ModelsListResponse,
  set: {
    setModels: (m: Array<ModelSummary>) => void;
    setLoadedAt: (t: string | null) => void;
  },
): void {
  set.setModels(result.models);
  set.setLoadedAt(result.loaded_at);
}

export function useModels(): UseModels {
  const [models, setModels] = useState<Array<ModelSummary>>([]);
  const [loadedAt, setLoadedAt] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const result = await apiCall({
      kind: "models-list",
      method: "GET",
      path: "/settings/api/models",
    });
    if (result.ok) {
      applyResult(result.data, { setModels, setLoadedAt });
      setError(null);
    } else {
      setError(result.error);
    }
    setIsLoading(false);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // Re-pull when the user navigates back to the Models section. main.ts
  // dispatches this on hashchange so the list + freshness stay current
  // (parallels the apps/diagnostics refetch-on-nav behaviour). This is the
  // cheap GET, not a forced upstream refresh — that stays on the button.
  useEffect(() => {
    const onRefresh = (): void => void load();
    window.addEventListener("maximal:models-refresh", onRefresh);
    return () => window.removeEventListener("maximal:models-refresh", onRefresh);
  }, [load]);

  const refresh = useCallback(async () => {
    setIsRefreshing(true);
    const result = await apiCall({
      kind: "models-refresh",
      method: "POST",
      path: "/settings/api/models/refresh",
    });
    if (result.ok) {
      applyResult(result.data, { setModels, setLoadedAt });
      setError(null);
    } else {
      // Keep the stale list visible; surface why the refresh failed.
      setError(result.error);
    }
    setIsRefreshing(false);
  }, []);

  return { models, loadedAt, isLoading, isRefreshing, error, refresh };
}
