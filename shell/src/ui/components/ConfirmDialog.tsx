import { useId, useRef, type ReactNode } from "react";

import { ModalDialog } from "./ModalDialog";

interface ConfirmDialogProps {
  open: boolean;
  title: string;
  body: ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  tone?: "default" | "danger";
  busy?: boolean;
  onConfirm: () => void | Promise<void>;
  onCancel: () => void;
}

/**
 * Reusable confirmation modal. Uses the native <dialog> element so we
 * get the top-layer stack, focus trap, and ESC handling for free.
 *
 * Caller owns `open` + `busy`. ESC and backdrop click route through
 * `onCancel`. Initial focus lands on Cancel — the safe default for any
 * destructive action.
 */
export function ConfirmDialog({
  open,
  title,
  body,
  confirmLabel = "Confirm",
  cancelLabel = "Cancel",
  tone = "default",
  busy = false,
  onConfirm,
  onCancel,
}: ConfirmDialogProps): JSX.Element {
  const cancelRef = useRef<HTMLButtonElement>(null);
  const titleId = useId();

  const onCancelGuard = (): void => {
    if (busy) return;
    onCancel();
  };

  const onConfirmClick = (): void => {
    void onConfirm();
  };

  return (
    <ModalDialog
      open={open}
      className="confirm-dialog"
      ariaLabelledBy={titleId}
      initialFocusRef={cancelRef}
      onDismiss={onCancelGuard}
    >
      {open ? (
        <div className="confirm-dialog__panel">
          <h2 className="confirm-dialog__title" id={titleId}>
            {title}
          </h2>
          <div className="confirm-dialog__body">{body}</div>
          <div className="confirm-dialog__actions">
            <button
              ref={cancelRef}
              type="button"
              className="btn btn--ghost"
              onClick={onCancelGuard}
              disabled={busy}
            >
              {cancelLabel}
            </button>
            <button
              type="button"
              className={
                tone === "danger" ? "btn btn--destructive" : "btn btn--primary"
              }
              onClick={onConfirmClick}
              disabled={busy}
            >
              {busy ? "Working…" : confirmLabel}
            </button>
          </div>
        </div>
      ) : null}
    </ModalDialog>
  );
}
