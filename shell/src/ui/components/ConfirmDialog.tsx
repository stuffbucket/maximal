import { type ReactElement, useEffect, useRef, type ReactNode } from "react"

import { Button } from "./Button"

interface ConfirmDialogProps {
  open: boolean
  title: string
  body: ReactNode
  confirmLabel?: string
  cancelLabel?: string
  tone?: "default" | "danger"
  busy?: boolean
  onConfirm: () => void | Promise<void>
  onCancel: () => void
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
}: ConfirmDialogProps): ReactElement | null {
  const dialogRef = useRef<HTMLDialogElement | null>(null)
  const cancelRef = useRef<HTMLButtonElement | null>(null)

  // Sync `open` prop with the imperative <dialog> state. showModal()
  // is what gives us the focus trap + backdrop; close() tears them
  // down. Wrap in try/catch because showModal() throws if the dialog
  // is already open and vice versa — harmless in normal flow but
  // possible under strict-mode double effects.
  useEffect(() => {
    const el = dialogRef.current
    if (!el) return
    if (open && !el.open) {
      try {
        el.showModal()
      } catch {
        /* ignore */
      }
    } else if (!open && el.open) {
      try {
        el.close()
      } catch {
        /* ignore */
      }
    }
  }, [open])

  // Initial focus on Cancel after showModal(). Browsers autofocus the
  // first interactive element otherwise, which would land on Confirm
  // for a destructive dialog — wrong default.
  useEffect(() => {
    if (open) cancelRef.current?.focus()
  }, [open])

  if (!open) return null

  const onCancelGuard = (): void => {
    if (busy) return
    onCancel()
  }

  const onConfirmClick = (): void => {
    void onConfirm()
  }

  // The <dialog>'s built-in close event fires on ESC. Route it through
  // our cancel path so callers don't have to special-case keyboard
  // dismissal. Same for backdrop clicks (event.target === dialog).
  return (
    <dialog
      ref={dialogRef}
      className="confirm-dialog"
      onClose={onCancelGuard}
      onCancel={(e) => {
        e.preventDefault()
        onCancelGuard()
      }}
      onClick={(e) => {
        if (e.target === dialogRef.current) onCancelGuard()
      }}
    >
      <div className="confirm-dialog__panel">
        <h2 className="confirm-dialog__title">{title}</h2>
        <div className="confirm-dialog__body">{body}</div>
        <div className="confirm-dialog__actions">
          <Button
            ref={cancelRef}
            variant="ghost"
            onClick={onCancelGuard}
            disabled={busy}
          >
            {cancelLabel}
          </Button>
          <Button
            variant={tone === "danger" ? "destructive" : "primary"}
            onClick={onConfirmClick}
            disabled={busy}
          >
            {busy ? "Working…" : confirmLabel}
          </Button>
        </div>
      </div>
    </dialog>
  )
}
