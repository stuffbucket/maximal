import { useCallback, useEffect, useState } from "react";

import { apiCall } from "../../../proxy/client";
import type {
  McpBrokerHealth,
  McpCatalogItem,
  McpClientId,
  McpEndpointEntry,
  McpEndpointRemoveResponse,
  McpEndpointToggleResponse,
  WorkIqStatus,
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
/** A Work IQ sign-in Maximal is running: re-read every POLL_MIN_MS. */
const SIGNING_IN = new Set<WorkIqStatus["signIn"]>(["waiting", "restarting"]);
/** Accepting the EULA runs a Work IQ command and may restart the broker. */
const WORKIQ_TIMEOUT_MS = 60_000;

/** Said by the panel when Windows wouldn't let Maximal make sure the
 *  servers stop when it does, so it didn't start them. */
export const CONTAINMENT_UNAVAILABLE: Problem = {
  title: "MCP servers couldn't start",
  detail:
    "Maximal only runs MCP servers when it can make sure they stop when Maximal does, and Windows didn't allow that this time. Restarting Maximal tries again. Your choices here are kept.",
  remedy: "restart",
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
  /** Work IQ steps the user confirmed: accept Microsoft's EULA; start a
   *  sign-in (optionally switching to browser sign-in first); cancel it. */
  acceptWorkIqEula: (id: string) => Promise<McpMutationResult>;
  signInWorkIq: (id: string, useBrowserSignIn: boolean) => Promise<McpMutationResult>;
  cancelWorkIqSignIn: (id: string) => Promise<void>;
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
  // A Work IQ sign-in in progress is followed closely, so the card moves on
  // as soon as the browser step is done.
  const brokerState = broker?.state;
  const signingIn = endpoints.some(
    (endpoint) => endpoint.workiq !== undefined && SIGNING_IN.has(endpoint.workiq.signIn),
  );
  const workiqStarting = endpoints.some((endpoint) => endpoint.workiq?.state === "starting");
  const workiqKey = endpoints
    .map((endpoint) => `${endpoint.workiq?.state}:${endpoint.workiq?.signIn}`)
    .join();
  useEffect(() => {
    const brokerPolled = brokerState !== undefined && POLLED_STATES.has(brokerState);
    if (!brokerPolled && !signingIn && !workiqStarting) return;
    const maxDelay = signingIn ? POLL_MIN_MS : POLL_MAX_MS;
    let delay = POLL_MIN_MS;
    let timer: ReturnType<typeof setTimeout>;
    const tick = (): void => {
      timer = setTimeout(() => {
        void refresh();
        delay = Math.min(delay * 2, maxDelay);
        tick();
      }, delay);
    };
    tick();
    return () => clearTimeout(timer);
  }, [brokerState, signingIn, workiqStarting, workiqKey, refresh]);

  /** Show a Work IQ step's result on its card right away. */
  const setWorkIq = useCallback((id: string, workiq: WorkIqStatus): void => {
    setEndpoints((prev) =>
      prev.map((endpoint) => (endpoint.id === id ? { ...endpoint, workiq } : endpoint)),
    );
  }, []);

  const acceptWorkIqEula = useCallback<UseMcp["acceptWorkIqEula"]>(
    async (id) => {
      const result = await apiCall(
        {
          kind: "mcp-workiq-accept-eula",
          method: "POST",
          path: `/settings/api/mcp/${encodeURIComponent(id)}/workiq/accept-eula`,
        },
        { signal: AbortSignal.timeout(WORKIQ_TIMEOUT_MS) },
      );
      if (result.ok) setWorkIq(id, result.data.workiq);
      void refresh();
      if (result.ok) return { ok: true };
      return {
        ok: false,
        problem: describeProblem(result, { subject: "Work IQ", doing: "save" }),
      };
    },
    [refresh, setWorkIq],
  );

  const signInWorkIq = useCallback<UseMcp["signInWorkIq"]>(
    async (id, useBrowserSignIn) => {
      const result = await apiCall(
        {
          kind: "mcp-workiq-sign-in",
          method: "POST",
          path: `/settings/api/mcp/${encodeURIComponent(id)}/workiq/sign-in`,
          body: { useBrowserSignIn },
        },
        { signal: AbortSignal.timeout(WORKIQ_TIMEOUT_MS) },
      );
      if (result.ok) {
        setWorkIq(id, result.data.workiq);
        return { ok: true };
      }
      return {
        ok: false,
        problem: describeProblem(result, { subject: "Work IQ", doing: "save" }),
      };
    },
    [setWorkIq],
  );

  const cancelWorkIqSignIn = useCallback<UseMcp["cancelWorkIqSignIn"]>(
    async (id) => {
      const result = await apiCall({
        kind: "mcp-workiq-cancel-sign-in",
        method: "DELETE",
        path: `/settings/api/mcp/${encodeURIComponent(id)}/workiq/sign-in`,
      });
      if (result.ok) setWorkIq(id, result.data.workiq);
      void refresh();
    },
    [refresh, setWorkIq],
  );

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
      // The toggle's answer has no Work IQ status; keep the last one until
      // the refresh brings a new one.
      const fresh = result.data.endpoint;
      setEndpoints((prev) =>
        prev.map((endpoint) => (endpoint.id === fresh.id ? { ...endpoint, ...fresh } : endpoint)),
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

  return {
    endpoints,
    available,
    broker,
    isLoading,
    problem,
    refresh,
    toggle,
    add,
    remove,
    acceptWorkIqEula,
    signInWorkIq,
    cancelWorkIqSignIn,
  };
}
