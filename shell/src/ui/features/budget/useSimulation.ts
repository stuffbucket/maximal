import { useEffect, useRef, useState } from "react";

import type { BudgetSimulateRequest, BudgetSimulationResult } from "../../../../../src/lib/config/settings-types";
import { apiCall } from "../../../proxy/client";
import { type Problem, describeProblem } from "../../problems";

import { simulateKey } from "./whatif";

/** How long typing must pause before the draft is replayed. */
export const SIMULATE_DEBOUNCE_MS = 450;

interface UseSimulation {
  /** The last answer, for the draft it was asked about. Kept while the next one loads. */
  result: BudgetSimulationResult | null;
  /** The range the answer covers, as the server resolved it. */
  range: { from: string; to: string } | null;
  /** The draft changed and its replay hasn't come back (or hasn't started: it is waiting out the typing). */
  isPending: boolean;
  problem: Problem | null;
  /** Ask again for the same draft, after a failure. */
  retry: () => void;
}

/**
 * Replays a draft rule over the past (`POST /settings/api/budget/simulate`)
 * as it is typed: the request is sent once typing has paused, an answer to an
 * older draft is dropped, and the previous answer stays up meanwhile so the
 * panel doesn't flicker. No request (`null`: the form isn't a rule yet) clears
 * the answer. A failure leaves the form untouched and only fills `problem`.
 */
export function useSimulation(request: BudgetSimulateRequest | null): UseSimulation {
  const key = simulateKey(request);
  const [result, setResult] = useState<BudgetSimulationResult | null>(null);
  const [range, setRange] = useState<{ from: string; to: string } | null>(null);
  const [settledKey, setSettledKey] = useState("");
  const [problem, setProblem] = useState<Problem | null>(null);
  const [nonce, setNonce] = useState(0);
  const latest = useRef(0);
  const requestRef = useRef(request);
  requestRef.current = request;

  useEffect(() => {
    const ticket = ++latest.current;
    const body = requestRef.current;
    if (body === null) {
      setResult(null);
      setRange(null);
      setProblem(null);
      setSettledKey("");
      return undefined;
    }
    const timer = setTimeout(() => {
      void (async () => {
        const answer = await apiCall({ kind: "budget-simulate", method: "POST", path: "/settings/api/budget/simulate", body });
        if (ticket !== latest.current) return;
        if (answer.ok) {
          setResult(answer.data.results[0] ?? null);
          setRange({ from: answer.data.range.from, to: answer.data.range.to });
          setProblem(null);
        } else {
          setProblem(describeProblem(answer, { subject: "the what-if preview" }));
        }
        setSettledKey(key);
      })();
    }, SIMULATE_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [key, nonce]);

  const retry = (): void => {
    setSettledKey("");
    setNonce((n) => n + 1);
  };

  return { result, range, isPending: key !== "" && key !== settledKey, problem, retry };
}
