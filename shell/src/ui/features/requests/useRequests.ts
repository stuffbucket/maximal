import { useCallback, useEffect, useState } from "react";

import {
  type PendingRequest,
  type PendingRequestAnswer,
  apiCall,
  subscribeRequestEvents,
} from "../../../proxy/client";
import { type Problem, describeProblem, withRetry } from "../../problems";

/**
 * Data hook over `/settings/api/requests`: MCP servers' requests for user
 * input waiting for an answer in Maximal. Loads the list, keeps it live
 * from the `requests.changed` event, and sends answers. A request can be
 * withdrawn (it timed out, or the server or its session went away) or
 * answered elsewhere at any moment; answering one that's gone says so
 * rather than failing.
 */

export type AnswerOutcome =
  | { ok: true }
  /** No longer waiting: withdrawn, expired, or answered already. */
  | { ok: false; gone: true }
  /** The server's form didn't accept the values; one message per field. */
  | { ok: false; gone: false; fieldErrors: Record<string, string> }
  | { ok: false; gone: false; problem: Problem };

interface UseRequests {
  requests: Array<PendingRequest>;
  isLoading: boolean;
  problem: Problem | null;
  refresh: () => Promise<void>;
  answer: (id: string, answer: PendingRequestAnswer) => Promise<AnswerOutcome>;
}

/** "name: message; other: message" (the route's 422 body) by field. */
function parseFieldErrors(body: string): Record<string, string> {
  const errors: Record<string, string> = {};
  for (const part of body.split("; ")) {
    const separator = part.indexOf(": ");
    if (separator > 0) errors[part.slice(0, separator)] = part.slice(separator + 2);
  }
  return errors;
}

export function useRequests(): UseRequests {
  const [requests, setRequests] = useState<Array<PendingRequest>>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [problem, setProblem] = useState<Problem | null>(null);

  const refresh = useCallback(async () => {
    const result = await withRetry(() =>
      apiCall({ kind: "requests-list", method: "GET", path: "/settings/api/requests" }),
    );
    if (result.ok) {
      setRequests(result.data.requests);
      setProblem(null);
    } else {
      setProblem(describeProblem(result, { subject: "waiting requests" }));
    }
    setIsLoading(false);
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    const onRefresh = (): void => void refresh();
    window.addEventListener("maximal:requests-refresh", onRefresh);
    return () => window.removeEventListener("maximal:requests-refresh", onRefresh);
  }, [refresh]);

  // Live updates: a request arriving, being answered, or withdrawn.
  useEffect(() => {
    let closed = false;
    let close = (): void => undefined;
    void subscribeRequestEvents({
      onRequests: (next) => {
        setRequests(next.requests);
        setProblem(null);
        setIsLoading(false);
      },
    }).then((subscription) => {
      if (closed) subscription.close();
      else close = subscription.close;
    });
    return () => {
      closed = true;
      close();
    };
  }, []);

  const answer = useCallback<UseRequests["answer"]>(
    async (id, body) => {
      const result = await apiCall({
        kind: "requests-answer",
        method: "POST",
        path: `/settings/api/requests/${encodeURIComponent(id)}`,
        body,
      });
      if (result.ok) {
        setRequests((current) => current.filter((request) => request.id !== id));
        return { ok: true };
      }
      if (result.status === 404 || result.status === 409) {
        setRequests((current) => current.filter((request) => request.id !== id));
        return { ok: false, gone: true };
      }
      if (result.status === 422) {
        return { ok: false, gone: false, fieldErrors: parseFieldErrors(result.error) };
      }
      return {
        ok: false,
        gone: false,
        problem: describeProblem(result, { subject: "your answer", doing: "save" }),
      };
    },
    [],
  );

  return { requests, isLoading, problem, refresh, answer };
}
