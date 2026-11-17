import { useEffect, useId, useRef } from "react";

import { t } from "../../../i18n";
import type { PluginAttentionRequest } from "../../../proxy/client";
import { ModalDialog } from "../../components/ModalDialog";

import { ConnectorText } from "./ConnectorText";

interface AttentionRequestDialogProps {
  open: boolean;
  /** The one request being asked; the dialog is closed without one. */
  request: PluginAttentionRequest | undefined;
  /** Which answer is in flight; every button waits while one is. */
  busy: "approve" | "decline" | null;
  onApprove: () => void;
  onDecline: () => void;
  /** Not now: Escape, the backdrop and the button. Leaves the request waiting. */
  onDismiss: () => void;
}

/**
 * A plugin's yes-or-no question (`status.attention.requests`), asked in a
 * native modal over the connector's page: what is asking, what approving
 * allows, and three ways out. Approve lets it through; Deny refuses it for
 * good (an unexpected, stale or wrong-profile request); Not now closes the
 * dialog and leaves it waiting. Escape and a backdrop click are Not now, never
 * an answer, and are ignored while an answer is being sent. Initial focus lands
 * on Not now: approving hands something control, so it is never the default.
 * The dialog has no form, so nothing is dirty and there is nothing to discard.
 */
export function AttentionRequestDialog({
  open,
  request,
  busy,
  onApprove,
  onDecline,
  onDismiss,
}: AttentionRequestDialogProps): JSX.Element {
  const laterRef = useRef<HTMLButtonElement>(null);
  const titleId = useId();
  const working = busy !== null;

  // The next question takes over the same dialog; the button just pressed is
  // disabled by then, so put focus back on the safe one.
  const requestId = request?.approve.id;
  useEffect(() => {
    if (open && requestId !== undefined) laterRef.current?.focus();
  }, [open, requestId]);

  const dismiss = (): void => {
    if (!working) onDismiss();
  };

  return (
    <ModalDialog
      open={open}
      className="confirm-dialog attention-dialog"
      ariaLabelledBy={titleId}
      initialFocusRef={laterRef}
      onDismiss={dismiss}
    >
      {open && request ? (
        <div className="confirm-dialog__panel">
          <h2 className="confirm-dialog__title" id={titleId}>
            {request.title}
          </h2>
          <div className="confirm-dialog__body">
            <p className="attention-dialog__detail">
              <ConnectorText text={request.detail} />
            </p>
            {request.facts && request.facts.length > 0 && (
              <dl className="kv attention-dialog__facts">
                {request.facts.map((fact) => (
                  <div className="kv__row" key={fact.label}>
                    <dt>{fact.label}</dt>
                    <dd>{fact.value}</dd>
                  </div>
                ))}
              </dl>
            )}
            <p className="attention-dialog__hint">{t("connectors-request-later-hint")}</p>
          </div>
          <div className="confirm-dialog__actions">
            <button
              ref={laterRef}
              type="button"
              className="btn btn--ghost"
              onClick={dismiss}
              disabled={working}
            >
              {t("connectors-request-later")}
            </button>
            <button type="button" className="btn btn--secondary" onClick={onDecline} disabled={working}>
              {busy === "decline" ? t("common-working") : request.decline.label}
            </button>
            <button type="button" className="btn btn--primary" onClick={onApprove} disabled={working}>
              {busy === "approve" ? t("common-working") : request.approve.label}
            </button>
          </div>
        </div>
      ) : null}
    </ModalDialog>
  );
}
