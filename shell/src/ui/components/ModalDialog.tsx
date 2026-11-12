import { useEffect, useRef, type ReactNode, type RefObject } from "react";

import { cx } from "./cx";

interface ModalDialogProps {
  open: boolean;
  children: ReactNode;
  className?: string;
  id?: string;
  ariaLabel?: string;
  ariaLabelledBy?: string;
  /** Optional safe or contextual first focus target after showModal(). */
  initialFocusRef?: RefObject<HTMLElement>;
  onDismiss: () => void;
}

/**
 * Native modal shell shared by small confirmations and large detail views.
 * The browser owns top-layer stacking, inertness, focus containment, and
 * opener focus restoration; callers own the content and open state.
 */
export function ModalDialog({
  open,
  children,
  className,
  id,
  ariaLabel,
  ariaLabelledBy,
  initialFocusRef,
  onDismiss,
}: ModalDialogProps): JSX.Element {
  const dialogRef = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;

    if (open && !dialog.open) {
      try {
        dialog.showModal();
        initialFocusRef?.current?.focus();
      } catch {
        // Strict mode can replay this effect after the dialog is already open.
      }
    } else if (!open && dialog.open) {
      dialog.close();
    }
  }, [initialFocusRef, open]);

  return (
    <dialog
      ref={dialogRef}
      id={id}
      className={cx("modal-dialog", className)}
      aria-label={ariaLabel}
      aria-labelledby={ariaLabelledBy}
      onCancel={(event) => {
        event.preventDefault();
        event.stopPropagation();
        onDismiss();
      }}
      onClick={(event) => {
        if (event.target === dialogRef.current) onDismiss();
      }}
    >
      {children}
    </dialog>
  );
}
