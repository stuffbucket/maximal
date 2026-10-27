import { useCallback, useEffect, useState } from "react";

import { apiCall } from "../../../proxy/client";
import type {
  McpBrokerHealth,
  McpCatalogItem,
  McpClientId,
  McpEndpointEntry,
  McpEndpointRemoveResponse,
  McpEndpointToggleResponse,
} from "../../../proxy/client";
import { type Problem, describeProblem, withRetry } from "../../problems";

/**
 * Data hook over `/settings/api/mcp`. Owns the list of brokered MCP
 * endpoints, the known servers that could be added, the health of the
 * process that runs them, and the mutations: add a found server, turn an
 * endpoint on (with the clients it should reach) or off, and remove one. A
 * toggle or removal restarts the broker and may run the `claude` CLI, and
 * turning one on waits up to 45s for the broker to start before the apps
 * are updated, so they get a longer timeout than the default.
 */
const TOGGLE_TIMEOUT_MS = 90_000;

/** Broker states Maximal is still sorting out on its own; the panel
 *  re-reads while in one, doubling the wait from POLL_MIN_MS to POLL_MAX_MS. */
const POLLED_STATES = new Set<McpBrokerHealth["state"]>(["starting", "recovering", "stuck"]);
const POLL_MIN_MS = 2_000;
const POLL_MAX_MS = 30_000;

/** Said by the panel, and by a card whose turn-on Maximal refused (409). */
export const UNSUPPORTED_PLATFORM: Problem = {
  title: "MCP servers don't run on Windows yet",
  detail:
    "Maximal can't run them safely on Windows yet. Your choices here are saved for when it can.",
  remedy: "none",
  technical: "MCP_BROKER_CONTAINMENT_UNAVAILABLE",
};

export interface McpToggleResult {
  ok: boolean;
  problem?: Problem;
  skipped?: McpEndpointToggleResponse["skipped"];
  unavailable?: McpEndpointToggleResponse["unavailable"];
  updated?: McpEndpointToggleResponse["updated"];
  broker?: McpEndpointToggleResponse["broker"];
  adoptedFrom?: string;
}

export interface McpMutationResult {
  ok: boolean;
  problem?: Problem;
  removedFrom?: McpEndpointRemoveResponse["removedFrom"];
}

interface UseMcp {
  endpoints: Array<McpEndpointEntry>;
  /** Known servers not added yet, with whether each is installed. */
  available: Array<McpCatalogItem>;
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
  add: (catalogId: string) => Promise<McpMutationResult>;
  remove: (id: string) => Promise<McpMutationResult>;
}

export function useMcp(): UseMcp {
  const [endpoints, setEndpoints] = useState<Array<McpEndpointEntry>>([]);
  const [available, setAvailable] = useState<Array<McpCatalogItem>>([]);
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
      setAvailable(result.data.available);
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
        // Only a turn-on where MCP servers can't run (Windows) conflicts.
        if (result.status === 409) {
          return { ok: false, problem: UNSUPPORTED_PLATFORM };
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
        unavailable: result.data.unavailable,
        updated: result.data.updated,
        broker: result.data.broker,
        adoptedFrom: result.data.adoptedFrom,
      };
    },
    [refresh],
  );

  const add = useCallback<UseMcp["add"]>(
    async (catalogId) => {
      const result = await apiCall({
        kind: "mcp-add",
        method: "POST",
        path: "/settings/api/mcp",
        body: { catalogId },
      });
      void refresh();
      if (result.ok) return { ok: true };
      // Not installed any more, or added meanwhile: the refresh shows which.
      if (result.status === 409 || result.status === 404) {
        return {
          ok: false,
          problem: {
            title: "Couldn't add this server",
            detail:
              "It was uninstalled or already added since this list was shown, so the list has been updated.",
            remedy: "none",
            technical: `HTTP ${result.status}: ${result.error}`,
          },
        };
      }
      return {
        ok: false,
        problem: describeProblem(result, { subject: "this server", doing: "save" }),
      };
    },
    [refresh],
  );

  const remove = useCallback<UseMcp["remove"]>(
    async (id) => {
      const result = await apiCall(
        {
          kind: "mcp-remove",
          method: "DELETE",
          path: `/settings/api/mcp/${encodeURIComponent(id)}`,
        },
        { signal: AbortSignal.timeout(TOGGLE_TIMEOUT_MS) },
      );
      void refresh();
      // Already gone is what the user wanted.
      if (result.ok) return { ok: true, removedFrom: result.data.removedFrom };
      if (result.status === 404) return { ok: true, removedFrom: [] };
      return {
        ok: false,
        problem: describeProblem(result, { subject: "this server", doing: "save" }),
      };
    },
    [refresh],
  );

  return { endpoints, available, broker, isLoading, problem, refresh, toggle, add, remove };
}
