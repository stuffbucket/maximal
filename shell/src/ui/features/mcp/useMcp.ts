import { useCallback, useEffect, useState } from "react";

import { apiCall } from "../../../proxy/client";
import type {
  McpBrokerHealth,
  McpClientId,
  McpEndpointEntry,
  McpEndpointToggleResponse,
} from "../../../proxy/client";
import { type Problem, describeProblem, withRetry } from "../../problems";

/**
 * Data hook over `/settings/api/mcp`. Owns the list of brokered MCP
 * endpoints, the health of the process that runs them, and the one mutation
 * the screen needs: turn an endpoint on (with the clients it should reach)
 * or off. A toggle restarts the broker and may run the `claude` CLI, so it
 * gets a longer timeout than the default.
 */
const TOGGLE_TIMEOUT_MS = 60_000;

/** Broker states Maximal is still sorting out on its own; the panel
 *  re-reads while in one, doubling the wait from POLL_MIN_MS to POLL_MAX_MS. */
const POLLED_STATES = new Set<McpBrokerHealth["state"]>(["starting", "recovering", "stuck"]);
const POLL_MIN_MS = 2_000;
const POLL_MAX_MS = 30_000;

export interface McpToggleResult {
  ok: boolean;
  problem?: Problem;
  skipped?: McpEndpointToggleResponse["skipped"];
  adoptedFrom?: string;
}

interface UseMcp {
  endpoints: Array<McpEndpointEntry>;
  broker: McpBrokerHealth | null;
  isLoading: boolean;
  /** The list still failed to load after automatic retries. A failed toggle
   *  is reported to its card instead. */
  problem: Problem | null;
  refresh: () => Promise<void>;
  toggle: (
    id: string,
    enabled: boolean,
    clients?: Array<McpClientId>,
  ) => Promise<McpToggleResult>;
}

export function useMcp(): UseMcp {
  const [endpoints, setEndpoints] = useState<Array<McpEndpointEntry>>([]);
  const [broker, setBroker] = useState<McpBrokerHealth | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [problem, setProblem] = useState<Problem | null>(null);

  const refresh = useCallback(async () => {
    const result = await withRetry(() =>
      apiCall({
        kind: "mcp-list",
        method: "GET",
        path: "/settings/api/mcp",
      }),
    );
    if (result.ok) {
      setEndpoints(result.data.endpoints);
      setBroker(result.data.broker);
      setProblem(null);
    } else {
      setProblem(describeProblem(result, { subject: "your MCP servers" }));
    }
    setIsLoading(false);
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Client availability follows the Apps toggles, so refetch when the user
  // navigates back here (dispatched by main.ts on hashchange).
  useEffect(() => {
    const onRefresh = (): void => void refresh();
    window.addEventListener("maximal:mcp-refresh", onRefresh);
    return () => window.removeEventListener("maximal:mcp-refresh", onRefresh);
  }, [refresh]);

  // While Maximal is starting or restarting the broker itself, keep the
  // panel current without anyone clicking anything — backing off, so a
  // broker that stays down doesn't mean a re-read every 2s for as long as
  // the window is open. A state change starts the backoff over.
  const brokerState = broker?.state;
  useEffect(() => {
    if (!brokerState || !POLLED_STATES.has(brokerState)) return;
    let delay = POLL_MIN_MS;
    let timer: ReturnType<typeof setTimeout>;
    const tick = (): void => {
      timer = setTimeout(() => {
        void refresh();
        delay = Math.min(delay * 2, POLL_MAX_MS);
        tick();
      }, delay);
    };
    tick();
    return () => clearTimeout(timer);
  }, [brokerState, refresh]);

  const toggle = useCallback<UseMcp["toggle"]>(
    async (id, enabled, clients) => {
      const result = await apiCall(
        {
          kind: "mcp-toggle",
          method: "POST",
          path: `/settings/api/mcp/${encodeURIComponent(id)}`,
          body: clients === undefined ? { enabled } : { enabled, clients },
        },
        { signal: AbortSignal.timeout(TOGGLE_TIMEOUT_MS) },
      );
      // Whatever happened, show the real state afterwards (and pick up the
      // broker restarting for the change).
      void refresh();
      if (!result.ok) {
        if (result.status === 404) {
          return {
            ok: false,
            problem: {
              title: "This server isn't set up anymore",
              detail:
                "It was removed from Maximal's config.json, so the list has been updated.",
              remedy: "none",
              technical: `HTTP 404: ${result.error}`,
            },
          };
        }
        return {
          ok: false,
          problem: describeProblem(result, { subject: "this server", doing: "save" }),
        };
      }
      const fresh = result.data.endpoint;
      setEndpoints((prev) =>
        prev.map((endpoint) => (endpoint.id === fresh.id ? fresh : endpoint)),
      );
      return {
        ok: true,
        skipped: result.data.skipped,
        adoptedFrom: result.data.adoptedFrom,
      };
    },
    [refresh],
  );

  return { endpoints, broker, isLoading, problem, refresh, toggle };
}
