import type { ReactElement, ReactNode } from "react"

import * as AlertDialog from "@radix-ui/react-alert-dialog"

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
 * Reusable confirmation modal, backed by Radix AlertDialog — the correct
 * role for a decision that interrupts and requires an explicit response
 * (focus trap, ESC, `role="alertdialog"`, aria-labelledby/describedby all
 * handled by the primitive, so we no longer hand-roll the imperative
 * `showModal()` juggling the native <dialog> needed).
 *
 * Caller owns `open` + `busy`. ESC and the Cancel button route through
 * `onCancel` (via `onOpenChange`); an overlay click does NOT dismiss (an
 * AlertDialog demands an explicit choice). The confirm button is a plain
 * Button, NOT `AlertDialog.Action`, so it does not auto-close — the caller
 * keeps the dialog open via `busy` while an async `onConfirm` runs and flips
 * `open` itself when done. Cancel is first in DOM order, so it takes initial
 * focus — the safe default for a destructive action.
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
}: ConfirmDialogProps): ReactElement {
  return (
    <AlertDialog.Root
      open={open}
      onOpenChange={(next) => {
        // Fires for ESC and the Cancel button. Ignore while busy so a
        // mid-flight async confirm can't be dismissed out from under itself.
        if (!next && !busy) onCancel()
      }}
    >
      <AlertDialog.Portal>
        <AlertDialog.Overlay className="confirm-dialog__overlay" />
        <AlertDialog.Content className="confirm-dialog">
          <div className="confirm-dialog__panel">
            <AlertDialog.Title className="confirm-dialog__title">
              {title}
            </AlertDialog.Title>
            <AlertDialog.Description asChild>
              <div className="confirm-dialog__body">{body}</div>
            </AlertDialog.Description>
            <div className="confirm-dialog__actions">
              <AlertDialog.Cancel asChild>
                <Button variant="ghost" disabled={busy}>
                  {cancelLabel}
                </Button>
              </AlertDialog.Cancel>
              <Button
                variant={tone === "danger" ? "destructive" : "primary"}
                onClick={() => void onConfirm()}
                disabled={busy}
              >
                {busy ? "Working…" : confirmLabel}
              </Button>
            </div>
          </div>
        </AlertDialog.Content>
      </AlertDialog.Portal>
    </AlertDialog.Root>
  )
}
