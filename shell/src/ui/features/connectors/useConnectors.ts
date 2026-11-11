import { useCallback, useEffect, useRef, useState } from "react";

import {
  type PluginView,
  listPlugins,
  subscribePluginEvents,
} from "../../../proxy/client";
import { type Problem, describeProblem, withRetry } from "../../problems";

/**
 * The connectors list over `GET /settings/api/plugins` (connectors only;
 * other plugin kinds aren't shown in Settings). The server pushes
 * `plugins.changed` whenever a plugin's lifecycle, status, tools or settings
 * move (a sign-in finishing minutes after the click), so the hook refetches
 * on that frame, on every (re)connect of the stream, and when Settings
 * navigates back to the section. `version` counts those nudges so an open
 * detail page can refetch on the same beat.
 */
export interface ConnectorMutationResult {
  ok: boolean;
  problem?: Problem;
}

interface UseConnectors {
  connectors: Array<PluginView>;
  isLoading: boolean;
  /** The list failed to load after automatic retries. */
  problem: Problem | null;
  /** Increments on every server nudge and manual refresh. */
  version: number;
  refresh: () => Promise<void>;
  /** Fold a fresher copy of one connector (a mutation's reply) into the list. */
  replace: (connector: PluginView) => void;
}

function sortByName(connectors: Array<PluginView>): Array<PluginView> {
  return [...connectors].sort((a, b) => a.displayName.localeCompare(b.displayName));
}

export function useConnectors(): UseConnectors {
  const [connectors, setConnectors] = useState<Array<PluginView>>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [problem, setProblem] = useState<Problem | null>(null);
  const [version, setVersion] = useState(0);

  // One fetch at a time; a nudge that lands mid-fetch asks for one more
  // afterwards so the newest state always wins.
  const inFlight = useRef(false);
  const again = useRef(false);

  const load = useCallback(async () => {
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
          setConnectors(sortByName(result.data.plugins.filter((p) => p.kind === "connector")));
          setProblem(null);
        } else {
          setProblem(describeProblem(result, { subject: "your connectors" }));
        }
        setIsLoading(false);
      } while (again.current);
    } finally {
      inFlight.current = false;
    }
  }, []);

  const refresh = useCallback(async () => {
    setVersion((v) => v + 1);
    await load();
  }, [load]);

  useEffect(() => {
    void load();
  }, [load]);

  // main.ts dispatches this when Settings navigates back to Integrations.
  useEffect(() => {
    const onRefresh = (): void => void refresh();
    window.addEventListener("maximal:connectors-refresh", onRefresh);
    return () => window.removeEventListener("maximal:connectors-refresh", onRefresh);
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

  const replace = useCallback((connector: PluginView) => {
    setConnectors((prev) => sortByName(prev.map((c) => (c.id === connector.id ? connector : c))));
  }, []);

  return { connectors, isLoading, problem, version, refresh, replace };
}
