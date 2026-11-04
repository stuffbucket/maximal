import { useCallback, useEffect, useRef, useState } from "react";

import {
  type PluginClientId,
  type PluginView,
  listPlugins,
  runPluginAction,
  subscribePluginEvents,
  updatePlugin,
} from "../../../proxy/client";
import { type Problem, describeProblem, withRetry } from "../../problems";

/**
 * Data hook over `/settings/api/plugins`. Owns the list, loading and error
 * state, and the two verbs the screen needs (change a plugin, run one of its
 * actions). The server pushes `plugins.changed` whenever a plugin's lifecycle,
 * status or tools move (a sign-in finishing minutes after the click), so the
 * hook refetches on that frame, on every (re)connect of the stream, and when
 * Settings navigates back to the section.
 */
export interface PluginMutationResult {
  ok: boolean;
  problem?: Problem;
}

interface UsePlugins {
  plugins: Array<PluginView>;
  isLoading: boolean;
  /** The list failed to load after automatic retries. Per-plugin failures
   *  travel on the mutation result instead. */
  problem: Problem | null;
  refresh: () => Promise<void>;
  update: (
    id: string,
    change: { enabled?: boolean; clients?: Array<PluginClientId> },
  ) => Promise<PluginMutationResult>;
  runAction: (id: string, actionId: string) => Promise<PluginMutationResult>;
}

function sortByName(plugins: Array<PluginView>): Array<PluginView> {
  return [...plugins].sort((a, b) => a.displayName.localeCompare(b.displayName));
}

export function usePlugins(): UsePlugins {
  const [plugins, setPlugins] = useState<Array<PluginView>>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [problem, setProblem] = useState<Problem | null>(null);

  // One fetch at a time; an event that lands mid-fetch asks for one more
  // afterwards so the newest state always wins.
  const inFlight = useRef(false);
  const again = useRef(false);

  const refresh = useCallback(async () => {
    if (inFlight.current) {
      again.current = true;
      return;
    }
    inFlight.current = true;
    try {
      do {
        again.current = false;
        const result = await withRetry(() => listPlugins());
        if (result.ok) {
          setPlugins(sortByName(result.data.plugins));
          setProblem(null);
        } else {
          setProblem(describeProblem(result, { subject: "your plugins" }));
        }
        setIsLoading(false);
      } while (again.current);
    } finally {
      inFlight.current = false;
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // main.ts dispatches this when Settings navigates back to Integrations.
  useEffect(() => {
    const onRefresh = (): void => void refresh();
    window.addEventListener("maximal:plugins-refresh", onRefresh);
    return () => window.removeEventListener("maximal:plugins-refresh", onRefresh);
  }, [refresh]);

  useEffect(() => {
    let closed = false;
    let close: (() => void) | undefined;
    void subscribePluginEvents({
      onChanged: () => void refresh(),
      onOpen: () => void refresh(),
    }).then((subscription) => {
      if (closed) subscription.close();
      else close = subscription.close;
    });
    return () => {
      closed = true;
      close?.();
    };
  }, [refresh]);

  const update = useCallback<UsePlugins["update"]>(async (id, change) => {
    const result = await updatePlugin(id, change);
    if (!result.ok) {
      return {
        ok: false,
        problem: describeProblem(result, { subject: "your plugins", doing: "save" }),
      };
    }
    setPlugins((prev) =>
      sortByName(prev.map((plugin) => (plugin.id === result.data.id ? result.data : plugin))),
    );
    return { ok: true };
  }, []);

  const runAction = useCallback<UsePlugins["runAction"]>(
    async (id, actionId) => {
      const result = await runPluginAction(id, actionId);
      if (!result.ok) {
        return {
          ok: false,
          problem: describeProblem(result, { subject: "your plugins", doing: "save" }),
        };
      }
      // The action is under way; its outcome shows up as a status change.
      void refresh();
      return { ok: true };
    },
    [refresh],
  );

  return { plugins, isLoading, problem, refresh, update, runAction };
}
