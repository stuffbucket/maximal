import { useCallback, useEffect, useRef, useState } from "react";

import { t } from "../../../i18n";
import { apiCall } from "../../../proxy/client";
import { type Problem, describeProblem, withRetry } from "../../problems";
import type { AppEntry, AppId } from "../../../proxy/client";
import { humanize } from "../api-clients/humanize";

import { toggleApplied } from "./desktop-restart";

/**
 * Data hook over `/settings/api/apps`. Owns the list of integrations,
 * loading + error state, and the two mutation verbs the Apps screen needs.
 * Each mutation returns a single fresh `AppEntry` (the contract guarantees
 * this), which we splice back into the list in place — no full reload
 * needed, so the rest of the screen doesn't flicker.
 *
 * `refresh()` re-fetches the whole list and is exposed for retries and the
 * nav-driven refetch in main.ts. Returning from official setup instructions
 * also refreshes detection automatically.
 */
export interface MutationResult {
  ok: boolean;
  error?: string;
  /** The server applied the requested state. A refused enable still comes
   *  back `ok` (the fresh entry carries the conflict) but is not applied. */
  applied?: boolean;
}

export interface ToggleAppOptions {
  overrideOtherMaximal?: boolean;
}

interface UseApps {
  apps: Array<AppEntry>;
  isLoading: boolean;
  /** Panel-level: the list failed to load (after automatic retries) or a
   *  change failed. Per-row messages travel on the mutation result. */
  problem: Problem | null;
  refresh: () => Promise<void>;
  toggleApp: (
    appId: AppId,
    enabled: boolean,
    options?: ToggleAppOptions,
  ) => Promise<MutationResult>;
}

type ToggleableAppId = Extract<
  AppId,
  "claude-code" | "claude-desktop" | "codex"
>;

const TOGGLE_ENDPOINTS = {
  "claude-code": {
    kind: "claude-code-toggle",
    path: "/settings/api/apps/claude-code/toggle",
  },
  "claude-desktop": {
    kind: "claude-desktop-toggle",
    path: "/settings/api/apps/claude-desktop/toggle",
  },
  codex: {
    kind: "codex-toggle",
    path: "/settings/api/apps/codex/toggle",
  },
} as const satisfies Record<ToggleableAppId, { kind: string; path: string }>;

function isToggleableAppId(appId: AppId): appId is ToggleableAppId {
  return (
    appId === "claude-code" || appId === "claude-desktop" || appId === "codex"
  );
}

function sortHarnesses(apps: Array<AppEntry>): Array<AppEntry> {
  return [...apps].sort(
    (a, b) =>
      a.name.localeCompare(b.name, "en", { sensitivity: "base" }) ||
      a.id.localeCompare(b.id, "en"),
  );
}

export function useApps(): UseApps {
  const [apps, setApps] = useState<Array<AppEntry>>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [problem, setProblem] = useState<Problem | null>(null);
  const refreshGeneration = useRef(0);

  const refresh = useCallback(async () => {
    const generation = ++refreshGeneration.current;
    const result = await withRetry(() =>
      apiCall({
        kind: "apps-list",
        method: "GET",
        path: "/settings/api/apps",
      }),
    );
    if (generation !== refreshGeneration.current) return;

    if (result.ok) {
      setApps(sortHarnesses(result.data.apps));
      setProblem(null);
    } else {
      setProblem(describeProblem(result, { subject: "your apps" }));
    }
    setIsLoading(false);
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Re-scan when the user navigates back to the Apps section. main.ts
  // dispatches this on hashchange so detected installs stay fresh
  // (parallels the diagnostics/account refetch-on-nav behaviour).
  useEffect(() => {
    const onRefresh = (): void => void refresh();
    window.addEventListener("maximal:apps-refresh", onRefresh);
    return () => window.removeEventListener("maximal:apps-refresh", onRefresh);
  }, [refresh]);

  // Re-scan when the user returns from an app's external setup instructions.
  useEffect(() => {
    const onAttention = (): void => {
      if (document.visibilityState === "visible") void refresh();
    };
    window.addEventListener("focus", onAttention);
    document.addEventListener("visibilitychange", onAttention);
    return () => {
      window.removeEventListener("focus", onAttention);
      document.removeEventListener("visibilitychange", onAttention);
    };
  }, [refresh]);

  // Replace one app's state with the fresh object the mutation returned.
  const splice = useCallback((fresh: AppEntry) => {
    setApps((prev) =>
      sortHarnesses(prev.map((app) => (app.id === fresh.id ? fresh : app))),
    );
  }, []);

  const toggleApp = useCallback<UseApps["toggleApp"]>(
    async (appId, enabled, options) => {
      if (!isToggleableAppId(appId)) {
        return { ok: false, error: t("apps-coming-soon") };
      }
      const endpoint = TOGGLE_ENDPOINTS[appId];

      // A list request started before this mutation must not overwrite its
      // fresher response. Invalidate once before the write and again after it
      // so a re-scan started while the write was in flight is stale too.
      refreshGeneration.current += 1;
      const result = await apiCall({
        ...endpoint,
        method: "POST",
        body: {
          enabled,
          ...(options?.overrideOtherMaximal
            ? { overrideOtherMaximal: true }
            : {}),
        },
      });
      refreshGeneration.current += 1;
      if (!result.ok) {
        const message = humanize(result.error);
        setProblem(
          describeProblem(result, { subject: "your apps", doing: "save" }),
        );
        return { ok: false, error: message };
      }
      setProblem(null);
      splice(result.data);
      return {
        ok: true,
        applied: toggleApplied(result.data, enabled),
      };
    },
    [splice],
  );

  return {
    apps,
    isLoading,
    problem,
    refresh,
    toggleApp,
  };
}
