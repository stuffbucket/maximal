import { useEffect, useRef, type ReactNode, type RefObject } from "react";

import { cx } from "./cx";
import { isTrailingClickOfOpening } from "./modal-click-guard";

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
  // When showModal() last ran, so the rest of a double click that opened the
  // dialog can't dismiss it or press one of its buttons.
  const openedAtRef = useRef(0);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;

    if (open && !dialog.open) {
      try {
        dialog.showModal();
        openedAtRef.current = performance.now();
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
      onMouseDownCapture={(event) => {
        // The trailing press of the opening double click would otherwise
        // move focus off the safe first action onto the dialog itself.
        if (
          isTrailingClickOfOpening(
            event.detail,
            performance.now() - openedAtRef.current,
          )
        ) {
          event.preventDefault();
          event.stopPropagation();
        }
      }}
      onClickCapture={(event) => {
        if (
          isTrailingClickOfOpening(
            event.detail,
            performance.now() - openedAtRef.current,
          )
        ) {
          event.preventDefault();
          event.stopPropagation();
        }
      }}
      onClick={(event) => {
        if (event.target === dialogRef.current) onDismiss();
      }}
    >
      {children}
    </dialog>
  );
}
