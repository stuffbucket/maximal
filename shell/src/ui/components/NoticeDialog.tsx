import { useId, useRef, type ReactNode } from "react";

import { ModalDialog } from "./ModalDialog";

interface NoticeDialogProps {
  open: boolean;
  title: string;
  children: ReactNode;
  /** The one action, e.g. "Got it". */
  actionLabel: string;
  onDismiss: () => void;
}

/**
 * An informational modal: something already happened and the person should
 * know what to do next. One action acknowledges it; Escape and the backdrop
 * do the same. Not a confirmation — nothing waits on the answer, so there is
 * no Cancel. Shares ConfirmDialog's shell and type.
 */
export function NoticeDialog({
  open,
  title,
  children,
  actionLabel,
  onDismiss,
}: NoticeDialogProps): JSX.Element {
  const actionRef = useRef<HTMLButtonElement>(null);
  const titleId = useId();

  return (
    <ModalDialog
      open={open}
      className="confirm-dialog"
      ariaLabelledBy={titleId}
      initialFocusRef={actionRef}
      onDismiss={onDismiss}
    >
      {open ? (
        <div className="confirm-dialog__panel">
          <h2 className="confirm-dialog__title" id={titleId}>
            {title}
          </h2>
          <div className="confirm-dialog__body">{children}</div>
          <div className="confirm-dialog__actions">
            <button
              ref={actionRef}
              type="button"
              className="btn btn--primary"
              onClick={onDismiss}
            >
              {actionLabel}
            </button>
          </div>
        </div>
      ) : null}
    </ModalDialog>
  );
}
