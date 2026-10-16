import { useState } from "react";

import type { Problem } from "../problems";
import { type RestartOutcome, restartMaximal } from "../restart";

import { Button } from "./Button";
import { Callout } from "./Callout";

interface ProblemCalloutProps {
  problem: Problem;
  /** For `remedy: "retry"`: run it again. Omit when the surface already has
   *  its own refresh control, so there's never two buttons for one action. */
  onRetry?: () => void;
  /** After a successful restart, reload whatever this section shows. */
  onRestarted?: () => void;
}

const RESTART_FALLBACK: Record<Exclude<RestartOutcome, "restarted">, string> = {
  unavailable: "Settings can't restart Maximal from here. Quit Maximal from the menu bar and open it again.",
  "timed-out": "Maximal didn't come back after restarting. Quit it from the menu bar and open it again.",
};

/**
 * A Problem (shell/src/ui/problems.ts) as a banner: what happened, what it
 * means, the one thing to do about it if there is one, and the raw error
 * folded away under Details.
 */
export function ProblemCallout({ problem, onRetry, onRestarted }: ProblemCalloutProps): JSX.Element {
  const [restarting, setRestarting] = useState(false);
  const [fallback, setFallback] = useState<string | null>(null);

  const restart = async (): Promise<void> => {
    setRestarting(true);
    setFallback(null);
    const outcome = await restartMaximal();
    setRestarting(false);
    if (outcome === "restarted") onRestarted?.();
    else setFallback(RESTART_FALLBACK[outcome]);
  };

  let action: JSX.Element | undefined;
  if (problem.remedy === "restart" && !fallback) {
    action = (
      <Button size="sm" disabled={restarting} onClick={() => void restart()}>
        {restarting ? "Restarting…" : "Restart Maximal"}
      </Button>
    );
  } else if (problem.remedy === "retry" && onRetry) {
    action = (
      <Button size="sm" onClick={onRetry}>
        Try again
      </Button>
    );
  } else if (problem.remedy === "sign-in") {
    action = (
      <a className="btn btn--secondary btn--sm" href="#account">
        Go to Account
      </a>
    );
  }

  return (
    <Callout tone="error" title={problem.title} action={action}>
      <p>{fallback ?? problem.detail}</p>
      <details className="callout__details">
        <summary>Details</summary>
        <code>{problem.technical}</code>
      </details>
    </Callout>
  );
}
