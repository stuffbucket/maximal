import { useEffect, useRef, useState } from "react";

import { t } from "../../../i18n";
import type { PluginAttentionRequest, PluginStatus, PluginStatusAction } from "../../../proxy/client";
import { Button } from "../../components/Button";
import { Callout } from "../../components/Callout";
import { ConfirmDialog } from "../../components/ConfirmDialog";
import { ProblemCallout } from "../../components/ProblemCallout";
import type { Problem } from "../../problems";

import { AttentionRequestDialog } from "./AttentionRequestDialog";
import type { ConnectorLine } from "./connector-state";
import { ConnectorText } from "./ConnectorText";
import type { ConnectorMutationResult } from "./useConnectors";

const SUBMITTED_REQUEST_TIMEOUT_MS = 5000;

interface ConnectorStatusBlockProps {
  line: ConnectorLine;
  /** The connector's own report; absent while it is still starting. */
  status?: PluginStatus;
  onAction: (actionId: string) => Promise<ConnectorMutationResult>;
}

/** The connector asks for a kind of button; the design system supplies it.
 *  Destructive is the quiet one (a ghost that reads red, components.md →
 *  Buttons): it opens the connector's confirmation, and the dialog's own button
 *  is the solid red one. */
function buttonFor(action: PluginStatusAction): { variant: "primary" | "secondary" | "ghost"; className?: string } {
  switch (action.kind) {
    case "primary":
      return { variant: "primary" };
    case "destructive":
      return { variant: "ghost", className: "btn--ghost-destructive" };
    default:
      return { variant: "secondary" };
  }
}

/**
 * What the connector says about itself, always in view: the one-line state, its
 * detail, any facts (account, tenant…), and the buttons for what to do next.
 * Every word of `status` is the connector's English and is shown as written.
 * An action with `confirm` asks first, in a dialog that repeats its text.
 */
export function ConnectorStatusBlock({ line, status, onAction }: ConnectorStatusBlockProps): JSX.Element {
  const [confirming, setConfirming] = useState<PluginStatusAction | null>(null);
  // The action whose request is in flight (the connector answers at once; the
  // outcome arrives as a status change).
  const [running, setRunning] = useState<string | null>(null);
  const [failed, setFailed] = useState<{ problem: Problem; actionId: string } | null>(null);

  // The plugin's own questions (a panel asking to pair), each asked in a dialog.
  // A submitted one is hidden while the asynchronous action catches up. If the
  // request remains in status, reveal it again rather than suppressing it forever.
  const [reviewing, setReviewing] = useState(false);
  const [submitted, setSubmitted] = useState<ReadonlySet<string>>(new Set());
  const submittedRef = useRef(new Set<string>());
  const submittedTimers = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  const answering = useRef(new Set<string>());
  const lineRef = useRef<HTMLParagraphElement>(null);
  const refocusLine = useRef(false);
  const attention = status?.attention;
  const requests = (attention?.requests ?? []).filter((request) => !submitted.has(request.approve.id));
  const current = requests[0];
  const waitingIds = (attention?.requests ?? []).map((request) => request.approve.id).join("\n");

  useEffect(() => {
    // Once status has moved past a submitted request, its local suppression is
    // no longer needed. This also cancels the fallback that would reveal it.
    const live = new Set(waitingIds === "" ? [] : waitingIds.split("\n"));
    let changed = false;
    for (const id of submittedRef.current) {
      if (live.has(id)) continue;
      submittedRef.current.delete(id);
      clearTimeout(submittedTimers.current.get(id));
      submittedTimers.current.delete(id);
      changed = true;
    }
    if (changed) setSubmitted(new Set(submittedRef.current));
  }, [waitingIds]);

  useEffect(() => () => {
    for (const timer of submittedTimers.current.values()) clearTimeout(timer);
  }, []);

  useEffect(() => {
    // The Review button went with the last question; keep focus in the page.
    if (current !== undefined) return;
    setReviewing(false);
    if (refocusLine.current) {
      refocusLine.current = false;
      lineRef.current?.focus();
    }
  }, [current]);

  const run = async (actionId: string): Promise<boolean> => {
    setRunning(actionId);
    setFailed(null);
    const result = await onAction(actionId);
    setRunning(null);
    setConfirming(null);
    if (!result.ok && result.problem) setFailed({ problem: result.problem, actionId });
    return result.ok;
  };

  const answer = async (request: PluginAttentionRequest, verdict: "approve" | "decline"): Promise<void> => {
    const requestId = request.approve.id;
    if (answering.current.has(requestId) || submittedRef.current.has(requestId)) return;
    answering.current.add(requestId);
    try {
      const ok = await run(request[verdict].id);
      if (ok) {
        refocusLine.current = true;
        submittedRef.current.add(requestId);
        setSubmitted(new Set(submittedRef.current));
        const timer = setTimeout(() => {
          submittedTimers.current.delete(requestId);
          if (!submittedRef.current.delete(requestId)) return;
          setSubmitted(new Set(submittedRef.current));
        }, SUBMITTED_REQUEST_TIMEOUT_MS);
        submittedTimers.current.set(requestId, timer);
      } else {
        // The problem shows on the page, not under the dialog.
        setReviewing(false);
      }
    } finally {
      answering.current.delete(requestId);
    }
  };

  const click = (action: PluginStatusAction): void => {
    if (action.confirm) setConfirming(action);
    else void run(action.id);
  };

  const actions = status?.actions ?? [];
  // One request at a time. A connector that is working keeps its buttons: it may
  // be offering the way out (Cancel).
  const locked = running !== null;

  return (
    <div className="connector-status">
      <p className="connector-status__line" role="status" ref={lineRef} tabIndex={-1}>
        <span className={`connector-dot connector-dot--${line.tone}`} aria-hidden="true" />
        <span className="sr-only">{line.toneLabel}: </span>
        {line.text}
      </p>

      {current && attention && (
        <Callout
          tone="notice"
          title={attention.summary}
          action={
            <Button size="sm" variant="primary" onClick={() => setReviewing(true)}>
              {t("connectors-request-review")}
            </Button>
          }
        >
          {requests.length > 1 && <p>{t("connectors-request-more", { count: requests.length - 1 })}</p>}
        </Callout>
      )}

      {status?.detail && (
        <p className="connector-status__detail">
          <ConnectorText text={status.detail} />
        </p>
      )}

      {status?.facts && status.facts.length > 0 && (
        <dl className="kv connector-status__facts">
          {status.facts.map((fact) => (
            <div className="kv__row" key={fact.label}>
              <dt>{fact.label}</dt>
              <dd>{fact.value}</dd>
            </div>
          ))}
        </dl>
      )}

      {actions.length > 0 && (
        <div className="connector-status__actions">
          {actions.map((action) => (
            <Button
              key={action.id}
              size="sm"
              {...buttonFor(action)}
              disabled={locked}
              onClick={() => click(action)}
            >
              {action.label}
            </Button>
          ))}
        </div>
      )}

      {failed && (
        <ProblemCallout
          problem={failed.problem}
          onRetry={() => void run(failed.actionId)}
        />
      )}

      <AttentionRequestDialog
        open={reviewing && current !== undefined}
        request={current}
        busy={
          current && running === current.approve.id ? "approve"
          : current && running === current.decline.id ? "decline"
          : null
        }
        onApprove={() => current && void answer(current, "approve")}
        onDecline={() => current && void answer(current, "decline")}
        onDismiss={() => setReviewing(false)}
      />

      <ConfirmDialog
        open={confirming !== null}
        title={t("connectors-confirm-title", { action: confirming?.label ?? "" })}
        body={
          <p className="connector-status__confirm">
            <ConnectorText text={confirming?.confirm ?? ""} />
          </p>
        }
        confirmLabel={confirming?.label}
        cancelLabel={t("common-cancel")}
        tone={confirming?.kind === "destructive" ? "danger" : "default"}
        busy={running !== null}
        onConfirm={async () => {
          if (confirming) await run(confirming.id);
        }}
        onCancel={() => setConfirming(null)}
      />
    </div>
  );
}
