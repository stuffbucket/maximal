import { useId, useRef, type ReactNode } from "react";

import { t } from "../../i18n";

import { ModalDialog } from "./ModalDialog";

interface NoticeSecondaryAction {
  label: string;
  /** Reads red: the action changes something the person set up. */
  tone?: "default" | "danger";
  onAction: () => void | Promise<void>;
}

interface NoticeDialogProps {
  open: boolean;
  title: string;
  children: ReactNode;
  /** The one acknowledging action, e.g. "Got it" or "Close". */
  actionLabel: string;
  onDismiss: () => void;
  /** An optional explicit alternative, never the default: it sits before
   *  the primary action, never takes first focus, and Escape, the backdrop
   *  and Enter on the focused primary never trigger it. */
  secondaryAction?: NoticeSecondaryAction;
  /** The secondary action is running: both buttons and dismissal wait. */
  busy?: boolean;
}

/**
 * An informational modal: something already happened and the person should
 * know what to do next. One action acknowledges it; Escape and the backdrop
 * do the same. Not a confirmation — nothing waits on the answer, so there is
 * no Cancel. A secondary action may offer an explicit way past what
 * happened (e.g. "Take over"). Shares ConfirmDialog's shell and type.
 */
export function NoticeDialog({
  open,
  title,
  children,
  actionLabel,
  onDismiss,
  secondaryAction,
  busy = false,
}: NoticeDialogProps): JSX.Element {
  const actionRef = useRef<HTMLButtonElement>(null);
  const titleId = useId();

  const dismiss = (): void => {
    if (busy) return;
    onDismiss();
  };

  return (
    <ModalDialog
      open={open}
      className="confirm-dialog"
      ariaLabelledBy={titleId}
      initialFocusRef={actionRef}
      onDismiss={dismiss}
    >
      {open ? (
        <div className="confirm-dialog__panel">
          <h2 className="confirm-dialog__title" id={titleId}>
            {title}
          </h2>
          <div className="confirm-dialog__body">{children}</div>
          <div className="confirm-dialog__actions">
            {secondaryAction && (
              <button
                type="button"
                className={
                  secondaryAction.tone === "danger"
                    ? "btn btn--ghost btn--ghost-destructive"
                    : "btn btn--ghost"
                }
                onClick={() => void secondaryAction.onAction()}
                disabled={busy}
              >
                {busy ? t("common-working") : secondaryAction.label}
              </button>
            )}
            <button
              ref={actionRef}
              type="button"
              className="btn btn--primary"
              onClick={dismiss}
              disabled={busy}
            >
              {actionLabel}
            </button>
          </div>
        </div>
      ) : null}
    </ModalDialog>
  );
}
