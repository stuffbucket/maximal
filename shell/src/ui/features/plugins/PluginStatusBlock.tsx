import { useState } from "react";

import { t } from "../../../i18n";
import type { PluginStatus, PluginStatusAction } from "../../../proxy/client";
import { Button } from "../../components/Button";
import { ConfirmDialog } from "../../components/ConfirmDialog";
import { ProblemCallout } from "../../components/ProblemCallout";
import type { Problem } from "../../problems";

import type { PluginLine } from "./plugin-state";
import { PluginText } from "./PluginText";
import type { PluginMutationResult } from "./usePlugins";

interface PluginStatusBlockProps {
  line: PluginLine;
  /** The plugin's own report; absent while it is still starting. */
  status?: PluginStatus;
  onAction: (actionId: string) => Promise<PluginMutationResult>;
}

/** The plugin asks for a kind of button; the design system supplies it.
 *  Destructive is the quiet one (a ghost that reads red, components.md →
 *  Buttons): it opens the plugin's confirmation, and the dialog's own button
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
 * What the plugin says about itself, always in view: the one-line state, its
 * detail, any facts (account, tenant…), and the buttons for what to do next.
 * Every word of `status` is the plugin's English and is shown as written. An
 * action with `confirm` asks first, in a dialog that repeats the plugin's text.
 */
export function PluginStatusBlock({ line, status, onAction }: PluginStatusBlockProps): JSX.Element {
  const [confirming, setConfirming] = useState<PluginStatusAction | null>(null);
  // The action whose request is in flight (the plugin answers at once; the
  // outcome arrives as a status change).
  const [running, setRunning] = useState<string | null>(null);
  const [failed, setFailed] = useState<{ problem: Problem; actionId: string } | null>(null);

  const run = async (actionId: string): Promise<void> => {
    setRunning(actionId);
    setFailed(null);
    const result = await onAction(actionId);
    setRunning(null);
    setConfirming(null);
    if (!result.ok && result.problem) setFailed({ problem: result.problem, actionId });
  };

  const click = (action: PluginStatusAction): void => {
    if (action.confirm) setConfirming(action);
    else void run(action.id);
  };

  const actions = status?.actions ?? [];
  // One request at a time. A plugin that is working keeps its buttons: it may
  // be offering the way out (Cancel).
  const locked = running !== null;

  return (
    <div className="plugin-status">
      <p className="plugin-status__line" role="status">
        <span className={`plugin-dot plugin-dot--${line.tone}`} aria-hidden="true" />
        <span className="sr-only">{line.toneLabel}: </span>
        {line.text}
      </p>

      {status?.detail && (
        <p className="plugin-status__detail">
          <PluginText text={status.detail} />
        </p>
      )}

      {status?.facts && status.facts.length > 0 && (
        <dl className="kv plugin-status__facts">
          {status.facts.map((fact) => (
            <div className="kv__row" key={fact.label}>
              <dt>{fact.label}</dt>
              <dd>{fact.value}</dd>
            </div>
          ))}
        </dl>
      )}

      {actions.length > 0 && (
        <div className="plugin-status__actions">
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

      <ConfirmDialog
        open={confirming !== null}
        title={t("plugins-confirm-title", { action: confirming?.label ?? "" })}
        body={
          <p className="plugin-status__confirm">
            <PluginText text={confirming?.confirm ?? ""} />
          </p>
        }
        confirmLabel={confirming?.label}
        cancelLabel={t("common-cancel")}
        tone={confirming?.kind === "destructive" ? "danger" : "default"}
        busy={running !== null}
        onConfirm={() => (confirming ? run(confirming.id) : undefined)}
        onCancel={() => setConfirming(null)}
      />
    </div>
  );
}
